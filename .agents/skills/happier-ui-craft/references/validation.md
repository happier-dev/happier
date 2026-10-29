# Validation and review

## Reference first

- A new or reworked surface starts from a reference: a design-lab page
  (`.happier/design-lab/<program>/`, plain HTML using the product's real theme values, several
  variants side by side, a note per variant saying why it is better or worse), or the closest shipped
  Happier screen.
- Study real products for how they solve the same problem (list+detail, identity headers, quiet
  status), then decide in Happier's language; never copy an app's look.
- Record the chosen variant and the reason where the work is planned. The reference is the
  acceptance target.

## Ground truth before design

- For any surface backed by a service or contract, first write a short table of what the contract
  really offers (capabilities, states, methods, data), marking each item shipped, preview or planned.
  Designs show only what exists; future items are labelled or left out.
- Establish which settings are account-level and which depend on a scope (machine, Home) from the
  code, before deciding what waits on a picker.
- Check what the dev stack can show: an account without machines, a service that does not advertise
  a capability, no real email. List the states you could not see live and how they are covered
  instead (tests, a different account's browser state).

## Side-by-side acceptance

The live screen is not done because it "looks fine". It is done when it matches the reference or
every difference is explained.

1. Render the reference and the live screen in the same state, theme and size
   (`render.mjs` in the lab; Playwright against the dev web UI).
   - **Pair against the scene, never the board.** Labs contain explainer/overview boards (system
     summaries, key tables, feasibility notes) as well as scene frames drawn inside the shipping shell
     (`shots/<concept>-<frame>-<theme>.png`). Only a scene frame is a reference for a live page. Open the
     chosen reference image before comparing; a pair whose left side is a board proves nothing
     (find-search-prompts R18 paired the live chat with the "One language" board for weeks).
   - **Same state or no pair.** A live loading skeleton, empty account or error screen next to a
     populated lab scene is not a comparison and never counts as partial evidence. If the live surface
     cannot reach the lab's state, the design gate is blocked by that functional cause: fix or escalate
     it first, then compare.
2. Put them in one image, reference left, live right, and compare region by region: header, each
   section, each row, spacing rhythm, weights, colours, icons, alignment, empty space.
3. Do it for light, dark and a 390px phone, and for the states that matter (loading, empty, offline,
   error), not only the populated one.
4. When something "looks flat" or "has no background", sample pixel colours in both images instead of
   guessing, and map the difference to a token. Check the edge too: which side carries it, whether
   the border is ink, and whether a floating surface has its role's edge (rim at whisper strength).
5. List every remaining difference with its reason: data not available on this stack, deliberate
   decision, platform limit, or not yet fixed.

## Lab fidelity pass (program-level)

Run this whenever a program has built surfaces from a design lab, and again before handoff. Its
scope comes from the surfaces the program touched, not from a list of earlier findings.

1. **Inventory first.** List every surface and state the program touched (page, panel, sheet, row
   family, popover; empty, populated, long, error, phone). Pair each with its lab scene or the closest
   shipped reference, and mark surfaces that have none. A surface missing from the inventory has not
   been verified.
   Before `DONE`, checklist every plan row and lab element for the surface: built, ruled out (with authority), or owed. Any owed item keeps the surface incomplete.
2. **Real, heavy data.** Render with the program's real saved objects, not only fixtures. Include
   the longest and deepest examples (built-ins, nested loops and conditions, long names, real ids,
   several steps), plus at least one object created through the live flow. Also render the sparse
   state a real account actually has (a few days of data, unknown cost, partial sources). Lab
   datasets are dense and fictional, so sparse, unknown and partial data is where hierarchy usually
   collapses.
3. **Viewports.** Use the lab's width, a wide desktop (≥ 1920 and an ultra-wide around 2560, because
   stretched layouts only show there), and a 390 px phone. Also check each width where the layout
   recomposes, just above and just below it: an aside drops, columns merge, or the phone form takes
   over. Shared row rules and page columns break there, not at the lab's width. Check light and dark.
4. **Measure, don't eyeball.** Read the rendered values (computed styles or DOM boxes through
   Playwright, pixel samples for colour) and compare them with the lab:
   - **Frame:** content column max width, page gutters, header extent and wrapping, right margin.
   - **Grid:** the shared left edges (number, title, card, meta line), rail and connector x-positions,
     nesting indent.
   - **Type:** family, size, weight, line height and colour role for title, body, meta and chips.
   - **Rhythm:** gaps between blocks, card padding, row heights, chip and control heights.
   - **Surfaces:** fill, border and edge strength, radius, elevation.
   - **Elements both ways:** every live element exists in the lab or is a recorded refinement, and
     every lab element exists live or is a recorded omission. Duplicate renderings of one fact are
     defects.
   - **Content:** no raw ids, enums or hosts; no text shown twice; nothing clipped or overlapping.
5. **Classify every difference.** The lab is the design intent, not a pixel contract. Each
   difference is exactly one of:
   - **defect**: fix it at the owner;
   - **accepted refinement**: implementation needed something the lab didn't show, or found a better
     answer; record the reason, and it must meet the same craft bar;
   - **lab outdated**: update the lab scene so the reference stays true.

   Write the classification next to the comparison in the program's review report; don't create a
   separate ledger.

   A difference from the lab is never a reason to add a second component, variant or style path for the
   same concept. Fix the shared owner (reuse, extend, refactor), keep improvements that are better
   than the lab and record them as refinements, and consolidate any duplicate or similar-but-different
   implementations you find.

   Never resolve a difference by creating a duplicate, competing or similar-but-different component,
   style or logic path. Either the shared component is right (accepted refinement), or the shared
   component improves for every consumer. Keep good improvements other work already made to shared
   components, updating the lab instead, and contract any duplicates you find into one owner.

   **Fix through the shared owner, never around it.** When a difference comes from a shared component
   or primitive (row, chip, card, popover, field, header), the choice is only:
   - **refine the shared component** for all its consumers, after checking those consumers and
     keeping their behaviour intact; or
   - **accept the difference** as a refinement.

   Never make the screen match the lab by building a local lookalike, a one-off style override, or a
   similar-but-different component or logic path. Matching through a fork is a defect, even if the
   pixels match. Reuse, extend, extract or refactor the existing component instead.

   **Keep other lanes' step-ups.** Before changing a shared component, read its current bytes and
   recent history. An improvement another lane made that's better than the lab is an accepted
   refinement; keep it, and update the lab if it should become the reference. Don't regress it to
   match an older scene.

   **Contract what you find.** If the comparison exposes two components, presenters or state owners
   for the same thing (two renderings of one condition, two rows for one fact, two decision paths),
   unify them onto one owner and delete the other, rather than styling both.

6. **Live, not only source.** Compare a source-rendered capture with fixtures to the lab only as an
   intermediate check. The acceptance pass uses the loaded runtime with real data. First confirm
   what the browser is running: a stack that serves a static web export or an old bundle doesn't
   show source edits, so a pair taken from it verifies old bytes. Record the UI basis (the live dev
   bundler on current source, or which export) next to each pair.
7. **An unseen change stays open.** A lane that changed a surface but could not render it reports
   it as "visual: not seen" with the exact page and state. Passing tests, a later lane's partial
   capture or a "styling-only" label never close it; only a whole-page live pair does. Dev fixture
   routes and component boards are intermediate evidence, never acceptance.
8. **Capture what the user sees.** Wait for hydration, theme and animation to settle, and confirm
   the theme from the pixels, not the filename. After every viewport change, wait for two animation
   frames and confirm the captured surface's bounding rect is stable before the capture counts as evidence.
   A headless or software-composited browser cannot
   show blur, backdrop or glass correctly; mark those regions unverified and check them in a
   GPU-backed browser or on a device rather than accepting or redesigning from a flat capture.

9. **Whole page before parts.** Start every surface with a full-page pair at the same viewport: the
   whole lab scene next to the whole live page, not a crop of one component. Judge the page as a
   composition first: what draws the eye, hierarchy, density, rhythm and whitespace, how the sections
   sit together, whether it reads as the same calm, premium product. Only then zoom into regions and
   measure. A component that matches its lab crop does not make the page right; component crops never
   close a surface.
10. **Degraded states are surfaces.** Offline or unreachable machines, missing permissions, load
    failures, loading and empty states get the same pass as the populated page. One cause is shown
    once, at the level that owns it (an unreachable checkout is said once for the checkout; its widgets
    inherit it), through the shared state components. Several widgets each failing in their own style is
    a defect even when every message is true. When the lab has no scene for a state, design it with this
    skill and record it as an accepted refinement.
11. **Content that looks real.** Judge pages with plausible content. Raw QA leftovers (dozens of test
    drafts, duplicated tabs, retired machines) can hide or fake defects; tidy the account or seed
    realistic objects through the product before judging, and say which you did. If the flow that
    normally creates them is broken (for example, a clone refuses), seed through another real product
    path, such as opening an existing folder, so the design pass isn't held up by an unrelated
    defect. Report the broken flow to its owner.

## Building a designed page

These rules come from the Teams/Home program (2026-10-11). Every finding list was closed, yet the pages still drifted from their labs. They extend "Who verifies" above.

- **Brief the page.** A build or fix brief names:
  - the page and every lab scene and state for it;
  - the user's own words about it;
  - the refinements already accepted.

  Findings from reviews are inputs, not the scope.

- **Parallel lanes don't compose a page.** While one lane owns a page's composition, other lanes that need the page supply data, hooks and logic and leave it a mount point; they don't restyle or reorder it. When five lanes edited the same screens at once, the result was a patchwork that nobody had looked at as a whole.
- **Translate the lab's scale; don't copy it.** Labs are HTML. Map each lab gap, size and weight to the product's spacing, type and material tokens. Then measure the rendered result against the lab's rhythm. A page with the right structure but the wrong rhythm is what reads as generic rather than premium.
- **Reach the lab through the shared components; never fork them to match it.** If a shared component differs slightly from the lab, either improve the shared component for all its consumers or record the difference as an accepted refinement. A lab-shaped local copy is a defect. Build on recent improvements other lanes made to shared components rather than reverting them, and when you find duplicates, merge them into one owner.
- **An older build is not evidence.** Screenshots from before the latest changes don't verify a page, and neither do source-level comparisons of lab markup with components. Until the current build has been rendered and compared, the page stays `IMPLEMENTED_NOT_VERIFIED`. A component specimen (for example `/dev/plugin-ui`) with fixture data proves a primitive, never the composed page.

## Review checklist

Run it on the rendered screen, not the code.

**Hierarchy**

- [ ] The first thing on the page is its identity or purpose.
- [ ] One primary action; secondary and destructive actions are visibly different and destructive is
      last.
- [ ] Sections ordered by task, not by data model.
- [ ] Healthy state is quiet; every warning carries its next action.

**Anatomy**

- [ ] Page header present; sentence-case section titles with descriptions above the rows.
- [ ] No uppercase group labels, no footers after rows, no decorative icons on preference rows.
- [ ] Sheets are visibly separated from the page (tint + hairline) in light and dark.
- [ ] Controls match the decision table; no tap-to-cycle, no dropdown for 2–3 options.
- [ ] Wide collections always have a selection; phones push details.

**Copy**

- [ ] Sentence case; no repeated words across siblings; no raw hosts, ids or enums.
- [ ] Each description adds information; no two strings say the same thing.

**States and stability**

- [ ] Opening the page moves nothing; refresh keeps last-known data.
- [ ] Containers keep their size as content changes.
- [ ] Loading, empty, offline, error and success states are designed.
- [ ] Only scope-dependent parts wait on their scope.

**Platform and access**

- [ ] 390px phone: nothing wide sits beside a label; nothing hidden under the tab bar or keyboard.
- [ ] Keyboard order equals visual order; focus lands somewhere useful on open.
- [ ] Every control has an accessible name and role; hit areas meet the target without making any control drawn larger (a control, row or gap drawn bigger than the design to reach a touch target is a finding; the touch target is the hit area, see the taste digest); reduced motion works.
      Probe it live with `node apps/ui/scripts/qa/hitAreaProbe.mjs --session <name>` (every `[data-happier-hit-area]` frame pairwise: zero overlaps; every frame edge the browser hit-tests as its control, so no clipping box cuts the reach off; nothing drawn under 24 px without a hit area) on phone (coarse pointer) and desktop.

**Truthfulness**

- [ ] No form that cannot succeed; prerequisites say what is needed first.
- [ ] Unavailable services explain what they are for and offer the next action.
- [ ] Only contract-backed capabilities are shown; planned ones are labelled.

**Ownership**

- [ ] Every element came from its canonical owner; nothing duplicates an existing component.
- [ ] Every rendered setting is declared for search.

10. **Verdicts that are not passes.** The following wordings describe a coverage gap, not
    acceptance. They keep the surface owed:

- "generic anatomy accepted";
- "first fold only";
- "renderer only";
- "the lab shows a different state";
- "not a pixel or exact-fidelity claim";
- "tests pass";
- "settled".

When the lab shows a different state, seed the matching state through the product, or compare
the design language explicitly. That language is frame, grid, type, rhythm, surfaces and element
inventory, measured as in step 4. Record each difference as a defect, an accepted refinement or a
lab update. Capture the full scroll height, not only the first viewport. A surface counts as
checked only when someone other than its author, an Opus design lane or the orchestrator, has
looked at its full-page pairs.

## From lab to product (2026-10-11)

Labs are good because one designer composes a whole page in one pass, at one scale, and nothing gets added afterwards. Keep those three properties when building:

- **Shell first.** The design lane builds the approved variant in the app first: the real shell, the shared components, fixture data, every state and the motion. Functional lanes then wire data and Actions behind it. Start from a short table of what the backing contract really offers, so the shell has no controls without a real capability behind them. Wiring into a well-composed page beats polishing a functional one.
- **Show the lab, don't describe it.** A brief for visual work points at the scene images and the rendered lab. The lane opens them before touching code. Decision ids and finding lists drop the proportions and rhythm that carry the quality.
- **Element budget.** When a functional change needs a new visible element (chip, toggle, notice, label), it fits into the page's existing structure. If it doesn't fit, the page's composition owner decides what it replaces. Adding another pill is never the default.
- **Missing scale roles.** Until owned type, spacing and layout roles exist, map each lab value to the nearest existing token. Note in your report where a missing role blocks a clean match. Don't add new one-off sizes.
- **Accepted shots.** When a surface is accepted, keep its full-page light, dark and phone shots in the lab folder (`shots/accepted/<surface>-<state>-<width>-<theme>.png`). Later lanes compare against them. They are review references, not a pixel-diff gate.

## Delegating UI work

- **Functional lanes that touch a designed surface** load this skill too. This covers adding a
  control, filter, banner, state or column. Place the element in the reference's anatomy (for
  example, a new filter goes into the lab's search tokens or filter rail, not as another toolbar
  pill), then either attach a before/after capture or record "visual pass owed: <surface>". The
  orchestrator turns every owed pass into a design lane; it is never dropped silently.
- **Composition is fixed by a lane that has the taste layers.** `make-interfaces-feel-better` and
  `interface-details` are Claude Code user skills. Codex and other non-Claude lanes cannot load them,
  and a brief that tells them to load these skills is silently ignored. Route spacing, hierarchy,
  rhythm, surface and motion changes, and every design-review finding, to an Opus lane. A Codex lane
  may fix the behaviour inside a finding, and in that case it records "visual pass owed". This file and
  `premium-feel.md` are the portable core for every lane.
- **Design review judges design.** A design round starts from full-page pairs and gives a page-level
  verdict on composition and feel. Functional defects it meets go to the functional QA lane in one
  line each. A round whose findings are mostly navigation, state or data bugs has not reviewed the
  design. Don't let a numbered punch-list replace the page verdict: closing every item does not make
  a page premium.
- **Match a lab through the existing components, never around them.** When a lab element differs
  slightly from a generic component, the generic component wins and the difference is an accepted
  refinement. When the lab's version is better, refine the generic component for every consumer and
  check them. Never create a page-local look-alike or a one-page variant. Keep improvements other lanes
  made to shared components; extend them rather than reverting to the lab.
- **A verdict covers the bundle it saw.** A UI-touching change that lands after the last design
  verdict reopens the surfaces it touched, even when the change was functional (a new control, state,
  tint, menu or copy).
- **Render path before building.** A lane that builds a surface first secures a live render path it
  can reload: a loaded QA stack with real data, or the dev web UI. A QA stack's static web export
  refreshes only on restart, so for source edits use the dev stack's Metro-served UI with `?server=`
  pointing at the QA server, and record which bundle each pair shows. It then builds section by section
  inside that loop. If no path exists, establishing one is the lane's first unit. Building whole pages
  blind and promising a later check is how pages drift from their reference, so "implemented, not
  verified" is never a resting state for a visual round: the lane's next unit is its render.
- **One composition owner per page.** When several lanes contribute tabs or sections to one page or
  page family, one design lane owns the composed page: header, tab container, density, rhythm and
  spacing across the tabs. It reviews every contribution inside the composed page, not in isolation.
- **One component per concept; the lab never justifies a fork.** Never create a duplicate, competing
  or similar-but-different component, style or helper just to make a screen match its lab, and never
  hand-roll a local copy of an existing component.
  - **When the canonical component differs only slightly from the lab,** keep the canonical one and
    record it as an accepted refinement.
  - **When the lab's version is a real step-up** (clearer hierarchy, better rhythm, nicer motion),
    improve the canonical component itself, as a variant, token, prop or refactor, so every consumer
    benefits. Check those other consumers in the render loop before calling it done.
  - **A reuse that lowers the look** is a defect to fix in the owner, not an excuse for a fork.
  - **Don't undo other lanes' work.** Preserve improvements other lanes made to shared components;
    a refinement layers on them unless it is clearly better, and the reason is recorded.
  - **Contract duplicates you meet** in the touched corridor (two formatters, two row variants for one
    fact, local style copies) into the canonical owner, and migrate their consumers.
- **Keep design lanes on design.** Compile closure, gate attribution and partition chores go to
  non-design lanes. A design lane whose context was spent on that work hands visual verification to a
  fresh design lane.
- **The lab is the intent, judged as a whole.** Briefs say so explicitly. Lanes judge each page
  against the reference as a page, then record refinements. They never reproduce cell by cell, and
  never stop at "the components match".

- Give each lane the reference (lab concept or shipped screen), the side-by-side acceptance rule, the
  owner map and the explicit decisions already taken; ask for a per-gate report and the list of
  states not seen live.
- Re-derive a lane's claims before accepting them: rerun its tests on current files, look at its
  screenshot pairs, and check any shared owner it changed (focus, popover, list rows) across other
  consumers. A failure is the lane's only if it disappears without the lane's change.
- A lane that changes what a surface looks like renders it before committing and compares the whole
  page with its reference. Data or wiring lanes that cannot render must not change visual composition;
  their surface work goes to a lane that can see it. A surface committed without ever being seen
  rendered is not done.
- Design findings are fixed, not parked. A finding owned by another lane goes to that owner with the
  page pair attached and is tracked until it is fixed or explicitly accepted; "reported for its owner"
  is not a closed state.
- The reviewer accepting a surface looks at the full-page pairs themselves, not only the lane's
  summary or its component crops.

## A live render path that shows source edits

Source-runtime QA stacks (`--runtime=source`) borrow the dev stack's Expo by default; a browser
reload shows current UI source. If dev Expo is down, park UI/QA-UI with `Expo READY` as the resume
trigger; server/daemon starts and reloads continue normally. Stack info shows UI `waiting for dev Expo`
and detects recovery without a consumer restart. Never start a competing Metro or export as fallback.

- Borrow the checkout's running Metro (the dev stack's Expo), pointed at the QA stack's own server:
  `http://<qa-stack-host>:<producer Expo port>/?server=http://<qa-stack-host>:<qa server port>&happier_hmr=0`.
  This is the stack's default borrowed mode (`apps/stack/scripts/runtime/shared/borrowed_expo.mjs`).
  It only consumes the producer's bundle and never starts, stops or reloads the producer.
  Server and Account/stack URLs remain runtime parameters, outside the bundle URL/identity.
- Record which UI each capture came from (frozen export id, or borrowed Metro plus the time). A pair
  taken from the frozen export verifies the bytes from its build time, not your edit.
  Use `--ui=export` only for explicit release/boundary acceptance; unchanged inputs/options reuse
  the completed export through the existing publication owner.

## Interaction and motion are part of fidelity

Still images miss most of what makes a page feel premium. For every designed interaction, capture
it as a short frame sequence or recording and compare it with the lab's prototype or its motion
notes. Designed interactions include:

- hover and press;
- focus ring;
- a menu or popover opening;
- a sheet presenting;
- drag lift, the drop indicator and settle;
- organize or edit mode entering;
- a card resizing;
- the loading → content swap.

Check that:

- nothing jumps or flashes;
- the indicator sits where the drop will land;
- a popover grows from its trigger;
- reduced motion still communicates the change.

Interaction-heavy features (drag and drop, organize, Add flows) aren't verified by screenshots alone.

## Shared primitive changes are page changes

A change to a shared primitive is a visual change to every page that uses it. Examples: the ⋯ menu,
popover, card frame, group header, tab strip, glass material and overlay layering. Its author lists the
consuming pages and takes a whole-page pair of each major family, not only the page that prompted
the fix.

## Fidelity without forks

Matching a lab never justifies a second component.
- **Where to fix a difference.** When a shared component differs from the lab, either refine that component at its owner, so every consumer gains, or record the difference as an accepted refinement. Never add a similar-but-different copy, a page-local restyle or a call-site override.
- **Keep improvements that are better than the lab.** Other lanes may have improved a shared component beyond the lab. Keep those improvements, and classify the lab as outdated rather than reverting them.
- **Merge competing versions.** When a page shows competing versions of one element (two card frames, two menu styles, two empty states), merge them into one owner and migrate every consumer.
