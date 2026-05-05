# @happier-dev/website-v2

A ground-up rebuild of the marketing website. Designed around a single
thesis visible in the hero: **one session, every device** — rendered as
a live two-device demo with sync cinematography rather than a static
screenshot.

## Run it

```sh
cd apps/website-v2
yarn install          # workspace install from repo root also works
yarn dev              # http://localhost:3001
yarn build            # production build to ./dist
yarn typecheck
```

## What's in here (and why)

```
src/
├── theme/
│   ├── tokens.ts            ← mirrors apps/ui/sources/theme.ts
│   └── copy.ts              ← real copy strings from en.ts + app UI
├── styles/global.css        ← Tailwind + grain overlay + reduced motion
├── demo/
│   ├── scenarios/
│   │   ├── types.ts         ← Beat / DemoState / Scenario types
│   │   └── handoff.ts       ← Scenario 1 script, beat-by-beat
│   ├── useTimeline.ts       ← rAF-driven playback engine
│   ├── MockSessionProvider  ← context that scripts product state
│   ├── frames/
│   │   ├── PhoneFrame       ← iPhone chrome + focus treatment
│   │   ├── MacWindowFrame   ← macOS window chrome
│   │   ├── TerminalFrame    ← Claude-TUI body renderer
│   │   └── SyncIndicator    ← the live "synced" dot+line
│   ├── ui/                  ← in-device UI (visual twins of app)
│   │   ├── PhoneSessionScreen
│   │   ├── SessionHeader
│   │   ├── MessageList
│   │   ├── MessageComposer
│   │   ├── PermissionCard   ← same shape as apps/ui PermissionPromptCard
│   │   ├── PhoneStatusBar
│   │   └── ActivityChip
│   └── DeviceStage          ← the two-device stage composition
└── sections/                ← page composition
    ├── Nav
    ├── Hero                 ← headline + CTAs + DeviceStage
    ├── ProviderStrip
    ├── Pillar               ← shared layout for the three pillars
    ├── DirectSessionsPillar ← uses real "Browse provider sessions" copy
    ├── VoicePillar
    ├── ParallelPillar
    ├── SelfHostSecurity     ← merged self-host + security
    ├── GetStarted
    └── Footer
```

## Design rules

Everything here reflects decisions from the design thread. If you are
editing the site, do not break these without a discussion:

### 1. Reuse real app tokens and copy — never invent

- **Colors, spacing, radius, shadows** come from `theme/tokens.ts`,
  which mirrors `apps/ui/sources/theme.ts`. No other palette.
- **Strings** live in `theme/copy.ts`, sourced from the app's
  real `en.ts` and visible UI. If you need new copy, add it to the
  app first (or confirm it already exists there) before putting it here.
- **Feature claims** match real capabilities: session continuity,
  Direct sessions (takeover of externally-started sessions), voice with
  cross-session context, parallel sessions with one inbox, end-to-end
  encryption, self-hosting. No cross-provider forking — that does not
  exist and must not be implied anywhere.

### 2. Scale / opacity / blur vocabulary

Focus states for the two-device stage (`PhoneFrame` / `MacWindowFrame`):

| State         | Scale | Opacity | Blur   | RotateY   |
|---------------|-------|---------|--------|-----------|
| Active        | 1.00  | 1.00    | 0      | 0°        |
| Equal (sync)  | 0.96  | 1.00    | 0      | ±1°       |
| Inactive      | 0.92  | 0.72-0.80 | 1.5px | ±5°     |

`0.96` in this file is a **spatial-focus vocabulary**, not to be confused
with the **press-feedback** `0.96` elsewhere — the `.press` utility in
`global.css`. They never apply to the same element.

Every transition specifies explicit properties. Never `transition: all`.

### 3. Cinematography

- Both devices are always on screen during the hero demo. Focus shifts
  via scale/opacity/blur; neither device disappears.
- Simultaneous pulse on the permission beat (terminal + phone pulse in
  the same frame) — this is *the* signature animation. Don't weaken it.
- Sync indicator has a constant heartbeat; extra pulse on meaningful
  events via `syncPulseKey` in the scenario script.
- Activity chip ("typing on iPhone", "Claude is writing") appears only
  briefly — it's context, not a permanent badge.

### 4. Polish non-negotiables

From `make-interfaces-feel-better`:

- Tabular numbers (`.tnum` / `font-variant-numeric: tabular-nums`) on
  every counter that ticks (message count, token rate, timers).
- `-webkit-font-smoothing: antialiased` applied in global.css.
- `text-wrap: balance` on all headings; `pretty` on body paragraphs.
- Image outlines use `rgba(255,255,255,0.1)` — never a tinted neutral.
- Concentric radii: phone rim 56 → screen 48; cards 14 → inputs 10.
- Press feedback `.press { scale(0.96) }` on buttons.
- `prefers-reduced-motion` respected via global CSS override.

## Real-component reuse roadmap

Long-term intent: render the actual components from `apps/ui` inside
the device frames, so when the app evolves the marketing site updates
automatically. Two blockers today make that a phase-2 build:

1. **Unistyles web setup.** `apps/ui` uses
   `react-native-unistyles@3.x`, which works on web but requires the
   Babel plugin and some additional wiring. This site uses plain
   Tailwind + vanilla React for now.
2. **Deep-context dependencies.** Components like
   `DirectSessionsBrowseScreen` and `TranscriptList` expect the full
   sync store, machine state, router, and modal system from the app.
   Rendering them standalone requires extracting context from providers
   or adding mock-friendly props.

The bridge: the in-device components here (`demo/ui/*`) are
**visual twins** that use the same theme tokens, spacing scale, and copy
strings as the real components. Their interfaces match the shape of the
real app's data (`AgentMessage`, `PermissionRequest`, `TerminalLine`
in `scenarios/types.ts`). When we decouple a real component, it can
drop in where the twin sits today without other changes.

Recommended next steps (in order):

1. Wire `react-native-web` + Unistyles' web Babel plugin into this Vite
   config, so the tooling accepts imports from `apps/ui`.
2. Extract `PermissionPromptCard` into a prop-driven variant (or mock
   the `useSetting()` / `buildPermissionPromptModel` deps) and swap it
   for `demo/ui/PermissionCard.tsx`.
3. Do the same for `TranscriptList` → `demo/ui/MessageList.tsx`.
4. For screens like `DirectSessionsBrowseScreen`, extract the list-item
   renderer as a standalone component — that's the only piece the
   marketing site actually needs.

## Scenario playback

`useTimeline` runs a `requestAnimationFrame` loop, maps the elapsed
time (mod total duration) to the active beat, and returns the scripted
`DemoState` + `focus`. Any component can call `useMockSession()` to
read the current state. Components render from state — they do not
know they are being scripted.

Scenario 1 (the handoff) is implemented. Scenarios 2–4 (Direct sessions
beat-driven, Voice beat-driven, Parallel beat-driven) are scaffolded as
static pillar visuals today and should graduate to timeline-driven
pieces as follow-up work, re-using the same `Scenario` shape in
`scenarios/types.ts`.

## Deploy

Vite default: `yarn build` produces `dist/` ready for any static host.
Don't delete `apps/website` while this is in development — it remains
the production site until `website-v2` is ready to swap in.
