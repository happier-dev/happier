---
name: happier-ui-craft
description: Happier's working method and taste for designing and building user-facing UI — information hierarchy, page and section anatomy, control choice, visual choices, collections, copy, states and layout stability, motion, phone recomposition, and the reference-first, side-by-side validation loop. Use before designing, building, or reviewing any Happier screen, component, flow, or plugin UI; it turns DESIGN.md doctrine into concrete decisions.
---

# Happier UI craft

## Every UI change: look, compare, fix (mandatory, before commit)
1. Open the reference: the lab scene image (not a board) or the shipped/0.2 screen.
2. Render your change while building: the surface's `/dev` specimen for each state you touch
   (add the state there if missing), then the real page in its shell.
3. Capture the whole page at 1440 and 390, light and dark, same state as the reference.
4. Put reference and live side by side and write every difference (frame, grid, type, rhythm,
   surface, elements both ways, copy). "Looks fine" is not a list. Fix defects at the owner.
5. Commit with the four frames + the list in your report. Can't render? Report `BLOCKED: render
   path (<what failed, when>)`; do not mark the look owed and move on.
6. A fresh reviewer judges your frames against the reference before the corridor closes.

Specimens mount the real owner components with fixture data from the shared testkit
(`@/dev/testkit`); they never copy a component's layout or styles.

`DESIGN.md` says what Happier should feel like and why. This skill says how to get there, screen by
screen. It is the Happier-specific layer; generic design skills (`make-interfaces-feel-better`,
`interface-details`, `apple-design`, …) are accelerators below it and never override it.

UI lanes load [`references/taste-digest.md`](references/taste-digest.md) by default. Open a full
taste skill only for a specific question; this skill and `DESIGN.md` win on conflict.

Values live in code, not here. Sizes, weights, spacing, radii, colours and durations come from their
owners (see `references/components.md`). When this skill says "the page header" or "a hairline", it
means the owner's value; never copy a number from this file into a component.

## The five questions before any pixel

1. **Who is here, how often, and why?** A page opened daily for one toggle is not a page opened once
   to set up an account. Frequency sets density and motion; consequence sets friction.
2. **What is the one thing this surface is for?** Write it as the page description, one sentence. If
   you cannot, the page is two pages or a section of another.
3. **What does the user need to know first?** Identity ("which account, which Home, which machine"),
   then anything that blocks use, then the controls they touch most, then rare detail, then
   destructive actions last.
4. **What does each control change, and can they see it?** If a choice changes what the app looks
   like, show it (visual tiles, live preview). If it changes behaviour, say the consequence in words.
5. **What happens while it loads, when it fails, offline, empty, and on a phone?** Decide these now;
   they are part of the design, not polish.

## Information design comes before components

A surface is information first and components second. The usual way a Happier screen comes out
"basic" is skipping this step: reaching for `ItemGroup` and `Item` because they are the nearest
owner, and pouring data into settings rows. Rows on sheets are the right shape for one kind of
content only. Decide the shape of the information, then pick the owner that already draws that shape.

**1. Write the information inventory.** List what the person needs from this surface: the facts, the
states, the things they act on, and the actions. For each, note how often it changes, how much it
matters, and whether it is one value, a few named values, a set of similar records, a time series,
or a body of text.

**2. Set the information hierarchy, three tiers.**
- *Glance*: what must be understood in about a second, without reading (the state that needs them,
  the identity, the headline number). It gets position, size and the one place where colour speaks.
- *Scan*: what the person compares or picks from (the records, the facts beside each one). It gets a
  consistent anatomy so the eye can run down a column.
- *On demand*: detail, history, configuration, rare actions. It lives one press away (a detail pane,
  a disclosure, the "…" menu, a pushed page), not on the surface at rest.
If everything is tier two, nothing leads and the page reads flat. If tier three sits at rest, the
page reads busy.

**3. Classify each region by content kind, then use that kind's owner.**

| Content kind | What the person does | Shape | Owner (see `references/components.md`) |
| --- | --- | --- | --- |
| Configure | change a preference or setting | sections on sheets, one row per decision | `ItemGroup` + `Item` (+ `SettingRow`) |
| Browse and act | find, compare, open, act on records | flat list or table with one row anatomy, inset hairlines, section titles; grid or cards only when the thing is visual | `Collection` (list, table, board, grid) + `DetailsPaneHost` |
| Monitor | see health and change over time | status first; meters, sparklines, check history bars, counts that speak only when off | `Status`, the shared meters and sparklines, `WidgetFrame` |
| Read | understand one thing | identity header with its facts line, then the content itself | `PageHeader` (+ mark, `meta`), sections without sheets, `DetailsPaneHost` |
| Create | make something new | a flow: few choices, the next step visible, a live preview where it helps | the shared sheet or flow owner, `SelectionTiles`, the Composer |
| Navigate | go somewhere | short index, title-only rows or tiles | `Item` with chevron in a short list, tab bars, columns |

A page usually mixes kinds: an entity page reads (header and facts), monitors (health), lets you
browse (its services) and keeps configuration one press away. Give each region its own shape.

**4. Smell test before building.** If the planned page is only `ItemGroup`s of `Item`s and it is not a
settings page, the shape is wrong. Records belong in a Collection, health belongs in status and
history, an entity belongs in a header with facts. Fix the shape, not the padding.

**5. Reuse, then refine, then build once.** Every kind above has an owner. When an owner cannot show
the information well (an uptime bar, a richer record row), refine that owner for every consumer or
add the missing presentation once in `@happier-dev/plugin-ui`. Never a page-local look-alike. Approved
labs show each kind done well: `.happier/design-lab/pfc-redesign/` (browse, read, monitor),
`phone-lists-1115/` (browse on phones), `monitoring-1115/` (monitor).

## Presentation continuity

Apply apps/ui/AGENTS.md's stable component topology rule across pane, dialog, anchored popover and phone sheet presentations. Keep one mounted input or operation body through `useRetainedPlacement` in `apps/ui/sources/modal/components/RetainedModalFrame.tsx` (a0fcf7f04db, 0c74336595a).

## Core taste rules

These keep a surface correct. What makes it feel premium and alive rather than bland is in
`references/premium-feel.md`: one signature moment, the thing itself rather than a link to it, a live and
personal present, one hero, one rhythm, inviting empty states. Read it before designing any surface.

**Hierarchy**

- One primary action per view. Everything else is secondary (bordered or quiet) or tertiary (text).
  Two filled buttons side by side means you have not decided.
- Order sections by task frequency × consequence, not by data model or implementation.
- Use position, size, weight and space before boxes, colours, icons or labels.
- Healthy state is quiet. Speak (tint, dot, banner) only when something needs the user, and always
  pair it with the next action.
- Identity first: a page about a thing opens with that thing — its mark, name and the one fact that
  distinguishes it (account ID, version and machine, model count).

**Material** (see `DESIGN.md` → Materials; values in the edge and elevation owners)

- Ink borders, ink dividers, ink selection — never a fixed grey.
- Flat edge for everything in flow; the directional rim only for floating surfaces, by role (lighter
  corner on dark, a breath darker on light, never white); the message bubble is a fill only. Never on
  buttons, fields or rows. The rim is a whisper: if you notice it before the content, it is too strong.
- One radius base, concentric nesting; one spacing rhythm.
- Meta in one right-aligned tabular column; mono only for ids, paths, code and shortcuts.
- Colour means state: amber needs you, rose failed; glyphs stay ink.

**Anatomy** (configuration pages; other kinds take their shape from "Information design comes
before components"; see `references/anatomy.md`)

- Page header: title + one-sentence purpose. Sections: sentence-case title, description _above_ the
  rows, one sheet. No uppercase group labels, no explanatory footers under rows.
- One row, one decision, one control. The label says what it is; the description says the current
  state or the consequence — never both saying the same thing.
- Navigation rows (they open another page) and hub tiles carry an icon; preference rows (switch,
  select, segmented, inline field, button) don't. Identity marks (agent, provider, service, machine,
  person, device) always stay. One icon family, one size, `text.secondary`, no bordered tile, in the
  `Item` leading column so titles align within a section.
- No border, fill or tile behind icons or logos anywhere, including provider and service marks in
  columns, rows, headers and cards. The mark stands on its own. The only exceptions are avatars and
  an app icon rendered as an actual app icon. (User ruling, 2026-09-30.)

**Controls** (full decision table in `references/components.md`)

- 2–4 short options: segmented, all visible. More, or long labels: bordered field select.
  Booleans: switch. Destinations: value summary + chevron. Operations: inline button.
- Never tap-to-cycle, never a dropdown for 2–3 options, never a switch named after a mode ("Wizard
  mode") when the choice is between two named things ("Start with: Composer | Wizard").
- A choice that changes appearance is a visual tile rendering the _real_ component at static props.

**Copy** (see `references/copy.md`)

- Sentence case. Short nouns for titles; the description finishes the thought.
- Say outcomes, not mechanisms: "Your Homes appear on every device", not "Bounded discovery".
- No word repeated across sibling items; no raw hosts, IDs or enum values where a name exists.
- One message per state. If two strings on screen say the same thing, delete one.

**Stability** (see `references/states-and-motion.md`)

- Nothing moves on arrival. Reserve the space of rows whose existence is known; show last-known data
  while refreshing; never flash empty for hydrated data.
- Containers do not resize with their content: a modal keeps its height when search narrows results.
- Motion confirms cause and effect; high-frequency actions get almost none.

**Truthfulness** (see `references/patterns.md`)

- Never show a form that cannot succeed; a dependent row says what it needs first and leads there.
- A service or capability that is unavailable keeps explaining what it is for and offers the next
  action; only capabilities the contract really has are shown.

**Collections** (see `references/anatomy.md` → Collections)

- The generic Collection (list, table, board, grid and detail composition) lives in
  `@happier-dev/plugin-ui`; [Collection presentation](../../../docs/collection-presentation.md)
  names its current model, List engine and layout owners. Pages consume them rather than building
  another generic collection. A domain-specific page composition can bind those owners.

**Shared patterns** (`DESIGN.md` → Configuration surfaces)

- Overflow triggers are "…" alone; the word is the accessible name.
- A title block is one unit: `PageHeaderMarkIcon` draws the mark, `PageHeader` owns the gaps. Never pick a mark size.
- Filters are inline and one press: chips or a segmented control for what people filter by most, a menu only
  for the long tail. Bind real filter facts; the chip's state replaces its token.

**Phones recompose**

- Only a switch, a short value or a chevron sits right of a label; everything wider moves beneath.
- Lists push details; they never stack a detail above or below a list.
- Check what the floating tab bar, safe areas and keyboard cover.

## The working loop

0. **Shape the information** ("Information design comes before components" above): inventory,
   three-tier hierarchy, a content kind per region, the smell test. Write it in your report or brief
   in a few lines before writing code; a reviewer checks the page against it.
1. **Find the canonical owner** for every element you will render (`references/components.md`),
   and search for an existing same-concept component before writing one. A second component for an
   existing concept is a defect even if it looks better; so is a local edge, grey, radius or shadow
   where a material or ink role exists. When a shared component falls short of the reference, refine
   that component for every consumer (and check them) or accept the difference as a refinement; never
   fork it to match a lab. Merge any duplicates you find into one owner, and build on other lanes'
   good improvements to shared components rather than reverting them.
2. **Start from a reference, not from a blank file.** For a new or reworked surface, sketch it in the
   design lab (`.happier/design-lab/`, HTML in the product's real tokens) or pick the closest shipped
   Happier screen as the reference. Compare two or three compositions when hierarchy is unclear;
   choose one and write down why. Run lab rounds by `references/design-labs.md`.
3. **Build through the owners**, then render it live — while building, not only at handoff. A UI
   change you cannot see rendered (no stack, rendering not allowed, data missing) is blocked, not done:
   tests and reading code never replace looking. Look at the **whole page**, scrolled top to bottom in
   its real shell, before and after your change, and judge it as one composition (rhythm, density,
   what leads, how sections sit together), not frame by frame or element by element.
4. **Validate side by side** (`references/validation.md`): the reference and the live screen, same
   state, same theme, same size, one image next to the other, region by region; light, dark and
   phone. Sample colours when "it looks flat". List every remaining difference with its reason.
   Before a program hands off, run the **lab fidelity pass** in the same reference: inventory every
   touched surface, render real heavy data at the lab, wide and phone widths, measure frame, grid, type
   and rhythm, and classify each difference as a defect, an accepted refinement or a lab update.
5. **Review against the checklist** in `references/validation.md` before handing off.

A surface that existed in `../0.2` must match or beat 0.2 side by side before it lands: run both, same
state and size, and record the pair. Being newer is not being better; a 0.3 surface that loses to 0.2 is a
defect even when it matches its lab.

Any lane that changes rendered output, Sol logic lanes included, gets whole-page design acceptance from an
Opus pass before it reports done. The lane names the surfaces it changed; the pass judges each whole page live.
A lane that cannot get that pass reports `visual: not seen`, not done.

This loop applies to every change that alters what renders, whatever the lane is called. A
"behavior", "fix", "parity" or QA lane that adds a state, a control, a row, copy, an error or a repair
view is doing UI work: it loads this skill and follows the loop, or it hands the rendering to a lane
that does. Labelling a lane "non-visual" never exempts the states it adds.

A list of findings is an input, not the scope. Closing every listed delta does not make a page right;
the page is right when it reads like its reference as a whole. When a page reads wrong, recompose it at
its owners. A prop tweak that closes one measured gap is not a fix for a page that still reads wrong.

Seed data that looks like the reference: real-sounding names, lengths and counts, never run ids or
lane tags such as "QA-B 20261011 prompt". A screen judged on placeholder data hasn't been judged.

Never fork a component to match a reference. When the shared component differs from the lab, either
refine the shared component itself, for every consumer, when the lab's version is better, or keep the
shared version and record it as an accepted refinement. A page-local look-alike, a variant prop that
serves one screen, or a second copy "for now" is a split-brain. Refining a shared component is
expected. Before changing one, read its recent history and keep improvements other lanes made: undo a
change only when it is wrong, never merely because the lab is older. When you find two components or
two pieces of logic for one concept, unify them at the canonical owner and migrate their consumers.

## References

- `references/taste-digest.md` — the default condensed taste layer for every UI lane.
- `references/anatomy.md` — page, section, row, header, collection and disclosure anatomy.
- `references/patterns.md` — proven flows: adding to a collection, forms, prerequisites and steps,
  page scope, unavailable services, secrets, identity, destructive actions, back, search.
- `references/components.md` — owners, the control decision table, tiles, menus, lists, badges.
- `references/copy.md` — voice mechanics, smells, and rewrites.
- `references/states-and-motion.md` — loading, empty, offline, error, stability, focus and motion.
- `references/validation.md` — reference-first workflow, side-by-side acceptance, review checklist.
- `references/premium-feel.md` — what makes a surface feel premium: signature moment, real content,
  aliveness, one hero, one rhythm, inviting states, honest copy, anticipation; with a self-check.
- `references/design-labs.md` — how to run a lab round that lands premium: standard lab format, product
  truth first, the user's words and variants, populated data, every state, the output contract, and a brief
  skeleton.
