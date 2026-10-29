# Happier Product Design Doctrine

This document is the canonical product-design and experience doctrine for Happier. It applies to every user-facing surface in `apps/ui`, including mobile, web, and desktop, and to product copy, interaction, motion, onboarding, empty states, errors, recovery, and cross-device flows.

Read this document in full before:

- creating or changing user-facing UI, UX, copy, motion, onboarding, responsive composition, accessibility behavior, or meaningful product states when the work can materially affect the experience;
- performing a substantive design review.

Purely mechanical changes and small non-material experience edits do not need the complete doctrine unless a design decision arises; package instructions still apply. Read the repository and package `AGENTS.md` files as well; they define binding engineering, ownership, testing, accessibility, performance, and validation requirements.

This is a direction and decision framework, not permission to redesign unrelated surfaces or expand product scope. Existing canonical components, tokens, patterns, and owners remain the starting point.

## Ownership and sources of truth

- This document owns product-experience intent, design principles, interaction grammar, voice, and the design quality bar.
- `apps/ui/AGENTS.md` owns binding implementation paths, React and React Native mechanics, test policy, and validation commands. When the documents touch the same concern, use this doctrine for the intended experience and the package instructions for how the repository implements and proves it.
- Canonical components, Unistyles themes, typography, spacing, motion tokens, icons, and platform adapters in code own exact implementation values.
- Feature specifications may define distinctive art direction for a bounded surface, but they do not create another app-wide design system.
- Do not copy generic skill values or values from this document into local components when a canonical token or primitive owns the concept.
- When a genuinely shared semantic concept is missing, add it at its rightful owner, migrate relevant consumers, and remove competing local decisions.
- Existing product behavior is evidence, not automatically the ideal. Preserve what is coherent and improve the canonical owner when it falls short.

## The experience in one phrase

**Happier is a Warm and Fluid Companion.**

It should feel:

- warm, welcoming, and human;
- calm and confident rather than noisy or anxious;
- premium, crafted, and unmistakably intentional;
- fluid, responsive, and alive;
- powerful without feeling dense or intimidating;
- trustworthy about privacy, security, state, and consequences;
- equally considered on mobile, web, and desktop.

“Quietly premium” describes the confidence of the experience, not a lack of personality or motion. Happier must not become basic, static, generic, sterile, or visually timid in the name of simplicity. Premium quality comes from a coherent point of view, strong hierarchy, beautiful composition, responsive interaction, natural motion, thoughtful copy, and countless well-resolved details.

Delight is not decoration added after the interface works. It is the result of purpose, clarity, continuity, agency, performance, accessibility, and craft working together.

## The uncompromising quality bar

We need to cook hard. Aim for top 1% human-design craft and Apple Design Award-level quality. Sweat every pixel, every meaningful state, and every transition frame by frame. Make it feel absurdly good, absolutely stellar, and truly DELIGHTFUL: super clean, minimalist, design-forward, premium, smooth, fluid, and unique, like something Alan Dye would genuinely want to use.

Preserve clarity, accessibility, performance, state continuity, and repeated-use speed. Use Happier’s canonical components, tokens, and motion owners.

## Desired user feelings

Important flows should help people feel:

1. **Oriented** — I know where I am, what changed, and how to leave.
2. **Confident** — I understand what Happier is doing and what will happen next.
3. **In control** — I can interrupt, reverse, retry, skip, undo, defer, or choose an advanced path when appropriate.
4. **Capable** — sophisticated workflows feel approachable without being reduced to toy functionality.
5. **Accompanied** — copy and feedback feel like a thoughtful colleague, not a machine issuing instructions.
6. **Delighted** — coherent motion, polished details, and moments of genuine charm reward attention without obstructing work.

When visual beauty conflicts with orientation, truth, control, accessibility, or responsiveness, resolve the underlying design rather than trading those qualities away.

## The six experience pillars

### 1. Warm recognition

Happier acknowledges where a person is, what they were doing, and what they are likely trying to do next.

- First-time users need orientation, confidence, and a clear invitation.
- Returning users need recognition, continuity, and a fast route back to their work.
- Recovering users need reassurance, preserved state, and direct next steps.
- Expert users need efficiency without losing discoverability.
- Users waiting on agents need honest status and a clear sense of whether attention is required.

Adapt hierarchy and copy to real context. Do not make returning users repeatedly read first-run explanations, and do not place branding interludes in front of urgent recovery, authentication callback, or known-intent flows.

Warmth is specific and useful. It is not forced cheerfulness, anthropomorphic excess, jokes during failure, or random copy in security-sensitive and operational states.

### 2. Fluid continuity

The interface should preserve the user’s mental model as state changes.

- Keep persistent visual anchors stable when moving between related states.
- Preserve location, selection, scroll position, input, focus, and last-known-good content whenever the underlying task continues.
- Make entrances originate from their trigger or prior location when spatially meaningful.
- Make exits return along the corresponding path.
- Use motion to explain what persisted, what changed, and where an object went.
- Never flash an empty or loading state over useful hydrated content merely because a refresh began.
- Do not abruptly replace an experience owner halfway through a multi-step flow.

Continuity is both visual and semantic. A user should not need to reconstruct what happened after navigation, reconnection, authentication, rotation, resizing, or handoff between devices.

### 3. Calm power

Happier coordinates sessions, agents, providers, machines, tools, code review, and remote work. The domain is powerful and sometimes inherently complex; the interface should make that power understandable without pretending it is simple.

- Lead with the common path and the decision the user must make now.
- Reveal advanced controls progressively, near the context they affect.
- Use grouping, hierarchy, and plain language before adding explanation.
- Model real complexity explicitly when hiding it would create surprising behavior.
- Prefer direct, boring interaction mechanics under a distinctive visual composition.
- Avoid both dense control panels with no prioritization and sparse screens that hide essential context.

Simplicity means reducing unnecessary decisions and knowledge, not removing useful information until the screen looks empty.

### 4. Truthful product experience

Show the real product and describe real behavior.

- Reuse canonical product components, primitives, flows, and visual language.
- For tours, previews, documentation, or seeded demonstrations, render real product surfaces against safe representative state whenever practical.
- Do not build marketing-only replicas or similar-but-different UI that can drift from production behavior.
- Do not promise speed, availability, privacy, compatibility, or “instant” behavior beyond what the product can reliably deliver.
- Display system status, latency, limitations, and recovery paths honestly.
- Distinguish previews, simulations, pending operations, and committed state.

Trust is part of the interface. Encryption, self-hosting, relay choice, permissions, destructive actions, data movement, and external side effects should be understandable at the point of decision.

### 5. Platform-equal, context-native design

Mobile is as important as desktop and web. Equal importance does not require identical layouts.

- Preserve promised capability, product identity, terminology, and state continuity on each platform the feature reaches. Equal importance requires deliberate treatment of affected platforms, not automatic feature parity or identical execution, persistence, availability, or consistency.
- Adapt composition, information density, navigation, input, and reachability to the device and context.
- Mobile is not miniature desktop. Recompose around touch, thumb reach, safe areas, software keyboards, narrow widths, rotation, and interrupted use.
- Desktop is not enlarged mobile. Support precision, keyboard navigation, hover as enhancement, resizable windows, denser comparisons, and deep workflows.
- Web must work responsively across pointer and touch environments and must not rely on native-only affordances.
- Never make hover the only way to discover or perform an action.
- Treat iOS and Android as first-class mobile surfaces and macOS, Windows, and Linux as first-class desktop environments wherever the UI or shell behavior reaches them.

Design platform-specific compositions deliberately. Do not branch merely to create visual novelty, and do not force sameness when the interaction context is genuinely different.

### 6. Crafted delight

Happier should be enjoyable to use, not merely functional.

Delight can come from:

- immediate and tactile response;
- a transition that preserves focus perfectly;
- warm contextual copy;
- a thoughtfully animated state change;
- an elegant visual reveal at a signature moment;
- a useful detail appearing exactly when needed;
- preserved work after a disconnect or interruption;
- effortless movement between phone, desktop, web, and terminal;
- a confident completion moment after meaningful work.

Delight must earn attention. Do not add confetti, bounce, sound, haptics, looping animation, or playful copy indiscriminately. Repetition turns delight into friction.

## The core experience grammar: show, guide, confirm

First orient the person: establish where they are, why the moment matters, and whether this is new work, resumed work, or recovery. Then prefer:

1. **Show** — begin with the outcome and demonstrate the behavior, preferably through the real product or a truthful representation of its resulting state.
2. **Guide** — offer one coherent decision at a time, keep the recommended path obvious, and preserve agency to go back, skip, defer, retry, or choose an advanced path where appropriate.
3. **Confirm** — end on a concrete useful result, show what is now ready, and make the next likely action obvious. Do not stop at a generic “Done” screen.

For onboarding and setup, aim for the first useful success: a connected machine, a usable session, a completed handoff, or another real outcome—not merely completed configuration.

Do not begin with configuration fields when the user does not yet understand the benefit. Do not force a long explanation when the person arrived with a known intent.

The grammar scales down to small interactions:

- An empty state orients, shows what belongs here, and offers the next useful action.
- A permission request explains the benefit immediately before asking.
- An error identifies what failed, preserves work, and offers recovery.
- A completion state confirms the result and makes the next likely action obvious.

## Hierarchy and composition

Every screen should answer without effort:

- Where am I?
- What is happening?
- What needs my attention?
- What can I do next?
- How do I go back, cancel, defer, or recover?

### Visual hierarchy

- Establish one dominant purpose per screen or pane.
- Make the most probable or important action visually primary; do not make every action loud.
- Use position, scale, spacing, contrast, typography, and grouping before adding boxes or labels.
- Place controls close to the content or state they affect.
- Separate primary actions, secondary alternatives, and destructive actions clearly.
- Preserve reading order between visual layout, keyboard navigation, and accessibility traversal.
- Use whitespace to create rhythm and comprehension, not to imitate minimalism.
- Use controlled density for expert and data-rich workflows; density still needs clear grouping and scan paths.

### Responsive composition

- Recompose rather than merely shrink.
- Validate narrow phones, large phones, tablets, small desktop windows, common laptop sizes, and wide screens.
- Design short-height and software-keyboard states, not only ideal aspect ratios.
- Keep essential actions reachable when content grows, translations expand, or text size increases.
- Prefer one coherent scroll owner. Avoid nested scrolling unless the interaction genuinely requires it.
- Preserve useful context during responsive changes; do not move actions unpredictably between nearby widths.

### Signature and routine surfaces

Use visual intensity intentionally:

- **Signature moments** may use atmosphere, richer illustration, staged reveals, spatial camera movement, or expressive transitions. Examples include first onboarding, major handoff, meaningful completion, and carefully chosen feature introductions.
- **Routine workflows** should retain craft and tactile feedback but prioritize speed, repeatability, and low cognitive load.
- **Urgent or recovery flows** prioritize clarity, preserved state, direct action, and calm reassurance.

Interaction frequency determines expressive intensity. High-frequency actions should feel immediate, tactile, and nearly effortless. Occasional transitions may explain spatial change. Rare signature moments may use richer choreography. Repeated exposure must make the interface feel faster and more natural, not force people to watch the design perform.

Home, new session and projects may carry the user's atmosphere; it stays decorative, behind content, with no frame loops at rest. The only resting motion is the digits retyping every 2 s while Home is visible and focused; everything pauses when hidden. The onboarding cinematic stage, word-by-word narration, and demo-world machinery remain references for experience quality rather than default app chrome.

## Motion: fluid, physical, and purposeful

Motion is part of interaction design. It should preserve continuity, communicate causality, direct attention, and make manipulation feel immediate.

### Motion principles

- Respond visually on press or pointer-down; do not wait for an operation to complete before acknowledging input.
- Keep direct manipulation attached 1:1 to touch or pointer movement.
- Make interactive motion interruptible and reversible. New input must be able to redirect an animation from its current visible state.
- Preserve gesture velocity when handing off from drag to settling motion.
- Use projected momentum for flick and throw interactions rather than choosing a destination from release position alone.
- Use progressive resistance at boundaries instead of abrupt dead stops when a physical gesture crosses a limit.
- Anchor menus, sheets, previews, and expansions to their trigger or source when that relationship aids understanding.
- Enter and exit along coherent, usually symmetric spatial paths.
- Prefer transform and opacity for frame-sensitive movement; avoid layout thrash.
- Animate exact properties, never a blanket `transition: all`.
- Use compositing hints only for measured first-frame problems; excessive layers waste memory.

### Springs, easing, and bounce

- Prefer critically damped, non-bouncy motion for ordinary state changes.
- Use bounce or overshoot only when the input carried physical momentum or the emotional moment clearly justifies it.
- Do not make menus, routine modals, or status changes wobble for decoration.
- Use repository motion primitives and tokens before adding local timings, curves, or spring values.
- Match timing to distance and context. A repeated utility action should settle faster than a cinematic onboarding transition.
- Exits are generally quieter and faster than entrances because attention is moving forward.

### Motion intensity ladder

1. **State feedback** — immediate press, hover, focus, selection, progress, and validation response.
2. **Local continuity** — icon swaps, disclosure, inline insertion/removal, and small content changes.
3. **Spatial transition** — navigation, sheets, panels, handoff, and object movement where origin and destination matter.
4. **Signature choreography** — rare, art-directed moments such as onboarding or major completion.

Use the lowest level that fully communicates the change. Do not solve a local state update with cinematic choreography.

### Automatic and ambient motion

- Do not auto-advance meaningful content indefinitely without pause, stop, or direct navigation controls.
- Pause ambient motion when the surface is hidden, backgrounded, off-screen, or no longer relevant.
- Avoid perpetual motion near reading, editing, terminal, diff, and other concentration-heavy surfaces.
- Do not use animation to delay access to an action or to disguise loading time.
- Validate that repeated exposure remains pleasant; a delightful first animation can become exhausting on the twentieth use.

### Reduced motion, transparency, and contrast

Reduced motion is a functional requirement, not an optional polish pass.

- Resolve the user preference at the canonical motion owner and propagate the effective value through the complete experience.
- Replace large translations, parallax, zoom, elastic motion, and staggered reveals with short cross-fades or immediate state changes.
- Preserve feedback and causality; reduced motion does not mean a dead interface.
- Disable or make manual any automatic motion that changes meaningful content.
- Provide more solid surfaces when reduced transparency is requested or blur compromises legibility.
- Maintain defined boundaries and sufficient contrast in increased-contrast modes.
- Do not create rapid flashing. Any unavoidable flashing or rapid visual transition must stay within applicable accessibility thresholds for frequency, contrast, red flash, and affected area; prefer a non-flashing treatment and avoid abrupt large-area brightness changes.

## Visual language

### Product identity

Happier should be recognizable without relying solely on its logo.

- Use the established warm cosmic identity, palette relationships, typography, iconography, and compositional rhythm where appropriate.
- Let distinctive atmosphere support a moment rather than cover every surface.
- Combine a memorable visual idea with restrained utility UI; do not make every element compete to be the signature.
- Avoid generic “AI product” styling: interchangeable purple gradients, excessive glowing cards, indiscriminate glass, floating pill overload, decorative grids, and layouts that could belong to any assistant product.
- Avoid sterile monochrome minimalism with no warmth, hierarchy, or product character.

### Color and theme

- Use canonical Unistyles theme tokens and semantic roles; do not hardcode production colors in feature components.
- **Borders, dividers and selection are ink.** They are the theme's own text colour at low opacity —
  a border, a lighter divider, a selection fill — never a fixed grey. Ink sits correctly on every
  surface, tint and theme profile; a grey that matches one background is wrong on the next.
- **Dark themes are layered, not inverted.** From the navigation plane to the page, cards and floating
  surfaces, each layer lifts by a small step of light and keeps its raised edge, so depth reads without
  heavier shadows.
- Treat light and dark themes as designed experiences, not mechanical inversions.
- Use accent color deliberately to guide attention, show state, or create a signature moment.
- Do not use color as the only carrier of meaning.
- Preserve legibility over gradients, images, blur, transparency, terminal colors, diffs, and syntax highlighting.
- Keep provider- or agent-specific colors owned by their canonical contribution or registry rather than branching in generic UI.

Art-directed imagery and narrative surfaces may need locally owned visual tokens. Keep them in one named, domain-owned, theme-aware token module under the bounded exception in `apps/ui/AGENTS.md`; feature components must not scatter raw values. Document why global semantic roles are insufficient, define light/dark and accessibility behavior, and do not create a competing app-wide design system.

### Typography

- Inter is the default interface typeface on every platform, including native iOS and Apple web. Theme-held font choices continue to override the default; monospace keeps its own canonical family.
- Inter ships as static faces — Regular 400, Medium 500, SemiBold 600 — chosen by face through the one font owner (`constants/Typography.ts`). React Native exposes no variable-axis control and Android selects a weight by face, so in-between weights from a lab snap to the nearest shipped face, ties to the lighter: 450 → 400; 560, 620, 640, 650 and 660 → 600.
- **Type roles.** Interface text is one of eight roles — `display`, `title`, `heading`, `label`, `reading`, `body`, `meta`, `micro` — owned by `HAPPIER_TYPE_SCALE` (`packages/plugin-ui/src/presentation/text/typeScale.ts`) and applied through `Text`'s `variant` and `emphasis` or `Typography.variant`. Sizes are whole pixels; another weight is an emphasis, not another size. A slot that seems to need a value no role has is a change to the role for every consumer, never a local number. Transcript text, Markdown, terminal and code keep their own domain scales. Design labs read the same roles from the generated `product-tokens.css`.
- Use Happier’s canonical text primitives and typography tokens so scaling, platform rendering, theme, and localization continue to work.
- Build hierarchy from size, weight, leading, tracking, color, and spacing as a coherent set.
- Large display text may use tighter leading and tracking; body and dense UI text prioritize legibility.
- Keep headings concise and balance short headings on platforms that support it.
- Avoid orphaned final words in short descriptive copy when platform primitives allow appropriate wrapping.
- Use tabular numerals for changing counts, timers, quotas, usage, aligned metrics, and numeric tables to prevent visual jitter.
- **Meta lines up.** In a list, a row's time, count or size sits right-aligned in one tabular column
  so the eye scans it vertically; a status that already has a mark (a dot, a cell) does not repeat
  itself in words beside it.
- **Mono is a role, not a style.** Monospace is for identifiers, paths, code, commands and keyboard
  shortcuts (`#2493`, `⌘K`, `$HAPPIER_EVENT`), never for emphasis or decoration.
- Never truncate information necessary to distinguish sessions, machines, providers, branches, paths, or errors without an accessible way to reveal it.
- Test long translations, mixed scripts, large text settings, and narrow viewports.

### Spacing, shape, and alignment

- Use the existing spacing, radius, size, and layout tokens or primitives.
- **Spacing steps and layout roles.** Gaps and padding are steps of `theme.space` (2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48). Page columns, gutters, section gaps, card padding, row, control and pane-header heights are layout roles in `HAPPIER_PAGE_METRICS`, and `PageFrame` renders the page column. Hairlines and optical offsets (0, 1, 3 px, negatives) stay literal. A value no step or role has is a proposal for that owner.
- Repeated spacing values should express a rhythm, not a collection of nearby guesses.
- Nested rounded surfaces should appear optically concentric when they represent layers of one object.
- **Radii derive from one base.** Small, control, menu, card and dialog radii are steps of one base
  value; an inner surface's radius is the outer radius minus its inset, so nested layers stay
  concentric. A radius chosen per surface is a defect.
- **Spacing runs on one rhythm.** Card insets, header heights, row heights and gaps are steps of the
  same grid. Dense desktop rows are compact; a row's hit area is the whole row, and its drawn height follows
  the design, not a touch-target number.
- Align icons optically, not only mathematically; asymmetric symbols often need correction.
- Keep icons and labels visually balanced and baseline-aligned.
- Avoid creating every grouping as a rounded card. Use proximity, whitespace, headings, dividers, background regions, and elevation according to meaning.
- Borders separate dense structure; shadows and material can express depth. Do not substitute one mechanically for the other.

### Materials, elevation, and glass

- Use translucency to express a floating functional layer or preserve spatial context, not as a default decoration.
- Ensure text and controls remain legible over changing backgrounds.
- **Glass follows five layers.** Window is the app over the desktop (`content`); a browser cannot
  show the desktop. Title bar and rail (`chrome`), Sidebar (`sidebar`), Elements (`card`) and
  Menus and dialogs (`floating`) each use the same canonical material owner. Elements include
  cards, widgets, the composer, settings groups and the sidebar's rounded list groups. Presets
  remain quick choices above one Glass/Solid row per layer; blur strength stays global. Changing
  Elements keeps the preset selected, and switching presets preserves its Glass/Solid choice.
- **Elements need a backing.** Their default Glass choice becomes translucent only over a live
  translucent content plane or an atmosphere band or wallpaper. With nothing behind, they retain
  their exact solid paint without tint, blur or an extra layer. The glass owner decides this once
  for core, plugin and embedded surfaces. Native Elements use translucent tint without a BlurView
  or Liquid Glass view per card. Same-group nested cards inherit their containing coat and finish.
- **Background and glass are independent.** Planet and Picture remain visible under every glass
  setting. Wallpaper keeps its full-window layout under Solid, Auto on web, inactive windows,
  Custom and Reduce Transparency. The glass owner's `atmosphereBehind` (`none`, `band`, `wallpaper`)
  input clears the content-plane paint whenever a background is shown; the atmosphere supplies the
  page colour outside its artwork, opaque under Solid and Reduce Transparency. Home and its lists
  do not override transparency. Title bar, sidebar, cards, widgets and composer retain their
  owner-assigned material and stay opaque under Solid and Reduce Transparency; cards, widgets and
  composer consume the glass owner's Elements group. Look's chip
  and popover remain menus/dialogs. Chrome and sidebar blur Wallpaper on a sibling layer when their
  material allows it, using the existing glass radius and tone owners; the planes never become
  backdrop roots that cut off nested popovers. Content uses the picture's pre-rendered haze.
  Check popover and secondary-text contrast over every built-in picture in light and dark;
  preserve custom values without contrast floors or extra coats.
- **Floating glass is the enabled default.** Auto, Everywhere and Clear all give menus, popovers,
  dialogs, floating sheets, tooltips and toasts the same low-tint floating material. Web uses 24px
  frost and a fixed dark/light backdrop treatment, not a near-opaque coat or content-reactive scrim;
  native uses adaptive Liquid Glass or the existing tinted blur fallback. Solid and Reduce
  Transparency remove translucency. Custom per-group opacity and blur remain exactly authored.
  A **Tint** slider (integer 0–100, default 12) sets how much of its own paint
  named-preset Elements and menus carry. At every tint, glass over the plain page lands exactly on
  the surface's warm solid paint (within one level); the tint only sets how thin the coat carrying
  that paint is. The anchors at 0/50/100 are the former Subtle/Medium/Strong values; every coat and
  compression value interpolates linearly between neighbouring anchors at the protocol's
  `glassTint.ts` owner. At 12, light Elements over a picture use k ≈ .863 (about a 14% wash).
  At 0, glass is monocode's blur: a 1% hair of paint, thickened only as far as the fixed
  point needs (about 6% for dark's warm card and menu paint), never a neutral lift, and k = 1, so over
  a picture the inside stays within ±5% of the blurred backdrop's luminance in light and moves only by
  the surface's own paint step in dark (owner, 2026-10-15). Legibility over very bright pictures
  belongs to Medium and Strong and the stronger faint ink on backed glass. Medium and Strong are
  progressively frosted. The soft finish and rim stay on glass as on solid surfaces. Shell planes keep each preset's own coats, custom
  tables apply exactly as set, and native renderers (no web backdrop tone, no card blur) keep the
  stored coats (the 50 anchor). Web glass is an affine map of the blurred backdrop X, k·X + c, from a `brightness()`
  tone and a coat solved so the plain page lands on the tint's paint, never a grey lift or a hole.
  `contrast()` is never used on dark: it pivots at mid-grey and lifts a dark page into a grey slab.
  Over an ordinary page Subtle and Medium pass the backdrop through (k = 1); over a picture Subtle
  keeps k = 1 while Medium and Strong drop k only as far as primary ink needs 4.5:1 over a bright sky
  (Medium .45, Strong .35).
  Light hangs its band from white (`invert(1) brightness() invert(1)`) and never brightens the
  backdrop past the page (k ≤ 1 − α), so a white page stays white. Saturation is kept at 1.05, never reduced
  (our one deviation from monocode). A floating surface declares its role on the material owner
  (`FloatingSurfaceRole`): **panels** carry the page at a heavy coat behind their blur, as monocode's
  modals do: 55% at 0, 70% at 50, 85% at 100 (61% at the default 20), still landing on the floating paint over a plain
  page. Panels are centred dialogs (`ModalCardFrame`: alerts, prompts, the command palette), phone
  sheets and large anchored panels (`FloatingOverlay role="panel"`: Add widget, About this widget and
  the other widget flows, Workflow run inputs, Board settings, the workflow examples gallery, the
  session role panel). **Menus**, tooltips and small popovers keep the hair (owner, 2026-10-16),
  except over a live picture (a shared screen or browser page): there every floating surface carries
  Strong's panel coat (85%) at any tint, because arbitrary pixels are content, not atmosphere
  (recommended exception; owner ruling pending).
  Custom glass values, Solid and Reduce Transparency apply to both roles unchanged. On glass with a picture or the live desktop behind it, faint (secondary) ink takes a
  stronger step, primary ink at 70%, so it holds about 3:1 over a bright sky; ordinary pages and
  unbacked glass keep the theme's secondary ink.
  Glass identity takes priority over forcing muted ink to meet extreme-backdrop contrast. Accepted limits are secondary ink over saturated
  colourful backdrops and primary ink on selection/hover at the pure-white dark-theme extreme;
  do not darken or flatten the material to remove those limits.
  Surrounding chrome, sidebar and content retain each preset's own recipe. Inner rows, fields,
  controls and dividers use ink-alpha paint, not opaque islands inside the floating plane.
- Do not stack multiple light translucent surfaces until hierarchy and contrast collapse.
- Larger or higher surfaces may use stronger separation than small controls.
- Pair modal tasks with appropriate focus treatment; do not dim the world for parallel, non-blocking work.
- Material transitions should feel like the surface arrives and departs, not like arbitrary opacity toggles.
- **One material recipe.** A surface is drawn by its role, not by hand: an ink border, one raised
  edge and a very low elevation (a hair of grounding, about 5% on light for controls) sized by how far
  it floats.
- **Light cards are grounded, not drawn (W3).** Every in-flow card on light — page and grouped sheets,
  widgets and `SurfaceCard`, core and plugin alike — carries the faintest trace of each cue: the page
  under 0.4% of the theme's ink, a 0.6% foot band, a 1.2% lip over its 8% hairline and a 2% grounding
  shadow (`shadowCard`), below a control's 5%. Controls, floating surfaces, the composer and every
  dark value keep their own treatment. The card's band and lip are a share of the theme's finish and
  edge inks, so a profile that sets either keeps its colour and relative strength. The edge owner
  (`theme/raisedEdge.ts`, `resolveThemeCardChromeStyle`) decides this once; no screen paints its own.
  The raised edge is one side of the border drawn a breath different — a dark lip along the bottom on
  light, a light line along the top on dark. The composer has no lip: one even hairline (owner,
  2026-10-15).
  The default soft finish is a quiet edge, not a wash: a 32 px ink-alpha band over that role's
  existing fill, shading the bottom edge on light and lighting the top edge on dark, so the middle of
  a tall card stays flat. It applies
  whether solid, tinted, blurred or Liquid Glass. Flat keeps the same border and edge without that
  overlay. Appearance selects the finish globally or per role; card-framed widgets follow the card
  role. Nested glass surfaces in the same material group inherit the containing finish rather than
  stacking another coat. Dark surfaces step up in the theme's own warm hue: cards take the authored
  raised surface (`surface.elevated`), floating surfaces one quiet step above it, and the sidebar's
  list sheets the page colour, one quiet step above the sidebar. Fields, rows, chips and ghost buttons stay flat.
  Dark Soft lifts the card surface's own hue and saturation with a peak alpha of 0.025 at the top
  edge, fading out over the band; light shades the bottom edge to its ink alpha (0.024) over the band
  for floating surfaces and the composer, and to a quarter of it (0.006) for in-flow cards. The theme's single editable
  `effect.surfaceFinish` ink controls colour and strength, with custom values left as authored.
- **Flat edge in flow; the rim only for what floats.** Controls, rows, cards, grouped sheets and the
  composer use the flat edge, in every theme. Popovers, menus, dialogs, sheets over content, toasts,
  tooltips and the message bubble use the directional rim: one corner light anchored top-left,
  running along the top and down the side and gone by about a third of the way round, with a short
  sheen inside the fill from the same corner. On dark the corner is lighter (white about 18% at the
  corner, 5% by a fifth of the way, sheen about 3%); on light it is inverted — a breath darker, never
  white (ink about 8% at the corner, tint about 2%). Buttons, fields and rows never take the rim: on a
  dense screen every control would carry a highlight. The choice is one edge role per surface role in
  the edge owner, never a per-screen style.
- **The rim is a whisper.** If you notice it before the content, it is too strong.
- **Primary actions carry their own light.** The filled primary has a faint light line along its top
  edge; secondary and destructive actions use the flat edge; ghost and icon buttons have no edge at
  rest.

### Icons and imagery

- Interface icons use one size and one stroke weight in chrome, from the icon owner's defaults; a
  different size is a different role (identity marks, empty-state art), not a local adjustment.
- The default interface stroke is 1.5 units (the icon owner's `DEFAULT_STROKE_WIDTH`): 1.25 lets
  the small glyphs (composer chips, right rail) disappear, 2 reads busy. A rail glyph rests in the
  secondary ink at 80% (at least 3:1 against the rail in light and dark; `text.tertiary` falls
  under it on the light rail); the open destination is filled in the primary ink. Rail badges are
  drawn by the rail slot (`AppRailSlot`), so every badge sits at the same offset from its glyph.
- Item glyphs stay in the ink; colour is for state, not for decorating a type of item.
- Use the existing icon system and canonical product imagery before introducing a new visual family.
- Icons communicate familiar actions; labels remain necessary when meaning is not immediately predictable.
- Do not use icon-only controls without accessible labels and adequate hit targets.
- Keep decorative imagery non-interactive and out of accessibility traversal where appropriate.
- Use subtle separation for images placed against variable backgrounds when needed, without tinting edges unnaturally.

## Interaction and agency

- Feedback begins immediately, while commitment happens at the correct semantic point.
- Preserve cancellation when a press or gesture moves away before commitment.
- Keep interactive hit areas generous and non-overlapping across touch and pointer layouts. A hit
  area is invisible; it never makes the drawn control, its padding or its margins bigger.
- Support keyboard focus, activation, dismissal, traversal, and shortcuts where the platform permits.
- Focus must remain perceptible against every supported background. Editable
  text fields use their native insertion caret and selection as the normal-mode
  focus cue; do not add an outline, border, glow, or shadow around them. In
  browser/OS forced-colors modes, restore the system-colored keyboard outline.
  Controls without an insertion caret still require an explicit focus-visible
  treatment.
- Use destructive confirmation only for meaningful irreversible consequences; prefer undo for recoverable actions.
- Never use dark patterns, false urgency, hidden opt-outs, or visually deceptive action hierarchy.
- Keep back, cancel, skip, later, replay, retry, and recovery behavior consistent with the consequence and flow.
- Do not trap users in onboarding, setup, modal, authentication, or error states.

### Forms and consequential choices

- Keep labels available after a field has a value; placeholders are not labels.
- Validate close to the field and when the user can act on the feedback.
- Explain non-obvious formatting, security, privacy, cost, or compatibility consequences before commitment.
- Preserve entered values after validation, authentication, or network errors whenever safe.
- Distinguish unavailable, disabled, pending, selected, and read-only states visually and semantically.
- Describe choices in terms of outcomes and identify a recommendation without coercion.

### Sound and haptics

- Use sound or haptics only for meaningful causal events such as commit, snap, success, warning, or error.
- Align visual, audio, and haptic feedback to the same causal moment.
- Never make sound or haptics the only indication of state.
- Respect platform and accessibility preferences and avoid repeated feedback in high-frequency workflows.

Every multi-step flow needs one canonical owner for each capability the flow actually supports. Do not manufacture skip, persistence, animation, or lifecycle machinery for a short flow that does not need it. Centralize, as applicable:

- the current step;
- forward and backward movement when offered;
- skip and defer behavior when offered;
- completion;
- persisted continuation and recovery when the flow survives interruption;
- transition direction when the flow animates spatially;
- cleanup when the flow owns resources or temporary state.

Do not allow nested surfaces to create competing Back, Next, Skip, or Done decisions.

## Product copy and voice

### Voice

Happier sounds like a warm, capable collaborator:

- direct but not abrupt;
- confident but not boastful;
- technically credible but not needlessly technical;
- encouraging but not saccharine;
- concise but not cryptic;
- calm during failure;
- respectful of the user’s time and expertise.

Prefer language such as:

- “Already running sessions? They’re already here.”
- “You love the terminal? We do too.”
- “Let’s wake this machine up.”
- “Ready when you are.”

These work because they recognize context, communicate a benefit, and invite action without hype.

### Copy structure

When more than a label is needed:

1. Recognize the situation or desired outcome.
2. State the benefit in plain language.
3. Explain the concrete behavior or consequence.
4. Offer a specific action.

Use direct labels that describe the destination or consequence. “Review changes” is better than “Continue” when review is what will happen.

Empty and setup states say what belongs here in one plain sentence and offer one action. Settings
descriptions state the effect or scope, never the mechanism ("Get a ping when an agent needs you",
not "Toggle to enable or disable push notifications"). Catalogues lead with purpose and keep
provenance secondary: a widget row says what it shows; the plugin or source that provides it is a
quiet second line.

### Error and recovery copy

- Say what failed in language the user can act on.
- Preserve and acknowledge any work that remains safe.
- State whether the operation can be retried, requires reconnection, needs permission, or must wait.
- Avoid blaming the user.
- Do not pair a serious failure with playful copy.
- Put diagnostic detail behind an intentional reveal when it helps support or expert users.
- Never expose secrets, tokens, credentials, sensitive payloads, other users’ paths, or server-internal paths. A user-owned local or workspace path may be shown on a private surface when it is necessary to identify or recover from the failure; prefer canonical display formatting or abbreviation when the full path adds no value, and redact it from shared, exported, analytics, telemetry, or public surfaces unless explicitly authorized.

### Copy constraints

- Use `t(...)` and canonical translation keys for all user-visible text and accessibility labels.
- Do not randomize operational, security, error, destructive, or compliance-sensitive copy.
- Harmless welcome variation may be used sparingly if every combination is coherent and translations remain reviewed.
- Avoid unsupported absolutes such as “always,” “never,” “instant,” or “unlimited.”
- Avoid vague AI language, inflated superlatives, and claims that obscure the real behavior.

## States are part of the design

A feature is not designed until its meaningful states are designed.

Consider, where relevant:

- first use and returning use;
- empty, populated, and very large data sets;
- initial loading, background refresh, pagination, and stale-but-useful content;
- optimistic, pending, succeeded, partially succeeded, failed, and retrying operations;
- offline, reconnecting, restored, and cross-device state;
- unavailable, unsupported, disabled, permission-denied, and feature-gated states;
- missing machine, stale machine, multiple machines, or changing machine availability;
- long text, large text, translations, narrow windows, rotation, and keyboard-open states;
- interrupted onboarding or setup and resumed continuation;
- destructive actions and recoverable undo;
- concurrent updates, delayed agents, and attention-required states.

Use skeletons only when they represent a stable forthcoming structure and do not replace better continuity. Prefer last-known-good content with an honest refresh indicator when safe.

A state takes the size of its container. A page, pane, card or phone state uses the shared state
composition at that container's size step; a list, rail or column states its condition in one quiet
line on the rows' edge. Failures and denials keep their semantic glyph and recovery at every size;
illustration appears only where the container has room for it.

Do not treat empty, error, or loading states as visual leftovers. They often define the user’s trust in the product.

## Accessibility is a design input

Accessibility shapes the primary design rather than providing a parallel version.

The baseline is WCAG 2.2 Level AA for applicable web, desktop, and native behavior, plus the accessibility conventions and APIs of each target platform where WCAG does not directly specify the interaction. Use the stricter applicable requirement when standards overlap. If a platform cannot expose or honor a required preference, document the gap and provide the safest available equivalent rather than silently treating it as supported.

- Support screen readers with correct roles, names, state, order, and announcements.
- On web and desktop, support text scaling to 200% without loss of content or functionality except for applicable WCAG exceptions. On native platforms, support Dynamic Type according to platform conventions while keeping the content and actions needed to understand, operate, and recover from the flow available.
- Meet applicable WCAG contrast requirements in light, dark, increased-contrast, transparent, image-backed, diff, and terminal contexts; meaningful non-text UI and focus indicators need contrast as deliberately as text.
- Provide keyboard access and perceptible focus on web and desktop. For
  editable text fields the insertion caret/selection is the visible focus cue;
  forced-colors mode additionally restores the browser outline.
- Do not rely on color, hover, animation, spatial position, sound, or haptics alone.
- Focus is one ring everywhere: the focus colour, separated from the control by a gap in the page
  colour and following its radius, so it never merges with a border and reads on every surface.
- Honor reduced motion and reduced transparency throughout a complete flow, not only in isolated components.
- Touch targets are hit areas, not drawn sizes. Give touch controls a 44×44 point (iOS) or 48×48 dp (Android) hit area where the surrounding space allows, by extending the hit area beyond the drawn control (`hitSlop` on native, an invisible hit extension on web). Never enlarge the drawn control, its padding, its row height or the spacing around it to reach the number. Adjacent hit areas never overlap; where neighbours sit closer, each hit area extends to half the gap, and every target still meets WCAG 2.5.8 (24×24 CSS px or its spacing exception) and stays keyboard accessible.
- Automatically started moving, blinking, or scrolling content that lasts more than five seconds and appears alongside other content must provide the pause, stop, or hide controls required by WCAG 2.2.2 unless it is essential. Auto-updating content presented alongside other content must provide the applicable pause, stop, hide, or update-frequency control unless essential. Document and verify any essential exception; short entrance and exit transitions remain governed by the motion rules rather than being treated as auto-updating content.
- Keep accessibility labels specific and localized.
- Verify accessibility after responsive recomposition; mobile and desktop DOM/native order may differ.

An inaccessible flourish is not premium. The premium result is one where the accessible behavior feels equally intentional.

## Performance is part of the feeling

Responsiveness is the foundation of fluidity. A beautiful interface that lags, jumps, loses state, or blocks input is not premium.

- Acknowledge input immediately even when the underlying work is asynchronous.
- Keep gestures and frame-sensitive animations off expensive layout paths.
- Follow `apps/ui/AGENTS.md` for binding React and React Native render ownership, subscription locality, referential stability, memoization, caching, virtualization, pagination, and profiling rules. From the design side, define which content must remain stable and responsive, then validate the real high-risk flow rather than prescribing speculative optimizations.
- Preserve scroll anchoring, selection, viewport restoration, and last-known-good content during refresh.
- Lazy-load genuinely heavy, non-critical, or signature experiences when doing so does not create a blank or disjointed first frame.
- Prewarm expensive surfaces only when the likely benefit exceeds memory, network, battery, and startup cost.
- Avoid eagerly mounting complete journeys, heavy hidden screens, real-product demos, capture pipelines, or many warm caches when a narrow active window can preserve the same experience.
- Pause off-screen and background work that exists only for presentation.
- Measure render counts, interaction latency, animation smoothness, memory, startup, and large-data behavior when a change can materially affect them.

Do not “optimize” by removing useful feedback, accessibility, visual continuity, or user-visible freshness. Performance and experience are one constraint, not opposing goals.

## Configuration surfaces

Settings, and every full page used to configure or inspect something, share one composition. The
visual reference is the approved design lab for the configuration-surfaces program; the exact values
live in the page-presentation owners in code.

- **The page is paper, the navigation recedes.** The settings rail is the tinted plane; the page is
  the readable surface.
- **Every page has an identity.** A page header states the title and one sentence of purpose. Where
  native navigation already shows the title, the header shows only the purpose.
- **Sections read before their controls.** A sentence-case section title with its explanation above
  the rows, then one card sheet. Row dividers use the divider ink and run from the rows' text edge
  (past the leading column when the section reserves one) to the sheet's trailing edge; the last row
  draws none. No uppercase group labels or after-the-fact footers on page surfaces.
- **Configure on sheets, browse flat.** Configuration and hub pages keep their sections on sheets. A
  section that indexes entities (all services, all machines, usage accounts) lies flat on the page
  (`ItemGroup surface="none"`) with the same text-inset dividers; it gains no card, finish, lip or
  shadow. Dashboards and heroes do not gain cards either.
- **One row, one decision, one control.**
  - A switch for on/off.
  - A segmented control for two to four short choices, all visible.
  - A bordered field select for longer or larger sets.
  - A compound row only for facets of one decision (model and effort).
  - An inline action button for operations.
  - A value summary and chevron for destinations.
  - A stacked row when the control needs the full width.

  Never hide a choice behind tap-to-cycle.
- **Show the choice when it changes what you see.** Theme, density, avatar, layout and similar
  options use visual tiles whose previews render the real component at static props, never a drawn
  replica. Behaviour settings stay textual.
- **Icons say where a row leads, or who a thing is.** A row that opens another page, and a hub tile,
  carries an icon; a preference row (switch, select, segmented control, inline field, button) does
  not. Identity marks — agents, providers, services, machines, people — always stay. Icons come from
  one family at one size in the secondary text colour, never in a bordered tile, in a fixed leading
  column so titles line up within a section.
- **Rarely changed detail is disclosed, not buried.** A disclosure shows a summary of its current
  value when closed and never hides an error or a required field.
- **Collections scale with depth.**
  - Named things with substantial configuration use a list beside the selected detail on wide
    screens, and push the detail on narrow ones.
  - Shallow collections expand in place.
  - The detail is one component in every mode.
  - Each presentation has its matching detail container: a list opens beside it (list + detail); a
    grid or a board opens a drawer on wide screens so the collection stays visible; phones push.
    Closing returns to the same view with its scroll, filters and search kept.
  - Offer **Grid | List** only where both genuinely help (a default per surface, remembered on the
    device). Never a switch that swaps the whole page's shape.
- **Happier has one card.** Every card in a grid, shelf or board — plugins, suggestions, jobs,
  presets, providers, widgets' pickers — uses the Collection card owner (`CollectionCards` in
  `@happier-dev/plugin-ui`), core and plugin alike:
  - a **header row** the height of the identity mark: the item's logo (catalog mark box, 32) or,
    for a group or a thing without a brand, one glyph at the row-icon size (20) in secondary ink,
    top-left; the **right slot** top-right;
  - the **title** below it (`heading`, one line), then the **description** (`body`, secondary ink,
    up to two lines reserved only for items with descriptions). Truly title-only items keep the
    compact mark-and-title card; no empty description band;
  - one quiet **facts line** at the foot (`meta`, tertiary ink, one line): the kind, then one or
    two facts. Nothing truncates in it: if three facts do not fit at the narrowest card width,
    the third moves to the detail;
  - no footer band, divider, agent strip or second box inside the card. Insets are the card
    padding role, cards sit the card gap apart, the radius is the sheet radius, and the edge is flat;
  - **the right slot says one thing.** An item shows its state when it speaks (Update available,
    Needs review, Added · Sign in) or its quiet add control; a group (a job, a preset) shows the
    marks of what it brings together — at most four distinct marks, never the same mark twice,
    then "+N". Inside a section whose title already names the state (Installed, Needs you),
    the state stays silent;
  - hover paints the fill (colour only); selection is the shared ring; an unavailable card is
    dimmed and still opens. The card opens the item; its right-slot control acts independently.
  A card is a choice to browse and compare a few at a time. Long or scannable sets are rows.
- **Phones recompose rather than shrink.** Only a switch, a short value or a chevron may sit to the
  right of a label; anything wider moves beneath it. A setting that can never apply on a platform is
  not shown there.
- **Everything is findable.** Every setting a page renders is declared for search. A result names
  the setting and its location, and opening it brings the row into view.
- **Status speaks only when it matters.** Healthy items stay quiet. A tinted banner appears only when
  something blocks use, and it carries the next action. A dashed border means "add something here".
- **Every page shares one set of measures.** The content column, the title block, the space between
  sections and the sheet insets have one owner, so the page title, its purpose line, section titles
  and sheets line up on the same edge on every page, inside Settings and out.
- **Back stays out of the title.** The title and purpose, or the leading mark, keep the content's
  left edge; on wide screens the back arrow sits in the gutter beside the column, level with the
  title, and moves onto the title row only when there is no room for it.
- **Glyphs and logos stand alone.** No icon, agent, provider or service mark has a backing tile,
  fill or border. Only avatars and an app icon rendered as an actual app icon are exceptions.
- **Catalog mark decisions happen once at admission, never guessed per render.** One drawing and
  fallback owner serves public packaged marks and the host-only catalog path; public plugin props
  accept no remote URI:
  - **Owned/curated logos.** Choose a symbol instead of a wordmark, trim transparent padding and
    review optical sizing at the asset producer. Without a usable symbol, curate a letter fallback.
  - **Third-party artwork.** Draw as supplied with contain geometry. Preserve declared theme
    variants, including MCP icon `theme`. Never crop unknown images, infer wordmarks from aspect
    ratio or guess contrast.
  - **Declared theme.** Use the matching dark variant; otherwise keep the coloured image. Only
    declared monochrome artwork uses primary-ink silhouette. No guessed silhouette or substitution.
  - **Letter fallback.** Absent, refused or broken artwork uses the first grapheme, bare, in the
    owner's fallback weight and secondary ink, centred in the same box. No plate, disc, tile,
    halo or two-letter badge.
  - Marks come from admitted catalog/contribution or package facts; generic UI never hand-draws
    a brand or branches on an id. Host image display may acquire its selected URI; no render-time
    cleanup or credential forwarding is authorized.
- **Emptiness is designed.** An empty page shows a calm mark without a tile, a short title, one line
  of purpose and one primary action; an empty list or rail says so in one quiet line. A rail and its
  detail never both show the full state. Where a state has room (a page, pane or card state, about
  220 px or taller), the mark is a Daybreak scene: line art on one horizon with the planet as the
  colour, one moment of the day per state, composed from the shared scene library's parts
  (`scene = { horizon, moment, planet, props[], sky[], accent? }`) and chosen by scene id. A scene
  has at most three props on a page, two in a pane and one as a thumbnail; at most one keeps an
  accent; the planet is the canonical dot planet and the only other colour. Plugins never ship
  illustrations: they compose a named scene from the base parts and may add up to two of their own
  single-stroke props through the typed prop slot. It plays once and then rests. Compact lines,
  in-list states, failures and denials keep their text and glyph.
- **One attention colour, a short status vocabulary.** "Needs you" is the attention amber wherever it
  appears (pills, capsules, the status cell, scene beacons, the tray badge); rose means failure only.
  Working is a moving mark, done is quiet, healthy says nothing. Blue is reserved for focus and links;
  green appears only where "live" is the identity of the state (presence).
- **Three row types, chosen by content, never by page.**
  1. **The catalog row** — any described item (Store, Add, Settings kind columns, Installed,
     Found, Needs you), with or without a brand: a bare mark in the 32 leading box when supplied,
     the name (`label`), an optional quiet kind word (`meta`, tertiary; mixed-kind lists only),
     and one description line (`body`, secondary; two on a phone). A speaking status leads line 2
     as its word, never a pill. No dividers or sheet; use
     `HAPPIER_COLLECTION_LIST_METRICS.catalogRow` (60 minimum, rows 2 apart, shared row radius).
     This applies in narrow Settings columns too. A quiet count sits at the end of line 1;
     only a fix or action sits at the row's end.
  2. **The single-line row** — title-only navigation, menus and indexes of names use the compact
     `rowMinHeight` step with the glyph or mark in the shared leading column.
  3. **The preference row** — one decision with its switch, select, segmented control, field or
     button uses the divided page row on a sheet (`Item`, page density).
  A described collection keeps the catalog floor for a peer missing its description and centres
  its title; no invented copy. A title-only navigation group above it stays compact. Narrow rails
  use the shared Collection rule: name, meaningful scope, status and fix survive; description
  yields first. Full text remains in the accessible name, preview and opened detail.
- **Controls are truthful.** A control acting on an empty set is hidden (no "Show archived" when
  nothing is archived). When the viewer cannot take the page's main action, the page says why and
  who can. An action is offered only when every prerequisite for its success holds (sending mail
  needs delivery configured **and** a link it can build); nothing is ever "accepted" and then silently
  dropped.
- **Hubs gather, they don't duplicate.** The app home (the empty main pane) is the primary hub:
  greeting, the start-session box, what needs your attention, setup, machines and usage. Settings →
  Overview is the lighter hub: identity (with the Home and your role), attention, setup as a
  checklist with its progress, machines, usage, security and quick settings, in one column and
  without the greeting or start box; the settings navigation lists the pages, so the Overview does
  not repeat them. Both are built from the same hub sections. A row with no data behind it drops out rather than leaving a hole,
  freshness is stated honestly ("As of …"), opening a hub asks no machine anything, and usage loads
  once, lazily, keeping its last value.
- **Setup steps leave when they are done.** A step disappears once done (for the recovery key, saved
  or dismissed counts as done) and never claims completion it cannot see.
- **The sidebar's foot is the account.** Avatar, name and Home open the Home and account popover, or
  it honestly offers "Link to {service}". Beside it, icon buttons for Usage, Machines, Updates (only
  when one exists) and Settings fold into `⋯` when narrow. One glass "+" starts a new session.
- **No results only for a real search.** A search with a query and no match says so inline, with a
  way to clear it ("No plugins match "x"" · Clear); an empty query never shows "no results".

These are shared, generally named primitives. Plugins compose the same anatomy through the public
plugin UI package; they do not reproduce it locally.

### Catalogs: the Store, Add and Installed

This is the composition intent for the Catalog Store program. Shared primitives are implemented
in 0.3 development source; the following page compositions are design requirements, not a claim
of shipped availability or completed visual acceptance.

Everything Happier can add — apps, software, MCP servers, skills, agents, providers, plugins — is
browsed with one presentation and managed at one home per kind. The Store is where you look;
each kind's home (its Settings page, a Machine's Setup tab, a project) is where it lives; one verb
per kind leads there (Add, Install on…, Deploy…, Use).

- **The Store page.** Its column lists Discover, Installed and Updates, then kinds, then plugin
  pages, with Sources and developers at its foot. Discover is one wide page column, in this order:
  1. the page header (title, one sentence), with a project scope chip when a project is in scope;
  2. one search field across the column, `/` to focus;
  3. **one featured item**: the same card spanning the column, under a section saying why it is featured;
  4. **Suggested for {project}**, only with a project in scope: three cards quoting the facts they
     come from; these items are not repeated further down the page;
  5. **Browse by job**: job cards with a glyph, what you want done, the marks of what does it,
     and "N ways · kinds";
  6. **Happier picks**, then kind/category sections: catalog rows in two row-major columns on wide
     pages, one when a column would be narrower than a row can hold;
  7. each title row ends with "All N ›" for a known count or "All ›"; links to another home say
     where ("Browse in the Store").
  An item appears once per page. No ratings, download counts or popularity. Offline, Installed
  and built-in content remain, with one quiet line for each unreachable catalog.
- **A listing** opens in the details pane beside the page, pushed on a phone: identity header
  (mark, kind · category kicker, name, publisher/verification/version meta), one sentence, the
  kind's one primary action with its consequence, then sheets in task order — what it reaches
  or runs, where it is on, what it needs, versions, source and licence. A fact appears once.
- **Adding in place.** An add needing no review shows working, a confirmed check and any next step
  ("Added · Sign in") where it was pressed, without navigation or layout shift. Apps, software
  and plugins needing review open that existing review anchored to the control; confirmation
  turns it into progress through the owning operation lifecycle.
- **The Add dialog is the catalog at dialog scale.** Search and rows on the left, selected listing
  on the right; the first result is selected when the wide split can show it. The frame keeps its
  size as results change. Catalog/Paste/Custom or Browse/Link/Upload/Write modes swap the body in
  the same frame. Providers, plugins and agents continue to their existing setup. On a phone,
  show the full-screen list first, push the chosen listing, and keep its primary action at the top.
- **Installed** shows what Happier manages across Machines and projects: a present-tense header,
  search and Machine/project filters, then Needs you and one section per kind, grouped by kind,
  Machine or project. Each row says where it runs and opens its home. *What's on this Machine*
  is the same composition scoped to one Machine. Needs you consumes Inbox and Machine attention;
  it creates no second status classifier.
- **Presets** use the same card: a creation preset leads with its provider's mark and price on the
  right; a setup preset leads with its glyph and related marks. Facts lead with Creates the Machine,
  Sets it up, or Creates and sets up. "Add to a preset…" is secondary beside the primary action,
  opening its popover beneath it. Offline software targets are unavailable in the combined review;
  the person runs the operation later, without an automatic queue.
- **The capability homes keep their maps.** MCP's ring and Skills' moons share the orbit-map owner
  with Your Home. They retain the present-tense line, legend and pointer/focus previews. True
  title-only map keys stay compact; described Machine/capability entries use catalog rows.

## Canonical components and ownership

Before creating or changing a user-facing pattern:

1. Inspect the current screen and exercise the real flow.
2. Search for the canonical component, primitive, token, copy pattern, state owner, and analogous flow.
3. Search the touched corridor for duplicated or competing UI, motion, navigation, formatting, and state decisions.
4. Reuse, extend, refine, extract, consolidate, migrate, or remove at the canonical owner before adding another path.
5. Validate that the result remains coherent across every existing consumer.

Split-brain UI is a product defect. Two similar components that differ subtly in loading, errors, accessibility, spacing, motion, or platform behavior create user-visible inconsistency and long-term drift.

Do not over-generalize coincidental visual similarity. Share a component when it represents the same product concept or enforced interaction contract, not merely because two rectangles currently look alike.

Start with the binding implementation rules and owner paths that `apps/ui/AGENTS.md` does name, then search the actual code and nearest package instructions for concepts it does not enumerate. Do not assume that file is an exhaustive inventory, and do not copy a mutable owner list into this doctrine that can drift as the repository evolves.

External design skills and examples are inspiration and review aids. They do not override Happier’s canonical primitives, tokens, architecture, platform contracts, accessibility rules, or measured evidence. Do not paste generic magic values or add a new dependency when the existing system owns the behavior.

## Onboarding as a reference, not a universal template

Happier’s current and evolved onboarding direction establishes the product-wide principles below. Not every repository version implements every technique yet; inspect the actual local code before treating an example as reusable infrastructure.

- a warm brand introduction followed by a clear functional workflow;
- persistent wordmark, atmosphere, and composition anchors;
- one-time delight that does not obstruct returning or urgent flows;
- different but equivalent mobile and desktop compositions;
- context-aware first-time and returning-user hierarchy;
- a product story before configuration;
- truthful product storytelling that prefers real product surfaces with safe representative state when the repository supports it;
- one journey owner across authentication and setup boundaries;
- visible skip, back, replay, and recovery agency;
- motion used to focus attention and preserve continuity.

Generalize those principles, not all of the machinery.

Keep these techniques limited to signature storytelling unless another use has equivalent evidence:

- long cinematic sequences;
- word-by-word narration on every transition;
- large camera moves and repeated zooms;
- pervasive cosmic backgrounds;
- automatic feature reels;
- demo-world state seeding and firewalls;
- locally art-directed motion/color tokens;
- randomized welcome copy.

If onboarding infrastructure is reused for release notes, guided tours, help, marketing capture, or previews, reuse the existing canonical stage and surface owners. Do not create another demo system.

## Design workflow

The step-by-step method, taste rules, owner map and review checklist that apply this doctrine live in
`.agents/skills/happier-ui-craft`.

### 1. Understand

- Identify the person, context, task, frequency, urgency, and consequence.
- Observe the current flow and inspect adjacent states, platforms, and existing patterns.
- Name the primary user outcome and the emotion the experience should reinforce.
- Identify the canonical state, navigation, component, copy, and visual owners.

### 2. Frame

Before implementation, state:

- the one primary purpose;
- the expected first-time and returning-user paths;
- the action hierarchy;
- the important states and failure/recovery paths;
- what should persist across transitions;
- the platform-specific composition decisions;
- the appropriate motion intensity;
- the two or three most consequential experience risks.

### 3. Explore

- Consider materially different compositions when the current hierarchy is unclear.
- For novel or materially uncertain gestures, motion systems, complex navigation, or signature experiences, validate interaction in a working surface because static frames cannot prove feel. Prefer prototyping directly in the real product; create a separate prototype only when it reduces uncertainty without duplicating production architecture or becoming a competing implementation.
- Compare variants in the real surrounding product, not on isolated blank canvases.
- Prefer one strong, coherent direction over a collage of fashionable effects.

### 4. Implement

- Build on canonical primitives and owners.
- Keep visual and interaction design together; do not postpone motion, states, accessibility, and responsive behavior until after the “main” UI.
- Match implementation complexity to the experience value and frequency.
- Preserve performance and input responsiveness from the beginning.

### 5. Validate live

Inspect the rendered result rather than inferring design quality from source code.

Validate the relevant matrix:

- mobile, web, and desktop surfaces affected;
- touch, pointer, keyboard, and screen reader input;
- light and dark themes;
- first-time, returning, empty, populated, loading, stale, offline, error, retry, and success states;
- narrow, short, wide, rotated, resized, keyboard-open, and large-text layouts;
- long translations and representative real data;
- reduced motion, increased contrast, and reduced transparency where supported;
- slow or interrupted network and delayed background work;
- repeated use, not only the first impressive run;
- render scope, responsiveness, scroll behavior, and animation frames when performance-sensitive.

#### Design QA evidence matrix

For substantive work, record the applicable dimensions rather than implying whole-product coverage:

| Dimension | Evidence to collect |
| --- | --- |
| Goal and hierarchy | The intended outcome, primary action, alternatives, and exit are clear in every material state. |
| Continuity | Refresh, navigation, retry, resume, resize, and handoff preserve the right state, focus, and position. |
| State | Reachable loading, populated, empty, partial, stale, failure, recovery, and completion states were exercised. |
| Content | Representative volume, long names, code, paths, URLs, translations, and malformed or missing data were considered. |
| Mobile | Small and large phones, safe areas, keyboard, touch targets, thumb reach, rotation, and back behavior were checked where affected. |
| Desktop and web | Narrow and wide windows, resize, zoom, pointer, hover, keyboard, focus, and window chrome were checked where affected. |
| Accessibility | Screen reader semantics, focus order, text scaling, contrast, non-color meaning, and reduced motion were checked. |
| Motion | Immediate response, spatial origin, interruption, reversal, exit, repetition, and reduced-motion behavior were inspected. |
| Performance | Input latency, rerenders, scrolling, layout shift, frame behavior, memory, and representative data were measured according to risk. |
| Copy | Language is warm, specific, localized, honest about state, and appropriate to the consequence. |
| Ownership | Canonical primitives and state owners are reused; no same-concept UI, motion, copy, or token split-brain remains. |

For motion, inspect at normal speed and frame-by-frame or slowed down. Look for flashes, jumps, stale frames, mismatched origins, velocity discontinuities, clipped shadows, late focus, and input lockout.

### 6. Review and refine

Ask:

- Is the primary purpose immediately clear?
- Does this feel warm, fluid, calm, and distinctly Happier?
- Is it premium through craft, or merely decorated?
- Does motion explain and respond, or distract and delay?
- Did we preserve agency, state, focus, and continuity?
- Is the mobile experience genuinely first-class?
- Did we reuse the canonical product surface and avoid split-brain UI?
- Are all meaningful states designed?
- Does the experience remain good with accessibility preferences and real data?
- Is the implementation complexity justified by durable experience value?

## Common failure modes

Reject or revisit designs that exhibit:

- generic assistant-product aesthetics with no Happier-specific point of view;
- “minimalism” that removes hierarchy, context, or discoverability;
- excessive cards, pills, glass, borders, glows, or gradients without semantic purpose;
- dense settings or dashboards where every control has equal emphasis;
- mobile layouts that are merely compressed desktop screens;
- desktop layouts that waste space because they are enlarged mobile stacks;
- hover-only actions or tiny hit areas;
- controls, rows or spacing drawn larger only to meet a touch target;
- animation that blocks input, restarts on interruption, replays because of incidental remount churn, or repeats signature choreography in a high-frequency workflow;
- long transitions on frequently repeated actions;
- moving, blinking, scrolling, or auto-updating content that lacks controls when required by the accessibility baseline, or nonessential ambient updates that distract from the user’s work;
- loading flashes that erase useful state;
- optimistic UI that hides uncertainty or failure;
- random friendliness in errors, security, or destructive flows;
- unverified claims and marketing copy that overpromises behavior;
- new components that duplicate canonical primitives;
- handmade lookalikes of an existing primitive (a second card, field, picker or state) instead of
  extending its owner;
- surface-local edges, greys, radii or shadows instead of the material and ink roles;
- calling a surface done from tests or a description without a side-by-side render against its
  approved lab in light, dark and phone;
- abstractions created only to enforce visual sameness across different product concepts;
- performance fixes that regress continuity, accessibility, or freshness;
- polished happy paths surrounded by unfinished empty, error, offline, and recovery states.

## Definition of design-complete

A user-facing change is design-complete only when:

- its purpose and action hierarchy are clear;
- it follows the Warm and Fluid Companion voice and experience principles;
- canonical components, tokens, owners, and copy patterns were reused or intentionally evolved;
- mobile, web, and desktop implications were considered and affected surfaces validated;
- meaningful loading, empty, populated, pending, success, failure, offline, permission, and recovery states are handled;
- focus, keyboard, screen-reader, text scaling, contrast, and reduced-motion behavior are appropriate;
- motion is purposeful, interruptible where interactive, and proportionate to frequency;
- state and visual continuity survive refresh, navigation, resizing, reconnection, and relevant handoffs;
- performance was measured or credibly assessed according to risk without sacrificing experience;
- the rendered result was inspected in its real context;
- remaining validation gaps and risks are reported honestly.

The standard is not “looks polished in one screenshot.” The standard is a coherent, delightful, trustworthy experience across time, state, input, platform, and repeated use.
