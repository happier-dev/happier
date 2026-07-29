# Multi-Mode Fallback Plugin Example

One strict `.happier-plugin/plugin.json` view declares React Native primary, hosted web secondary, and
declarative tertiary fallback. `pluginUiBuild.ts` supplies the two executable
renderer inputs from one TSX source.

This repository example is source and compile coverage. Use the public UI build
helpers, pack the plugin, and validate fallback selection in a real host before
distributing it.
