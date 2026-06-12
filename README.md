# Gate Supabase Control

Новый отдельный проект управления двумя воротами через GitHub Pages + Supabase + два ESP8266 D1 mini.

Рабочий репозиторий `gate-control` не используется и не изменяется.

## Схема

```text
GitHub Pages frontend
  -> Supabase Auth + RPC
  -> tables gates/logs
  <- ESP8266 gate1 / gate2 poll commands and ack
```

## Что умеет

- Две карточки ворот: `gate1` и `gate2`.
- Команды `OPEN` и `CLOSE`.
- Ожидание подтверждения от ESP до 10 секунд.
- Статус онлайн/офлайн по `last_seen`.
- Журнал команд.
- Без датчиков положения: интерфейс подтверждает только выполнение импульса реле устройством.

## Управление с телефона

После публикации на GitHub Pages открой ссылку сайта на телефоне, войди по Supabase Auth и нажимай `Открыть` / `Закрыть` в нужной карточке ворот.

`На связи` означает, что ESP недавно отправляла heartbeat. Без герконов сайт не показывает физическое положение створок, а подтверждает только принятую команду и импульс реле.

## Настройка Supabase

1. Создай новый Supabase project.
2. Открой SQL Editor.
3. Выполни `supabase.sql`.
4. Включи Email Auth или создай пользователя вручную в Authentication.
5. Скопируй URL и anon key.
6. Скопируй `config.example.js` в `config.js`.
7. Заполни `SUPABASE_URL` и `SUPABASE_ANON_KEY`.

`config.js` добавлен в `.gitignore`; реальные ключи не коммитить.

## Локальная проверка сайта

```powershell
cd D:\codex\ESP\gate-supabase-control
python -m http.server 8080
```

Открыть:

```text
http://127.0.0.1:8080
```

## ESP8266

Прошивка лежит отдельно:

```text
D:\codex\ESP\esp8266_gate_supabase
```

Для `gate1` и `gate2` используется одна прошивка, отличается только `DEVICE_ID` в локальном конфиге.

## Подключение реле

По умолчанию в `config.example.h`:

```text
D1 / GPIO5 -> OPEN relay
D2 / GPIO4 -> CLOSE relay
GND ESP -> GND relay board
5V/VCC relay board -> питание реле по требованиям модуля
```

Логика безопасная:

- при старте оба реле выключаются;
- перед импульсом сначала выключаются оба реле;
- одновременно `OPEN` и `CLOSE` не включаются;
- импульс по умолчанию `500 ms`;
- без герконов сайт не показывает физическое положение ворот.

## Сборка прошивки

```powershell
cd D:\codex\ESP
python -m platformio run -d esp8266_gate_supabase
```

Перед прошивкой:

1. Скопируй `esp8266_gate_supabase/src/config.example.h` в `esp8266_gate_supabase/src/config.local.h`.
2. Для первой платы поставь `DEVICE_ID "gate1"` и свой `DEVICE_TOKEN`.
3. Для второй платы поставь `DEVICE_ID "gate2"` и другой `DEVICE_TOKEN`.
4. Укажи `SUPABASE_URL` и `SUPABASE_ANON_KEY`.

Первичная настройка Wi-Fi:

- после прошивки ESP поднимет точку `GateSetup-gate1` или `GateSetup-gate2`;
- подключись телефоном;
- выбери домашний Wi-Fi;
- после подключения ESP начнет читать команды из Supabase.
