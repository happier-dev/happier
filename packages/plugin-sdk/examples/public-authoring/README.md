# Broad Public Authoring Example

This is the deliberately broad companion to the minimal CLI scaffold. It
demonstrates actions, tools, commands, hooks, a native Agent runtime, settings,
React Native and hosted-web UI, and Voice declarations in one package.

The sole projected source of truth is
`.happier-plugin/plugin.json`. TypeScript files bind executable behavior or
describe UI builds; they do not construct another manifest. The daemon module
exports one named `activate(api)` function, and ordinary contribution demand
activates it.

This repository example provides schema, source, and compile coverage. It does
not prove install, trust, native mounting, update, rollback, or uninstall in a
real host. Start a normal plugin with the smaller scaffold:

```bash
happier plugins create my-plugin
cd my-plugin
happier plugins dev
```
