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

Do not spread a signature visual device across the entire product until it loses meaning. The onboarding planet, cinematic stage, word-by-word narration, and demo-world machinery are references for experience quality, not default app chrome.

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
- Treat light and dark themes as designed experiences, not mechanical inversions.
- Use accent color deliberately to guide attention, show state, or create a signature moment.
- Do not use color as the only carrier of meaning.
- Preserve legibility over gradients, images, blur, transparency, terminal colors, diffs, and syntax highlighting.
- Keep provider- or agent-specific colors owned by their canonical contribution or registry rather than branching in generic UI.

Art-directed imagery and narrative surfaces may need locally owned visual tokens. Keep them in one named, domain-owned, theme-aware token module under the bounded exception in `apps/ui/AGENTS.md`; feature components must not scatter raw values. Document why global semantic roles are insufficient, define light/dark and accessibility behavior, and do not create a competing app-wide design system.

### Typography

- Use Happier’s canonical text primitives and typography tokens so scaling, platform rendering, theme, and localization continue to work.
- Build hierarchy from size, weight, leading, tracking, color, and spacing as a coherent set.
- Large display text may use tighter leading and tracking; body and dense UI text prioritize legibility.
- Keep headings concise and balance short headings on platforms that support it.
- Avoid orphaned final words in short descriptive copy when platform primitives allow appropriate wrapping.
- Use tabular numerals for changing counts, timers, quotas, usage, aligned metrics, and numeric tables to prevent visual jitter.
- Never truncate information necessary to distinguish sessions, machines, providers, branches, paths, or errors without an accessible way to reveal it.
- Test long translations, mixed scripts, large text settings, and narrow viewports.

### Spacing, shape, and alignment

- Use the existing spacing, radius, size, and layout tokens or primitives.
- Repeated spacing values should express a rhythm, not a collection of nearby guesses.
- Nested rounded surfaces should appear optically concentric when they represent layers of one object.
- Align icons optically, not only mathematically; asymmetric symbols often need correction.
- Keep icons and labels visually balanced and baseline-aligned.
- Avoid creating every grouping as a rounded card. Use proximity, whitespace, headings, dividers, background regions, and elevation according to meaning.
- Borders separate dense structure; shadows and material can express depth. Do not substitute one mechanically for the other.

### Materials, elevation, and glass

- Use translucency to express a floating functional layer or preserve spatial context, not as a default decoration.
- Ensure text and controls remain legible over changing backgrounds.
- Do not stack multiple light translucent surfaces until hierarchy and contrast collapse.
- Larger or higher surfaces may use stronger separation than small controls.
- Pair modal tasks with appropriate focus treatment; do not dim the world for parallel, non-blocking work.
- Material transitions should feel like the surface arrives and departs, not like arbitrary opacity toggles.

### Icons and imagery

- Use the existing icon system and canonical product imagery before introducing a new visual family.
- Icons communicate familiar actions; labels remain necessary when meaning is not immediately predictable.
- Do not use icon-only controls without accessible labels and adequate hit targets.
- Keep decorative imagery non-interactive and out of accessibility traversal where appropriate.
- Use subtle separation for images placed against variable backgrounds when needed, without tinting edges unnaturally.

## Interaction and agency

- Feedback begins immediately, while commitment happens at the correct semantic point.
- Preserve cancellation when a press or gesture moves away before commitment.
- Keep interactive hit targets generous and non-overlapping across touch and pointer layouts.
- Support keyboard focus, activation, dismissal, traversal, and shortcuts where the platform permits.
- Focus indicators must remain visible against every supported background.
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

Do not treat empty, error, or loading states as visual leftovers. They often define the user’s trust in the product.

## Accessibility is a design input

Accessibility shapes the primary design rather than providing a parallel version.

The baseline is WCAG 2.2 Level AA for applicable web, desktop, and native behavior, plus the accessibility conventions and APIs of each target platform where WCAG does not directly specify the interaction. Use the stricter applicable requirement when standards overlap. If a platform cannot expose or honor a required preference, document the gap and provide the safest available equivalent rather than silently treating it as supported.

- Support screen readers with correct roles, names, state, order, and announcements.
- On web and desktop, support text scaling to 200% without loss of content or functionality except for applicable WCAG exceptions. On native platforms, support Dynamic Type according to platform conventions while keeping the content and actions needed to understand, operate, and recover from the flow available.
- Meet applicable WCAG contrast requirements in light, dark, increased-contrast, transparent, image-backed, diff, and terminal contexts; meaningful non-text UI and focus indicators need contrast as deliberately as text.
- Provide keyboard access and visible focus on web and desktop.
- Do not rely on color, hover, animation, spatial position, sound, or haptics alone.
- Honor reduced motion and reduced transparency throughout a complete flow, not only in isolated components.
- Target at least 44×44 points on iOS and 48×48 dp on Android for touch interactions, using the stricter applicable platform or canonical-primitive requirement elsewhere. Keep targets from overlapping; dense pointer layouts must still meet applicable WCAG target-size requirements and remain keyboard accessible.
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
- hover-only actions or tiny touch targets;
- animation that blocks input, restarts on interruption, replays because of incidental remount churn, or repeats signature choreography in a high-frequency workflow;
- long transitions on frequently repeated actions;
- moving, blinking, scrolling, or auto-updating content that lacks controls when required by the accessibility baseline, or nonessential ambient updates that distract from the user’s work;
- loading flashes that erase useful state;
- optimistic UI that hides uncertainty or failure;
- random friendliness in errors, security, or destructive flows;
- unverified claims and marketing copy that overpromises behavior;
- new components that duplicate canonical primitives;
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
