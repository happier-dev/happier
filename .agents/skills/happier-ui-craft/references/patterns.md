# Proven patterns

Recurring situations and the shape that has worked in Happier. Each one came from a real review
round; use it before inventing a variant, and extend the owner when a case does not fit.

## Adding a thing to a collection

- "+" in the rail header. With more than one way to add (manually, or "ask an agent to do it"), "+"
  opens a menu (`Popover` + `FloatingOverlay`), never a guess at the common path.
- Adding inserts a **draft item at the top of the list**, selected, titled as the user types ("New ACP
  agent" until named). The detail pane shows the editor; phones push it. There is no separate "new"
  page and no modal form.
- The **same editor** edits saved items. One component, create and edit modes; deep links to older
  stand-alone pages redirect into the collection.
- Entity header: mark, name, Save (primary, disabled until changed), `⋯` with Delete (saved) or
  Discard (draft). Leaving with unsaved changes goes through the existing unsaved-changes guard.
- Identifiers the user shouldn't have to invent are derived from the name (with an "Edit" affordance)
  and become read-only once saved when other records reference them; say so in the row description.
- Validation errors come from the owning writer's typed codes and render inline under the field. The
  writer refuses a create over an existing id rather than silently replacing it.


## Adding a widget to a surface

- One add surface everywhere (Home, WorkBoard, Session Board, Companion, plugin areas): a grouped,
  searchable list on the left (Built in · each plugin by name · Your widgets); a row is the icon and
  one line of purpose, with "On Home" when already placed.
- The selected widget on the right: a quiet provenance line, then its **inputs first**, then the real
  body at its real size, then the size picker. One primary Add (⌘↵). Only the selected widget mounts
  a live body. A fully bound widget adds with one action.
- Outcomes (added, waiting for approval, refused) render in place without moving the layout. Phones:
  the list, then a setup sheet with a compact preview.

## Widget sizes

- A widget declares the sizes it is useful at and its default; a surface offers only those, as named
  sizes, never pixels or free resizing. One size picker serves Add, setup, Customize and the ⋯ menu;
  `[` and `]` step through the same order.
- The body receives its resolved size and measured geometry and adapts its content; it never draws a
  scaled-down copy of a larger layout. Linear surfaces (Companion, Project aside) stay one column.
## Forms inside pages

- A field is a row: label (and description) left, field right on wide screens, stacked beneath on
  phones (`FieldItem`, `FieldTextInput`, `fieldBox`). Lists of values use `StringListField`;
  key/value maps use the page variant of the map editor.
- One primary action per form, then a quiet Cancel. Enter advances through fields and submits on the
  last one. Each form shows the problems for the fields it renders; a problem whose field is not
  rendered shows at the form, never dropped.
- A disclosure that contains a form expands **the row itself** (`ExpandableItem`), never a card below
  the group.

## Hubs and setup

- Build the app home and Settings → Overview from the same hub section owners (attention, setup,
  machines, usage, summary rows); a section whose data has no owner is left out, not faked.
- State freshness ("As of …"); never open a hub with daemon RPCs; load usage once, lazily, and keep
  its last value.
- A setup step leaves when it is done — saved or dismissed counts as done for the recovery key — and
  is never marked done without evidence.

## Prerequisites and multi-step setup

- When an action needs something first (a password needs a confirmed sign-in email), the dependent
  row says so in its value ("Add a sign-in email first") and leads into the prerequisite. The
  prerequisite row shows the whole path as visible steps (① Email → ② Confirm → ③ Password).
- Never show a form that cannot succeed. If the server can only do step 2 after step 1, the UI starts
  at step 1 and says why.

## Scope that applies to a page

- One chip in the page header ("Setup and status on MacBook Pro ● ⌄"), not a full-width group.
- Work out, from the code, which settings are account-level and which need the scope. Account-level
  settings render and save with no scope selected; only scope-dependent sections show "Choose a
  machine" or an offline state with the last known values and disabled actions.
- The chip's picker reuses the canonical list (the new-session machine list), content-sized
  (`Popover` `portal.sizeToContent`), anchored to the chip's edge.
- Offline choices: the domain decides (`resolveCandidateAvailability`); the automatic default only
  picks a sole, live, online candidate.

## Truthful service readiness

- Offer an action only when every prerequisite for its success holds, checked at its owner: mail
  actions need mail delivery **and** a link the service can build. Otherwise say what is missing and
  who can fix it. Never answer "accepted" and then do nothing.

## A service that may be unavailable

- Keep **one section shape in every state**: what the section is for (the value, with its benefits)
  stays; only the action strip changes (sign in, signed in, unsupported, unreachable, checking,
  expired). A section must never collapse to a single "Unavailable" row that explains nothing.
- Say truthfully what is missing ("Happier Cloud can't find Homes yet") and offer the next action
  inline.
- Changing the service expands inline under the section: a radio list of known choices (the current
  one, sources the app already knows) plus "Another service…" with an address field and a Check that
  verifies it before anything is saved. No full-screen layer.
- Show only capabilities the contract has. Anything planned is labelled as future or left out.
- Services are self-hostable. "Happier Cloud" is only the default instance of the account service
  (and of the relay): a company can run its own. Name the configured service through its display-name
  owner (`accountServiceDisplayName.ts`), derive every method and capability from what that service
  advertises, and never branch on the default service's URL or name. Copy says "Happier Cloud" only
  when the default is selected.

## Secrets on a page

- Masked by default, one line; an eye button reveals, Copy copies with the copied feedback. Reveal and
  copy go through the same guard the old disclosure used (local secret, else unlock).
- The secret leaves component state when hidden, on unmount and on account change.

## Identity on a page about the user

- Page header: avatar, name (or the page title when no name is known), then the identity facts on a
  meta line (`PageHeader` `meta`: icon + text facts) — the account ID in mono with copy, then
  "🔒 End-to-end encrypted" directly below. Facts that load later hold their line so nothing moves.
- Name places by their display name ("Personal Home", "this Home"), never a host string.

## Leaving and destroying

- A quiet button row closes the page: the common exit bordered with an icon ("Sign out of Personal
  Home"), rare resets as text buttons, the irreversible one (`RoundButton display="destructive"`)
  pushed to the end, then one footnote with the consequence. No sheet, no red rows.

## Back navigation

- Sub-pages get the back arrow through `PageHeader`'s back slot (the settings shell's floating-controls
  host fills it). The title, purpose and leading mark keep the content's left edge; on wide panes the
  arrow sits in the gutter between the rail and the column, centred on the title line, and it drops
  onto the title row only when the gutter is too narrow (`resolvePageBackPlacement`). List + detail
  layouts host it in the detail pane, so it never floats over the list. Phones use the native
  header's back.

## When the viewer cannot do the thing

- Work out from the owner's answer (eligibility, capabilities, policy) whether the action is denied
  to this viewer, rather than hiding the entry point and hoping. Say it where the action would be:
  in the empty state's action slot (`EmptyState actionUnavailableReason`) or the disabled row's
  description. Name who can ("administrators of Studio") and what to ask for.
- Hide a control whose target set is empty; keep one whose set is unknown (the read failed).

## Search

- Every setting a page renders is declared (`defineSettingsPage`), registered, and rendered through
  `SettingRow`/`SettingAnchor`. Option labels are translated keywords ("Composer", "Wizard" on
  "Start with"). Links to sub-pages that are not catalog pages are declared too, so search reaches them.
- A search with no matches says "No matches"; the modal keeps its height whatever the results.
- In a page or collection, "no results" is the inline empty line and appears only when there is a
  query: "No plugins match "x"" · Clear. An empty query never shows "no results".
