# Instrument kit

Premium usage/context instrumentation primitives (L4 of the 2026-07-09 usage &
context program). Consumed by the session instrument strip (L5) and the usage
dashboard journey (L6).

## Design language — "instruments, not dashboards"

Near-monochrome canvas from the existing theme; ONE signature accent that shifts
hue with meaning (calm teal `text.link` → warning → danger as fill rises —
always theme tokens, never raw hex); oversized tabular-numeral display numbers
with small uppercase letter-spaced labels; hairline strokes
(`StyleSheet.hairlineWidth`); depth via soft shadow/highlight, not borders;
generous negative space. Dark mode is the hero — verify both themes.

## Motion grammar (binding)

- **One spring family** — `INSTRUMENT_SPRINGS.standard` (damping 22, stiffness
  180, mass 1) and `.snappy` (damping 26, stiffness 320). Defined once in
  `motion/motionTokens.ts`; imported everywhere; never hand-rolled.
- **Entrances play ONCE per mount**, 300–450ms (`INSTRUMENT_DURATIONS`).
- **No looping/idle animation** except the streaming shimmer, which pauses when
  not streaming and when the app is inactive (`LiquidFill` frame callback).
- **Stagger** 40–60ms per step, capped at 8 items (`INSTRUMENT_STAGGER`,
  `staggerDelayForIndex`, `RippleGrid`).
- **Every per-frame value lives in a Reanimated shared value** (UI thread) —
  never React state.

## The one rule: no component reads settings directly

Instrument components get their motion budget EXCLUSIVELY from
`motion/useMotionPreferences.ts` (`{ level, springs, entrance, effectsEnabled,
animatedNumbersEnabled, hapticsEnabled, reduceMotion, contextGaugeStyle }`).
The raw settings (`visualEffectsLevel`, `animatedNumbers`, `contextGaugeStyle`
in the account settings registry) and the OS reduce-motion flag are resolved in
that one chokepoint; OS reduce-motion always forces `minimal`. Haptics go
through `motion/haptics.ts` (no-ops on web / when the resolved budget disables
them).

## Tiers

Skia (`@shopify/react-native-skia`, installed) powers tier-1 visuals — the
`LiquidFill` gauge shader and `DrawnLinePath` path-trim — on NATIVE at `full`
effects level only. Web and `subtle`/`minimal` always use the tier-2
implementations (SVG ring sweep, opacity fades); `*.web.tsx` variants keep Skia
out of the web bundle.

## Naming note

`InstrumentCard.tsx` is the instrument CARD surface (renamed from GlassSurface per R-L4) (opaque themed card,
hairline border, soft shadow, optional specular highlight). It is deliberately
distinct from `components/ui/glass/GlassSurface.tsx`, the translucent
blur/liquid-glass CHROME material behind tab bars — different bounded contexts.
