# React Native Development Plugin Example

This is a maintained conformance/reference package. It is not an ordinary authoring template:
start a new plugin with `happier plugins create` and declare ordinary contributions through
`definePlugin(...)`; the canonical author build projects its cold manifest.

The cold `.happier-plugin/plugin.json` uses `entrypoints.development` and a React Native renderer with a
diagnostic fallback. The host development loop builds and serves the public
`pluginUiBuild.ts` input; source metadata does not own a dev URL or generated
artifact row.

Run the generated development flow in a real host to validate live source
updates; source and compile coverage alone do not prove client mounting.
