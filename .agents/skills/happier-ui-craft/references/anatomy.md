# Anatomy

The shapes every Happier page is built from. Values come from the owners named in `components.md`.

## Shell

- **Paper shell.** Navigation is the tinted plane (`surface.inset`); the content is the paper you
  read (`surface.base`). The selected rail row is a soft fill, never an accent bar.
- **Sheets sit a hair off the page** (`surface.sectionTint` plus a hairline border), not on a grey
  canvas and not as floating shadowed cards. If sheets "have no background", check the tint first.
- **One scroll owner per pane.** A list and its detail scroll independently; nothing nests scrolling.

## Page

```
[mark]  Title                                     [page actions]
        One sentence: what this page is for.

Section title
Description of what the section controls, above it.
┌──────────────────────────────────────────────────────────┐
│ Row title                                    [control]   │
│ Current state or consequence                             │
├──────────────────────────────────────────────────────────┤
│ …                                                        │
└──────────────────────────────────────────────────────────┘
```

- Build it with `ItemList` (page presentation by default) + `PageHeader` (settings: `SettingsPageHeader`). Non-page lists explicitly use `presentation="grouped"`.
  `ItemGroup` and `Item` pick up the page anatomy automatically.
- **Header.** Title + one sentence of purpose. On phones the native header shows the title; the page
  header shows only the purpose. Page-level actions (Reset, Test, machine chip) go on the right.
- **One column, one set of measures.** The content column, its max width, the title block, section
  spacing and sheet insets come from `pageListMetrics.ts`. The page title, its purpose line, every
  section title and every sheet share one left edge; a page never adds its own horizontal padding or
  margin to line something up. Collection detail panes and settings-like pages outside Settings use the
  same owners. `apps/ui/scripts/settingsSurfaces/alignmentAudit.mjs` measures the drift.
- **Back** on a sub-page is filled into `PageHeader`'s back slot by the navigation chrome. The title
  and purpose (or the leading mark, when there is one) stay on the content's left edge; on wide panes
  the arrow sits in the gutter left of that edge, centred on the title line, and it falls back onto
  the title row only when the gutter is too narrow for it. List + detail hosts it in the detail pane.
  Phones use the native back.
- **Entity header** (a page about one thing): mark, name, a meta line (`PageHeader` `meta`) with
  the distinguishing facts ("claude CLI 2.1.278 · on MacBook Pro", "@handle · Personal Home · 🔒 End-to-end
  encrypted"), then the one state switch and a `⋯` menu for rare operations.
- **Section order:** identity → what blocks use → most-used controls → configuration → rarely
  changed (disclosures) → destinations → destructive actions.
- **Destructive actions** close the page as a quiet button row, not as red rows in a sheet: the
  common exit (sign out) bordered with an icon, rare resets as text buttons, the irreversible one
  (delete) destructive and pushed to the end, then one footnote with the consequence.

## Section

- Sentence-case title, then the description, then the sheet. A description is optional; when
  present it says *why* or *what it affects*, never repeats the title.
- A section may have a trailing action ("Check now", "Refresh", "Change service"), a quiet text
  button with an icon. On narrow widths it drops beneath the title and description.
- A section without rows (tiles, a banner, a card) renders without a sheet (`surface="none"`).

## Row

- **Icons (rule b).** A navigation row (it opens another page) carries an icon; a preference row
  (switch, select, segmented, inline field, button) does not; identity marks always stay. The icon is
  one family, one size, `text.secondary`, no tile, in `Item`'s fixed leading column, so every title in
  a section starts on the same line whether or not its row has an icon.
- Title (medium weight) says what it is. Description (secondary) says the current value, the state,
  or the consequence.
- **Three row contracts.** Described collection records use `catalogRow`, including narrow
  Settings columns; `HAPPIER_COLLECTION_LIST_METRICS.catalogRow` owns its floor, bare mark box,
  gap and rhythm. A peer without a description keeps that collection's role, with no invented
  copy. Title-only navigation, menus and indexes stay compact (`item`/`menu`); preference rows
  keep their divided page anatomy. Never infer catalog role from a preference's help subtitle.
- One control on the right. It sits inline when it is a switch, short value or chevron; the row
  stacks it beneath (`accessoryLayout="adaptive"` / `"stacked"`) when it is wider.
- A row with a destination shows the current value as a summary before the chevron
  ("17 built-in · 2 custom ›"), so the user learns without opening it.
- A compound row only for facets of one decision (model + effort), never for unrelated settings
  placed side by side.

## Hubs

- The app home (the empty main pane) is the primary hub: greeting, the start-session box, Needs your
  attention, Get set up, Machines, Usage. Settings → Overview is the lighter hub: identity,
  attention, summary rows, quick settings. Both compose from one set of hub section owners; a page
  never re-implements a hub section.
- A row without a data owner drops out; it never leaves a hole or a placeholder. Freshness is honest
  ("As of …"). Opening a hub makes no daemon RPCs; usage loads once, lazily, and keeps its last value.
- Setup steps disappear when done (for the recovery key, saved or dismissed counts as done) and never
  invent completion.

## Sidebar

- The foot is the account: avatar, name and Home, opening the Home/account popover — or an honest
  "Link to {ServiceName}" when there is none. Beside it, icon buttons: Usage, Machines, Updates (only
  when one exists), Settings; they fold into `⋯` when narrow. One glass "+" starts a new session.

## Empty

- One owner, `EmptyState`. A whole page or pane with nothing in it is `layout="page"`: a calm glyph
  with no tile, a short title, one line of purpose ("what this would hold, and why you'd want it"),
  then one primary action (`primaryAction`). If this viewer cannot take that action, the action's
  place says why and who can (`actionUnavailableReason`), instead of leaving a dead end.
- Inside a list, a rail or a sheet, emptiness is one quiet line aligned with the rows
  (`layout="line"`). A rail and its detail never both show the full state: the rail says one line,
  the detail shows the page state.
- A search with no results is the line ("No matches"), not the page state.

## Disclosure

- `ExpandableItem`: the row itself expands in place. Its closed state shows a summary of the value
  ("On · Regular"). Never open a form below the group, and never hide an error or required field in
  a closed disclosure.
- One caret for every disclosure: it points at the row while closed and turns a quarter down toward
  the body while open (the shared `HappierDisclosureTurn` rule; never a swap to up/down glyphs). An
  `Item` header that spreads the disclosure's `headerProps` draws it at its trailing edge, after any
  summary (`keepChevronWithRightElement` keeps it beside a right element); never pass a caret as
  `leftElement`/`rightElement`. A header that is not an `Item` renders `DisclosureCaret`. A menu or
  field that opens a popover keeps its own up/down caret; that is a different control.

## Collections

The generic Collection (model, list/table/board/grid presentations, detail containers) lives in
`@happier-dev/plugin-ui`; [Collection presentation](../../../../docs/collection-presentation.md)
names its current owners. Pages bind their data, routes and Actions to those owners.

- **Presentations and their detail containers.** List → list + detail (split). Grid → a drawer on
  wide screens, so the grid stays visible. Board → a drawer. Phones push. Closing returns to the same
  view with scroll, filters and search kept.
- **Grid | List** where both help, a default per surface, remembered locally. Never a switch that
  swaps the whole page's shape.
- **One card.** Grid, shelf and Board use `CollectionCards` and its shared portable WidgetFrame
  chrome: mark and independent right slot, title, description only when supplied, quiet facts,
  optional rich body. Bounded `card.headerRight/facts/body` slots retain frame and activation
  ownership; there is no divided footer. Truly title-only cards remain compact. A body height is
  a text-scaled minimum, never a clipping cap. Interactive controls remain siblings of open.

| Shape | When | Build |
| --- | --- | --- |
| List + detail | Named things with substantial configuration (agents, providers, machines, prompts) | `HappierListDetailLayout`; selection comes from the route |
| Described catalog rows | Described collections, including narrow columns | `Collection` / core collection binding selects `catalogRow`; shared status leads line 2, count stays with title |
| Cards and rich widgets | A few choices, or retained domain content | `Collection` bounded card slots / existing `WidgetFrame`; one portable chrome, domain-owned data and body lifecycle |
| Expand in place | Shallow things with two or three settings each (MCP bindings, channels) | `ExpandableItem` rows |
| Tiles | A handful of actions or choices that benefit from space (devices, templates) | `SelectionTiles variant="action"` |

- Wide screens always have a selection: land on the last visited or first relevant item. No empty
  detail pane next to a list.
- Narrow screens: the list is the page and the detail pushes. Never show a detail's content stacked
  above or below the list.
- Rail header: title, a quiet count, a "+" (a menu when there is more than one way to add), and a
  compact search field only when the list is long enough to need it.
- Adding creates a selected draft row at the top of the list with its editor in the detail pane
  (see `patterns.md` → "Adding a thing to a collection"); there is no separate "new" page.
- Group rows by truth the user cares about ("On MacBook Pro" / "Available to install"), with
  counts. Without the data to group truthfully, show one ungrouped list rather than a false heading.
- Catalog rows: name, optional mixed-kind word, held count/scope; canonical speaking status then
  description. Status/fix survive narrow widths; description yields first, with full text in the
  accessible name, preview and detail. Fix/checkbox/open are independent. Unavailable identity uses
  the shared dim value and stays openable. Preference and work rows retain their own contracts.

## Context chips

- A scope that applies to the whole page (the managed machine) is one chip in the page header:
  "Managing · MacBook Pro ● ⌄", not a full-width group repeated on every page.
- Only scope-dependent content waits for the chip; account-level settings never do.
- The chip stays rendered through loading and error states because it is the recovery control. Its
  popover reuses the canonical picker list, full-bleed.
