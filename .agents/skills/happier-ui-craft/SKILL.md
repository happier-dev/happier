---
name: happier-ui-craft
description: Happier's working method and taste for designing and building user-facing UI — information hierarchy, page and section anatomy, control choice, visual choices, collections, copy, states and layout stability, motion, phone recomposition, and the reference-first, side-by-side validation loop. Use before designing, building, or reviewing any Happier screen, component, flow, or plugin UI; it turns DESIGN.md doctrine into concrete decisions.
---

# Happier UI craft

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
- Flat edge for everything in flow; the directional rim only for floating surfaces and the message
  bubble, by role (lighter corner on dark, a breath darker on light, never white). Never on buttons,
  fields or rows. The rim is a whisper: if you notice it before the content, it is too strong.
- One radius base, concentric nesting; one spacing rhythm.
- Meta in one right-aligned tabular column; mono only for ids, paths, code and shortcuts.
- Colour means state: amber needs you, rose failed; glyphs stay ink.

**Anatomy** (configuration and detail pages; see `references/anatomy.md`)

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
