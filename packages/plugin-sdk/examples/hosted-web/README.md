# Hosted Web Plugin Example

> Packaged hosted-web rendering availability is reported per host; a host that cannot construct its frame adapter reports a typed unavailable reason instead.

This is a maintained conformance/reference package. It is not an ordinary authoring template:
start a new plugin with `happier plugins create` and declare ordinary contributions through
`definePlugin(...)`; the canonical author build projects its cold manifest.

The strict `.happier-plugin/plugin.json` manifest demonstrates a hosted-web renderer with a declarative
fallback. `pluginUiBuild.ts` is the public build input.

This repository example is source and compile coverage for a blocked reference
arm, not a template or distribution candidate. The manifest contains no
invented artifact row or static-output placeholder.
