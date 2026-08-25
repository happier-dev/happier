# Multi-Mode Fallback Plugin Example

> Hosted-web rendering availability is reported per host; a host that cannot construct its frame adapter reports a typed unavailable reason instead.

This is a maintained conformance/reference package. It is not an ordinary authoring template:
start a new plugin with `happier plugins create` and declare ordinary contributions through
`definePlugin(...)`; the canonical author build projects its cold manifest.

One strict `.happier-plugin/plugin.json` view declares React Native primary, hosted web secondary, and
declarative tertiary fallback. `pluginUiBuild.ts` supplies the two executable
renderer inputs from one TSX source.

This repository example is source and compile coverage. Its hosted-web arm is
blocked rather than an advertised fallback; only a passed frame adapter can
make that arm eligible for host validation.
