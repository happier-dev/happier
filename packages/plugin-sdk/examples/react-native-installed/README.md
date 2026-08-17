# React Native Installed Plugin Example

This is a maintained conformance/reference package. It is not an ordinary authoring template:
start a new plugin with `happier plugins create` and declare ordinary contributions through
`definePlugin(...)`; the canonical author build projects its cold manifest.

The strict `.happier-plugin/plugin.json` manifest demonstrates an installed React Native renderer with a
declarative fallback. `pluginUiBuild.ts` and `ui/panel.native.tsx` are public
build inputs. The checked-in Vite and Re.Pack configs emit the web, iOS, and
Android siblings consumed by the managed `happier-plugin-build-ui` command.

Its generated package manifest consumes the public toolchain packet for the
React Native, Community CLI, and Re.Pack build closure. No hand-authored
compiled bundle is checked in.
