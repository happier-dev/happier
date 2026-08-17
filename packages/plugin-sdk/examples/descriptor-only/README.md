# Descriptor-Only Plugin Example

This is a maintained conformance/reference package. It is not an ordinary authoring template:
start a new plugin with `happier plugins create` and declare ordinary contributions through
`definePlugin(...)`; the canonical author build projects its cold manifest.

The cold `.happier-plugin/plugin.json` manifest is the whole plugin: typed settings, scoped
required/optional host access, contributed actions, and two **host-rendered declarative**
surfaces. It intentionally has no daemon or executable UI artifact — nothing is built, bundled
or loaded to make these screens work.

## What the two declarative views show

- **Settings → `settings-form`** — the settings context: a titled `group`, `markdown`
  guidance, `field` controls bound to declared settings (`toggle`, `select`) and a toned
  `status` readout.
- **`appPage` / app → `preview-list`** — the app context: a `list` of `section`s and
  `item` rows (icon, subtitle, detail, and a row action bound to a contributed action), a
  key/value `metadata` block, the `empty` / `loading` / `error` collection states, and an
  `actionPanel` grouping a primary action beside a `destructive` one.

Tone, variant and state are semantic, not decorative: the host maps them onto its own theme
tokens (so the surface follows light/dark and the active theme profile) **and** announces them
to assistive technology — a destructive action carries a spoken hint, an `error` state carries
an alert role, a `loading` state carries a busy state, and a toned row speaks its tone rather
than only tinting itself.

## Try it

Install the directory, then:

1. open plugin settings and verify the declarative controls, markdown and access-review states;
2. open the plugin's app page and verify the list, its states, the metadata block and the
   destructive action.

Actions render disabled here because a descriptor-only package registers no runtime handler;
that is the truthful projection, not a rendering bug. Give the plugin a daemon entry point and
register the two action ids to make them live.
