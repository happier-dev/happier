# Demo session screenshot inventory

Real screenshots captured from the live Happier app showing **11 rich,
real-titled coding sessions** across **3 providers** (Claude / Codex /
OpenCode) and **4 fake-but-real-looking projects**:

- **patio** — Next.js 15 dashboard for cafe seating
- **atlas** — Hono backend events / auth API
- **prism** — TypeScript CLI (deploy / log-tail helper)
- **lantern** — Expo / React Native messaging app

## How sessions were created (the right way)

Used `hdev session create --backend <claude|codex|opencode> --path <project> --title <…> --prompt <…> --json`. This is the correct path — earlier `hdev <provider> -p` and `hdev opencode run` paths register sessions but don't publish transcripts to the relay. Document this for future runs.

## Session inventory (11 rich)

| Session | Provider | Project | Title | Messages | Notes |
|---|---|---|---|---|---|
| `cmoh1c7uq00pwtm35b8rsj6em` | claude | patio | Add settings page for table count, cutoff, and section goals | 26 | Multi-file feature, 339 inserts |
| `cmoh1gmhq00x6tm358kaxy2bo` | claude | atlas | **Add rate limiting to /api/login** | rich | Has the mental-test request table |
| `cmoh1ig9m0100tm35t16av59w` | claude | atlas | Persist failed login attempts | rich | Continuation of rate-limiting |
| `cmoh1l4pj015gtm350bpxvfm8` | claude | atlas | Standardize API response envelope | rich | Multi-file refactor |
| `cmoh1qo3i01d0tm35srlzdn3z` | claude | prism | Add --quiet flag + new logs subcommand | rich | Help-output before/after |
| `cmoh1vgar01iktm355n95rjkr` | claude | lantern | Polish composer: keyboard, haptics, sending state | rich | RN polish trio |
| `cmoh2yv8101n6tm35pzqq7hcy` | **codex** | atlas | Audit Request ID Logging | 22 | First Codex session via session-create |
| `cmoh31lnc01qutm35v51jmito` | **opencode** | patio | Add TonightSummaryCard | live (perm required) | Permission card on the phone |
| `cmoh323dy01rktm35i5f9lx0n` | **codex** | lantern | Message Long-Press Menu | 89 | Massive transcript |
| `cmoh32fd201sstm35zf9akl0r` | **opencode** | prism | Add telemetry module | live (perm required) | Permission card visible |
| `cmoh32gb901t4tm35iyzs6jaj` | **codex** | atlas | Extend Events API Filters | 100 | Largest transcript — 100 messages |
| `cmoh32h2101tctm35cu8ftbbp` | claude | lantern | Add expo-notifications with mute-aware handler | live (perm required) | Permission card with 5 buttons (Yes / Yes-allow-tool / Yes-allow-cmd / No / Stop) |

## Capture geometry

| Variant | Viewport | DPR |
|---|---|---|
| `desktop-*.png` | 1600×1000 | 2× |
| `phone-*.png`   | 393×852   | 3× |

`-mid.png` files are mid-scroll captures showing tool-call cards inline.

## Money shots for the marketing demo

| Marketing beat | Asset |
|---|---|
| **Session list / inbox (desktop)** | `desktop-session-list.png` — active group with 3 "permission required" + 3 "online", inactive group below |
| **Session list / inbox (phone)** | `phone-session-list.png` — same content at iPhone size |
| **Phone hero permission card** | `phone-permission-card-claude.png` — Claude lantern session, 5-button Allow row |
| **Phone permission card (OpenCode variant)** | `phone-permission-card-opencode.png` — Todo List permission |
| **Desktop permission card** | `desktop-permission-card-claude.png`, `desktop-permission-card-opencode.png` |
| **Codex backend in action** | `desktop-codex-request-id.png`, `desktop-atlas-events-filters-codex-mid.png` — Terminal commands + Update file calls |
| **OpenCode backend in action** | `desktop-prism-telemetry-opencode.png`, `desktop-patio-tonight-card-opencode.png` |
| **Claude rich transcript** | `desktop-patio-settings.png` — 20 tool calls + file-by-file recap |
| **Multi-task transcript** | `desktop-lantern-composer-polish.png` — 3-task RN polish |
| **Reasoning table screenshot** | `desktop-atlas-rate-limiting-mid.png`, `phone-atlas-rate-limiting-mid.png` |

## Notes on permission-card sessions

The opencode and Claude sessions for `Add TonightSummaryCard`, `Add telemetry module`, and `Add expo-notifications with mute-aware handler` are still **live and waiting on permission approval** when the screenshots were captured. This is the perfect state for the hero scene — the session is paused mid-flight, asking the user "can I run `ls`?" with a real Happier permission card showing 4–5 action buttons. Don't approve them on the relay; let them sit so we can re-screenshot if we need new variants.

## Project source state

Each project at `~/Documents/Development/happier-demo-projects/<name>/` has:
- 1 initial scaffold commit + 1–3 feature commits from the Claude sessions
- Real, plausible code (no `test`/`demo`/`fake`/`sample`/`example` tokens)
- Clean working tree on `main`

The Codex and OpenCode sessions reasoned about the projects but didn't always commit (some completed without write access in their sandbox configuration). The transcripts are still rich — the goal here was screenshot material, not mergeable diffs.
