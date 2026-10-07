# States, stability and motion

## Every surface has these states

Decide each before building: first load, populated, refreshing, empty, partial, offline or
unreachable scope, error with recovery, permission missing, and success. Loading and error of a whole
surface use `SurfaceStateCard` (sized by its container: pane, details, page, phone); empty uses `EmptyState`;
inside a list a section's state is `SurfaceStateCard size="line"` (the section title stays); stale content keeps
its rows at full strength under one `SurfaceFreshnessLine`.

## Empty is designed, not left over

- Anatomy (`EmptyState layout="page"`): a calm mark with no tile — a Daybreak scene when the
  container is about 220 px or more, otherwise the glyph — a short title ("No Teams yet"), one plain
  sentence saying what would be here and why it is worth having, and one primary action. Same
  spacing on every page; the state sits in the content column, not in a card.
- In a list, a rail or a sheet it is one quiet line on the rows' edge (`layout="line"`); never a
  second full state beside a detail that already shows one.
- **Controls whose target set is empty are hidden**, not disabled: no "Show archived" when nothing
  is archived, no "Select all" with no rows, no filter over an empty list. A set that could not be
  read is not known to be empty, so its control stays and opening it says what failed.
- **A denied action says why and who can.** When the viewer cannot do the page's main action (create
  a Team on a Home where only administrators can), the action's place says so and names who can
  ("Only administrators of Studio can create Teams. Ask one to create a Team or add you to one."),
  instead of silently omitting the action.

## Stability: nothing moves on arrival

A page that "jiggles" when it opens is broken, not unpolished.

- **Reserve known space.** If a row will exist (the account is encrypted, a recovery key applies),
  render it immediately with a skeleton or last-known value; do not insert it later above other rows.
- **Last-known over empty.** Refresh in place from the cached/persisted projection; never flash an
  empty or loading state for data that was already hydrated.
- **Parallel, not serial.** Independent reads start together. A page never waits on a request whose
  result it does not render.
- **Scope-dependent parts wait alone.** A machine RPC delays only the machine section, never the
  account-level settings around it.
- **Containers keep their size.** Modals, panes and sheets do not resize with their content (search
  results, tabs, async rows). Fix it at the shell owner.
- State facts both ways so they never appear or vanish ("End-to-end encrypted" / "Not end-to-end
  encrypted"); a loading fact keeps its line.
- Reads that only some operations need are resolved lazily inside the owner (resolve once, on
  first use, fail that operation closed), so pages that never need them don't wait.
- When a page shifts, diagnose before patching: list its requests, their owners, caching and
  latency, and find avoidable server work. Measure before and after.
- Measure timing on a production build before optimising. The dev bundler adds costs users never
  see (lazy dev bundles of multi-megabyte modules); fix those only as dev ergonomics, and say so.

## Status and banners

- Healthy is quiet. A tinted banner appears only when something blocks use, above the content it
  blocks, with the next action inside it ("This machine is offline · Retry").
- Offline scope: show the last known state, disable operations with the reason, keep navigation.
- Errors name what failed and what to do. "Operation failed" is a bug report, not an error message.

## Focus

- On open, focus lands on the most useful field (settings: search), never on a structural element
  such as a resize handle. Source order matches visual and keyboard order.
- Focus rings use `border.focus` and appear for keyboard use only (`:focus-visible` on web, decided by
  `isHappierFocusVisible` and applied by `HappierPressable`; `theme.css` drops the browser's own ring
  for pointer focus); a mouse press never leaves a ring. Containers (popovers, sheets) never paint a
  focus outline around themselves.

## Motion

Doctrine: `DESIGN.md` → "Motion". Mechanics:

- Durations and easing from `motionTokens`; honour reduced motion everywhere (motion collapses to an
  instant change, not a slower one).
- High-frequency actions (toggles, selection, tabs) respond instantly; the thumb or fill moves, the
  layout does not.
- Disclosures animate height and opacity together; content never pops in after the container. Once
  open, the body follows its content (content that grows after opening is never clipped), and the
  row's chevron shows the open state.
- A sliding selection indicator (segmented) follows the choice; do not cross-fade between separate
  highlights.
- Pulse or highlight to answer "where did it go?" (search reveal), once or twice, then stop.
- No indefinite decorative animation on routine surfaces.

## Motion roles

Every surface reads its motion from the role in the motion owner; no local durations.
Hover changes colour only. Press scales controls slightly. Popovers and menus grow from their
trigger and leave faster than they arrive; dialogs fade and scale a little; phone sheets follow the
finger. The Daybreak moments (rise, ring, dawn) are one-shots driven by facts. Under reduced motion
every movement becomes a short cross-fade.
