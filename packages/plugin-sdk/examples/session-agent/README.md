# Minimal custom Session Agent

This is the smallest executable public-SDK reference for a custom persistent
Session Agent. Start with the normal scaffold, then copy this package's
`index.ts` and `agent/deterministicSessionAgent.ts` into the scaffold and
replace the example id, title, and deterministic behavior:

```bash
happier plugins create my-session-agent
cd my-session-agent
happier plugins dev typecheck .
happier plugins dev build .
happier plugins test .
```

`index.ts` uses `definePlugin(...)` as the sole authoring path. It declares one
custom Agent and names one distinct Session-runner leaf. The runner leaf exports
the same factory and uses only public SDK imports, so activation and Session
execution can run in separate daemon realms without sharing a process-global
owner.

The deterministic runner has no network or provider dependency. A new turn
emits an input acceptance, reasoning delta, tool call, public host confirmation,
tool result, assistant delta, and terminal event. Cancelling while the
confirmation is pending emits one cancellation terminal event and ignores a
late confirmation result. The host continues to own input custody, interaction
presentation, transcript persistence, currentness, and Session lifecycle.

To exercise the ordinary archive path after the source checks pass, pack to a
new path outside the plugin root and install it through the canonical CLI flow:

```bash
happier plugins pack . --out ../session-agent.tgz
happier plugins install ../session-agent.tgz --kind archive
```

Archive installation requires a present user to approve trust; `--trust` is
only for the local source-development route. For source development, use
`happier plugins dev` or the documented `install . --dev --trust` and reload
flow. This repository example is prepublication source material, not a shipped
plugin or release artifact.

Use `advanced-package-root` only when the same package also needs External
Sessions, a Provider, Connected Accounts, resources, or background work.
