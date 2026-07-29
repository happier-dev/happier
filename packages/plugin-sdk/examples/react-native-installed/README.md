# React Native Installed Plugin Example

The strict `.happier-plugin/plugin.json` manifest demonstrates an installed React Native renderer with a
declarative fallback. `pluginUiBuild.ts` and `ui/panel.native.tsx` are public
build inputs. The checked-in Vite and Re.Pack configs emit the web, iOS, and
Android siblings consumed by the managed `happier-plugin-build-ui` command.

The example pins the React Native 0.83-compatible Community CLI 20.1.2 build
closure used by Re.Pack 5.2.5. No hand-authored compiled bundle is checked in.
