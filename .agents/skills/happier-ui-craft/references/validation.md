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
2. Put them in one image, reference left, live right, and compare region by region: header, each
   section, each row, spacing rhythm, weights, colours, icons, alignment, empty space.
3. Do it for light, dark and a 390px phone, and for the states that matter (loading, empty, offline,
   error), not only the populated one.
4. When something "looks flat" or "has no background", sample pixel colours in both images instead of
   guessing, and map the difference to a token. Check the edge too: which side carries it, whether
   the border is ink, and whether a floating surface has its role's edge (rim at whisper strength).
5. List every remaining difference with its reason: data not available on this stack, deliberate
   decision, platform limit, or not yet fixed.

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
- [ ] Every control has an accessible name and role; hit targets are adequate; reduced motion works.

**Truthfulness**
- [ ] No form that cannot succeed; prerequisites say what is needed first.
- [ ] Unavailable services explain what they are for and offer the next action.
- [ ] Only contract-backed capabilities are shown; planned ones are labelled.

**Ownership**
- [ ] Every element came from its canonical owner; nothing duplicates an existing component.
- [ ] Every rendered setting is declared for search.

## Delegating UI work

- Give each lane the reference (lab concept or shipped screen), the side-by-side acceptance rule, the
  owner map and the explicit decisions already taken; ask for a per-gate report and the list of
  states not seen live.
- Re-derive a lane's claims before accepting them: rerun its tests on current files, look at its
  screenshot pairs, and check any shared owner it changed (focus, popover, list rows) across other
  consumers. A failure is the lane's only if it disappears without the lane's change.
