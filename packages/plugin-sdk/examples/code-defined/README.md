# Code-defined plugin

This source-stage example is the minimal one-file authoring form. It exports
the named `manifest` and `activate` ABI through `definePlugin`; the final
public export and `dev` install-admission integration land with the atomic SDK
publication cutover. The static pack path already consumes this source shape;
a distributable package root additionally supplies its npm package contract
and packed daemon entrypoint.

```bash
happier plugins doctor ./index.ts
happier plugins dev ./index.ts # available after that cutover
```

Packing evaluates this same author module once and emits the cold canonical
`.happier-plugin/plugin.json` used for installed discovery.
