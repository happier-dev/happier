# Code-defined plugin

This source-stage example is the minimal one-file authoring form. It exports
the named `manifest` and `activate` ABI through `definePlugin`; the final
public export and `dev` install-admission integration land with the SDK
publication cutover. A distributable package root additionally supplies its
npm package contract and generated daemon entrypoint.

```bash
happier plugins doctor ./index.ts
happier plugins dev ./index.ts # available after that cutover
```

The canonical author build evaluates this same module and emits the cold canonical
`.happier-plugin/plugin.json` used for installed discovery.
