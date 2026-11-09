# Happier taste digest

Load this digest by default for every lane that changes what users see. Open a full taste skill only
when a specific design or motion question remains. `DESIGN.md` and `happier-ui-craft` always win on
conflict; exact values come from the named code owners, never from generic taste recipes.

## Read the surface before styling it

- Name the person, task, frequency, urgency, consequence, and one primary purpose.
- Establish identity first, then blockers, common actions, rare detail, and destructive actions last.
- Choose one primary action per view. Make alternatives quieter and keep destructive work separate.
- Start from the approved lab scene or closest shipped Happier screen, not a blank composition.
- A routine surface stays calm and fast. Reserve expressive choreography for rare signature moments.
- Drop landing-page AIDA, hero, bento, marketing-scroll, font, and palette recipes unless the surface
  actually is a bounded marketing page and they survive Happier's owners and doctrine.

Sources: `DESIGN.md`; `happier-ui-craft/SKILL.md`; `design-taste-frontend/SKILL.md`.

## Hierarchy and type scale

- Use position, scale, weight, spacing, and contrast before adding boxes, color, icons, or labels.
- Give each surface one typographic anchor. Step section titles, row titles, and metadata down clearly.
- Use the eight owned roles: `display`, `title`, `heading`, `label`, `reading`, `body`, `meta`, `micro`.
- Read roles from `packages/plugin-ui/src/presentation/text/typeScale.ts#HAPPIER_TYPE_SCALE`; apply
  them through app `Text`/`TextInput` `variant` + `emphasis` or `Typography.variant(...)`.
- Inter and its shipped 400/500/600 faces are owned by `apps/ui/sources/constants/Typography.ts`.
  Never import a taste skill's font stack or invent an in-between weight.
- Use mono only for identifiers, paths, code, commands, and shortcuts. Use tabular numerals for
  changing counts, times, quotas, usage, and aligned numeric columns.
- Keep headings short; use balanced wrapping where the platform supports it. Do not truncate the
  information that distinguishes sessions, machines, Agents, providers, branches, paths, or errors.
- Test long translations, mixed scripts, large text, and the narrowest supported composition.

Sources: `DESIGN.md` (Typography); `happier-ui-craft/references/components.md`;
`apple-design/SKILL.md`; `make-interfaces-feel-better/SKILL.md`.

## Spacing, density, shape, and alignment

- Use `theme.space` from `apps/ui/sources/theme/themeStyleScales.ts` for gaps and padding.
- Use `HAPPIER_PAGE_METRICS` from `@happier-dev/plugin-ui/presentation`, consumed through
  `apps/ui/sources/components/ui/lists/pageListMetrics.ts`, for columns, gutters, section gaps,
  sheets, cards, rows, controls, pane headers, and breakpoints.
- Use `PageFrame` for the page column. Page title, purpose, section title, and sheet share one edge.
- Density follows use: compact single-line desktop indexes; roomy described rows. Touch targets are
  hit areas, not drawn sizes: a control keeps its designed size and its hit area reaches the target.
- Keep one spacing rhythm and one radius base. Nested radii are optically concentric: outer radius
  equals inner radius plus the inset.
- Align asymmetric glyphs and icon-label pairs optically, not merely by bounding-box arithmetic.
- A phone recomposes: only a switch, short value, or chevron remains beside a label; wider controls
  move beneath it. Lists push detail instead of stacking it above or below the list.
- Preserve one scroll owner per pane, safe areas, software-keyboard clearance, and floating-tab-bar
  clearance. Do not hide an essential action at short heights.

Sources: `DESIGN.md` (Spacing, shape, and alignment; Accessibility); `happier-ui-craft/references/anatomy.md`;
`make-interfaces-feel-better/SKILL.md`; `interface-details/SKILL.md`.

## Materials and surfaces

- Use semantic Unistyles roles from `apps/ui/sources/theme/`; never paste generic hex colors,
  shadows, blur values, border colors, or radii into a feature component.
- Borders, dividers, hover, and selection are low-alpha ink, never fixed gray.
- In-flow rows, controls, cards, grouped sheets, and the composer use the flat edge.
- Floating menus, popovers, dialogs, over-content sheets, toasts and tooltips use the directional rim
  from `@happier-dev/plugin-ui/presentation` raised-edge owners. Keep it a whisper. The message bubble
  is a fill only.
- Use glass only for a functional floating layer or an Elements surface with real atmosphere behind
  it. Unbacked Elements retain their solid paint. Do not stack translucent coats.
- `glassSurfacePaint` and the glass/material host decide paint once for core, plugin, and embedded
  surfaces. Solid and Reduce Transparency remove translucency without changing hierarchy.
- Cards are not the default grouping device. Prefer proximity, whitespace, headings, dividers, or a
  background region when elevation does not express a real layer.
- Icons and Agent, provider, service, and machine marks stand alone without backing tiles; avatars
  and an app icon rendered as an app icon are the only stated exceptions.

Sources: `DESIGN.md` (Materials, elevation, and glass); `happier-ui-craft/references/components.md`;
`apple-design/SKILL.md`; `minimalist-ui/SKILL.md`; `high-end-visual-design/SKILL.md`.

## States, continuity, and one cause per line

- Design first load, populated, refreshing, empty, partial, offline/unreachable, error, denied,
  pending, success, and recovery when each is reachable.
- Use `EmptyState` for emptiness and `SurfaceStateCard` for loading, offline, error, and denied states.
  Container owners supply the size; lists and rails use the quiet line composition.
- Keep last-known-good content during refresh. Reserve known slots. Never flash empty over hydrated
  data, insert known rows late, or resize a modal/pane because results changed.
- Use `SurfaceFreshnessLine` for retained stale content. Keep navigation and recovery available.
- Show one cause once, at the owner that can explain and repair it. Child widgets inherit that state;
  they do not repeat variants of the same error. One cause gets one line and one next action.
- Empty states say what belongs here and why, then offer one primary action. If the viewer is denied,
  put the reason and who can help where the action belongs.
- Unknown is not zero. Keep its slot with an em dash and a quiet reason; do not promote “Unknown” or
  “Unavailable” into a headline metric.
- Healthy is quiet. Amber means needs you; rose means failure; green is reserved for presence/live
  identity. Never add decorative status dots.

Sources: `DESIGN.md` (States are part of the design); `happier-ui-craft/references/states-and-motion.md`;
`happier-ui-craft/references/validation.md`; `design-taste-frontend/SKILL.md`.

## Motion and physical response

- Read durations and curves from `apps/ui/sources/components/ui/motion/motionTokens`; no local timing.
- Respond on press/pointer-down, commit on release, and allow cancel by moving away.
- High-frequency and keyboard-driven actions get no entrance choreography. Toggles, tabs, and
  selection acknowledge immediately without moving layout.
- Ordinary entrances use the owner's short ease-out; exits are quieter and faster. Never use
  `transition: all`, `ease-in`, `scale(0)`, or decorative indefinite animation on routine surfaces.
- Popovers, menus, and tooltips originate at their trigger and return along the same path. Dialogs
  remain centered. Phone sheets track the finger.
- Gesture motion is 1:1, interruptible, and retargets from the current visible value. Hand release
  velocity to the spring; project momentum and apply progressive resistance at boundaries.
- Default springs are critically damped. Bounce/overshoot needs physical input momentum or a rare,
  justified emotional moment.
- Animate transform and opacity on frame-sensitive paths. Use `will-change` only for a measured
  first-frame problem; never lock input until animation ends.
- Reduced motion preserves cause with a short cross-fade or immediate change and removes large
  translation, zoom, parallax, elasticity, stagger, and automatic meaningful-content motion.
- Inspect motion at normal speed and frame-by-frame: check origin, interruption, reversal, velocity
  continuity, flashes, clipping, late focus, input lockout, and repeated-use fatigue.

Sources: `DESIGN.md` (Motion); `happier-ui-craft/references/states-and-motion.md`;
`apple-design/SKILL.md`; `emil-design-eng/SKILL.md`; `review-animations/SKILL.md`;
`animation-vocabulary/SKILL.md`.

## Interaction details

- A touch target is the hit area, never the drawn control. Aim for 44x44pt on iOS and 48x48dp on
  Android by extending the hit area past the drawn control (`hitSlop` on native, an invisible hit
  extension on web, as `HappierTextLinkButton` does). Never enlarge a control, its padding, its row
  height or the spacing around it to reach the number; a small control drawn small is correct.
- Adjacent hit areas never overlap. Where neighbours sit closer than the target, each hit area
  extends to half the gap, and every target still meets WCAG 2.5.8 (24x24 CSS px or its spacing
  exception).
- Hover is an enhancement gated to fine pointers. Its shape hugs the drawn control; do not expose a
  row-sized hover slab for a small glyph unless the whole row is the action.
- Use `HappierPressable` for pressables. Pointer presses do not leave a focus ring; keyboard focus
  paints the single `border.focus` ring, separated from the control by a page-color gap.
- Editable text uses its insertion caret/selection as normal focus feedback; forced-colors restores
  the system outline. Every non-text control retains an explicit focus-visible treatment.
- Menus, pickers, and tooltips use `Popover` + `FloatingOverlay`. Anchor them to the trigger, size to
  content when compact, flip toward available space, and clamp to the window.
- Searchable popovers use full-bleed `SelectionList`; menu rows use `SelectableRow presentation="menu"`.
- A control's accessible name, role, state, order, activation, dismissal, and shortcut must survive
  responsive recomposition. Hover, color, motion, sound, and haptics never carry meaning alone.

Sources: `DESIGN.md` (Interaction and agency; Accessibility); `happier-ui-craft/references/components.md`;
`interface-details/SKILL.md`; `emil-design-eng/SKILL.md`.

## Copy tone

- Sound like a warm, capable collaborator: direct, calm, specific, technically credible, and never
  boastful, saccharine, cryptic, or playful during failure/security/destructive work.
- Use sentence case. Titles are short nouns; buttons are specific verbs; descriptions state current
  value, scope, consequence, or next step without restating the title.
- Say outcomes in the user's vocabulary: Agent, Home, machine, provider, session. Do not expose enum
  values, raw hosts, internal mechanisms, or fabricated precision where a human name exists.
- One message per state. Read the surface top to bottom; if sibling strings repeat a word or two lines
  express the same fact, consolidate them at the owning state.
- Error copy says what failed, what work remains safe, and what the user can do now. Put diagnostics
  behind an intentional reveal and never expose secrets or another user's paths.
- Route all visible and accessibility copy through `t(...)`. Check the longest locale and a 390px phone.

Sources: `DESIGN.md` (Product copy and voice); `happier-ui-craft/references/copy.md`;
`design-taste-frontend/SKILL.md`; `minimalist-ui/SKILL.md`.

## Composer anatomy

- There is one composer owner: `apps/ui/sources/components/sessions/agentInput/AgentInput.tsx`.
  Sessions, new-session flows, workflows, previews, and plugins adapt or configure it; they do not
  draw a second prompt field, action bar, chip, send control, or composer material.
- `AgentInput` owns the prompt/attachments/request/status stack, the leading action-chip rails, and
  the trailing accessory + submit cluster. Keep the established 0.2 rail anatomy recognizable when
  evolving it: controls remain on the leading rail, submit remains trailing, and wrapped rails share
  one baseline and vertical rhythm rather than becoming separate toolbars.
- Panel geometry, paint, chips, and press treatment come from
  `apps/ui/sources/components/sessions/agentInput/components/agentInputChromeStyles.ts` and the
  material owner. `panelPresentation="document"` reuses the same composer in document/workflow cards.
- The composer is one Elements surface with one edge. Inner fields, chip rails, and controls use
  ink-alpha treatment; do not nest opaque cards or add a second floating rim.
- Keep the input the visual and focus anchor. Extra actions collapse through the existing action-menu
  policy; do not shrink hit targets, crowd submit, or make a host invent another overflow decision.
- Preserve the owner's input-height, keyboard, safe-area, attachment, focus, draft, and send/abort
  contracts. A visual simplification may not fork or bypass those behaviors.

Sources: `DESIGN.md` (Canonical components and ownership); current and `../0.2`
`apps/ui/sources/components/sessions/agentInput/AgentInput.tsx`; current
`apps/ui/sources/components/sessions/agentInput/components/agentInputChromeStyles.ts`.

## Whole-page validation

- Inventory every touched surface and meaningful state before declaring coverage.
- Compare the live whole page, fully scrolled, against the chosen lab scene or shipped reference in
  the same state, theme, and viewport. Never compare a scene with a board or populated with loading.
- Run light, dark, 390px phone, the lab width, wide desktop, and just above/below each recompose point.
- Use plausible sparse and heavy data: long names, nested content, real IDs through their display
  formatters, partial coverage, unknown values, and at least one object created through the live flow.
- Judge composition first: eye path, hierarchy, density, rhythm, whitespace, and section relationships.
  Then measure frame, grid, type, rhythm, surfaces, element inventory, and content.
- Sample pixels and inspect computed boxes when color, fill, alignment, or spacing differs. Do not
  patch from impression alone.
- Classify every delta as defect, accepted refinement, or lab update. “Looks fine,” tests, a component
  board, an older build, a crop, or a different state is not acceptance.
- Validate interactions with a sequence or recording: hover, press, focus, popover origin, sheet,
  drag/drop, loading swap, interruption, and reduced motion.
- Record the loaded runtime/bundle identity. A frozen export cannot verify source edits.

Sources: `happier-ui-craft/references/validation.md`; `happier-ui-craft/references/design-labs.md`;
`happier-ui-craft/references/premium-feel.md`; `review-animations/SKILL.md`.

## One concept, one owner, no forks

- Search the touched corridor before adding a component, token, material, state, formatter, motion,
  popover, collection, or composer rule. Name its canonical owner and consumers.
- If the shared component is better than the lab, keep it and record an accepted refinement. If the
  lab is better, improve the shared owner for every consumer and inspect those consumers.
- Never create a page-local lookalike, one-screen variant, call-site style override, second registry,
  or temporary copy to match a reference. A visually accurate fork is still a correctness defect.
- Consolidate competing implementations found in the touched corridor and migrate consumers to the
  owner. Preserve compatible improvements from concurrent lanes.
- Plugins compose the public `@happier-dev/plugin-ui` primitives. If a plugin needs an owner, expose
  the shared primitive instead of recreating host anatomy inside the plugin.
- A rendered change that cannot be viewed remains open as `visual: not seen` with the exact surface
  and state. Tests and source inspection do not close a visual gate.

Sources: `DESIGN.md` (Canonical components and ownership); `happier-ui-craft/SKILL.md`;
`happier-ui-craft/references/validation.md`; `make-interfaces-feel-better/SKILL.md`.
