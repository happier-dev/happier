# Forge CI package instructions

This package owns forge-neutral active-view reads, CI log indexing, evidence,
input projection and mounted presentation models. Native clients, credentials,
provider parsing and effect admission belong to each forge plugin. Public wire
schemas belong to `@happier-dev/triage-protocol/ci/v1`.

Keep `/runtime` UI-free. `/ui` supplies controlled models and shared mounted
hooks; use public Plugin UI and its existing Find, Form and pane owners.
The package is public Developer Preview source, not an independent publication.
Follow [SDK protocol evolution](../../docs/compatibility.md#sdk-protocol-evolution).
