# Minimal custom Session Agent

This is the smallest executable public-SDK reference for a custom persistent
Session Agent. Start with the normal scaffold, then copy this package's
`index.ts` to the scaffold's `src/index.ts` and
`agent/deterministicSessionAgent.ts` to
`src/agent/deterministicSessionAgent.ts`, and replace the scaffold's generated
`test/index.test.mjs` with this package's `test/index.test.mjs`. The scaffold
test invokes its retired `save-note` Action; the replacement instead checks the
compiled manifest's one Session Agent and runner locator, so the documented
`happier plugins test .` step remains executable after the copy. Then replace
the example id, title, and deterministic behavior:

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
publishes its provider-session identity, then emits an input acceptance,
reasoning delta, tool call, public host confirmation, tool result, assistant
delta, and terminal event. Because it has no mutable provider-native state, a
resume reopens an equivalent runtime and republishes the exact provider identity
the host supplies. Cancelling while the confirmation is pending emits one
cancellation terminal event and ignores a late confirmation result. The host
continues to own input custody, interaction presentation, transcript
persistence, currentness, and Session lifecycle.

For live source development, continue with `happier plugins dev` or use the
documented headless development-source lifecycle:

```bash
happier plugins install . --dev --trust --json
happier plugins reload --json
happier daemon restart --restart-session-runners --json
happier plugins disable examples.session-agent --json
happier plugins enable examples.session-agent --json
happier plugins uninstall examples.session-agent --json
```

Select and open the Agent in Happier before a daemon restart, then reopen that
Session after restart to exercise the public resume path. Reload applies source
edits through the canonical generation owner; already admitted Sessions retain
their host-owned generation custody. Disabling and uninstalling exercise Agent
unavailability and generation cleanup; the command above intentionally preserves
plugin data.

Complete the moving-byte author journey by packing to a new path outside the
plugin root and installing that archive through the same canonical daemon flow:

```bash
happier plugins pack . --out ../session-agent.tgz
happier plugins install ../session-agent.tgz --kind archive --json
happier plugins change approve <pendingChangeId> --json
```

Archive installation requires a present user to approve trust; `--trust` is
only for the local source-development route. The approving user must review the
prepared facts before replacing `<pendingChangeId>`; Settings → Plugins exposes
the same decision. This proves the ordinary author-owned build artifact without
freezing a release candidate or turning the archive into a separate feature
gate. Public registry publication remains release-owned.

To exercise an installed update, change the example implementation or version,
pack to a fresh archive path, then install and approve that archive through the
same flow:

```bash
happier plugins pack . --out ../session-agent-update.tgz
happier plugins install ../session-agent-update.tgz --kind archive --json
happier plugins change approve <pendingChangeId> --json
```

Reopen the selected Agent after approval and verify the new behavior. This is
the canonical archive update path; it does not introduce a separate plugin
runtime or update owner.

For the hard-revocation check, leave a confirmation pending and choose
**Forget trust** for `examples.session-agent` in Settings → Plugins. The active
generation must retire without publishing a late result, and the Agent must
remain unavailable until a present user trusts an exact source or archive
again. Reinstall the development root with the explicit `--dev --trust` command
above, verify a new Session, then finish with disable/enable and uninstall.

The exact shared UI selectors for this Agent are:

- Wizard: `new-session-agent:agent:examples.session-agent/session-agent`
- Composer picker trigger: `agent-input-agent-chip`
- Composer picker option: `agent-input-chip-picker.option:agent:examples.session-agent/session-agent`
- Confirmation: `permission-footer.allow`
- Cancel: `agent-input-abort`
- Hard revoke: `settings.plugins.detail.examples.session-agent.action.forgetTrust`

The repository also maintains loaded QA corridors for this lifecycle and these
selectors against current development bytes. The browser RNW corridor owns the
full reversible lifecycle; real Tauri desktop and iOS/Android corridors exercise
the same qualified Agent's selection, interaction, cancellation, and recovery
through their loaded clients. They live in the
current-managed-stack Plugin QA testkit (`packages/tests`,
`currentManagedStackPluginUiQa.ts`) and is driven by
`test:ui:e2e:plugin-current-stack:session-agent`,
`test:mobile:e2e:*:plugin-platform-current-source`, and
`tauri:mcp:session-agent:qa`. The manual lifecycle below remains the
author-facing reference; the harness never replaces it with a second
lifecycle owner.

Use `advanced-package-root` only when the same package also needs External
Sessions, a Provider, Connected Accounts, resources, or background work.
