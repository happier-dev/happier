DONE 634fef44ad3

| Shape | Test path and name | RED reason observed | State |
| --- | --- | --- | --- |
| F1 | `packages/plugins/machine-coder/src/machine/remoteWorkspaceShape.test.ts` — existing Coder attach has zero create POSTs | `createCoderClient.acquire` currently POSTs `/users/{owner}/workspaces` | PASSING `it.fails` |
| F2 | Owed to U1/R3 workspace-source demand owner | No workspace-keyed channel/holder demand API exists at the current owner boundary | OWED |
| F3 | Owed to U2 terminal-by-workspace owner | No workspace-keyed PTY custody API exists at the current owner boundary | OWED |
| F4 | Owed to U2 receiving-daemon placement owner | No composed in-place placement counter seam exists | OWED |
| F5 | Owed to U3 sync relationship owner | Managed V2 source admission is refused before relationship preparation | OWED, U3 fact below |
| F6 | Owed to U4 `machine-ssh` owner | SSH attach and SavedSecret binding owner are not present in this corridor | OWED |
| F7 | Owed to U1/R3 stopped-outcome owner | No typed stopped request outcome seam is present for a count test | OWED |
| F8 | Owed to U1 platform eligibility owner | Unsupported-platform holder admission API is not present | OWED |
| F9 | `packages/plugins/machine-coder/src/machine/remoteWorkspaceShape.test.ts` — retiring an attached workspace has zero destroy POSTs | `createCoderClient.destroy` currently POSTs `/workspaces/{id}/builds` with `transition: delete` | PASSING `it.fails` |
| R1 | `apps/cli/src/workspaces/source/remoteWorkspaceShape.test.ts` — managed placement is retained | `readWorkspaceSourcePlacement` returns only `sessionId` and `rootPath`, dropping `workspace` | PASSING `it.fails` |
| RW1 | Owed to U1/R3 holder lifecycle owner | No shared demand-hold API exists for an admission/bootstrap/trust/delivery count | OWED |
| RW2 | Owed to U1 folder-browser owner | No directory-page helper exchange owner API is exposed | OWED |
| RW4 | Owed to the server managed-retention owner | Attached-row `until-delete` versus Account `unused` deciding check is not in this lane | OWED |
| D-i | Owed to U1 daemon workspace registry owner | No attached-resource startup census seam is exposed | OWED |
| credential | Owed to U4 `machine-ssh` owner | SSH Action/argv/log boundary is not implemented in this corridor | OWED |

Focused validation used `./apps/stack/bin/hstack-exec -- pnpm --filter @happier-dev/cli exec vitest run src/workspaces/source/remoteWorkspaceShape.test.ts --reporter=verbose` and the equivalent `@happier-dev/plugins-machine-coder` command. Both suites passed with their `it.fails` cases, confirming inner assertions fail for the intended missing behavior. A combined root Vitest invocation hit an existing CLI alias setup error before collection, so it is not used as evidence.

U3 is partly supported. `packages/protocol/src/workspaces/workspaceSyncTopology.ts:29-30` types a managed V2 namespace, `:68-70` addresses its controller and managed id, and `:91-95` resolves its managed locator. The relationship creation owner still rejects a managed source at `apps/cli/src/workspaces/sync/workspaceSyncRelationshipCreate.ts:45-52`, with the refusal asserted by `workspaceSyncRelationshipCreate.test.ts:397-410`. The existing reviewed return path is present in `apps/cli/src/workspaces/sync/managedWorkspaceReturn.ts:26-39` and its tests, but it is unreachable from a managed Project source until source admission is extended. The smallest owner change is to accept the V2 source in relationship creation, derive execution/controller machine and folder through the canonical topology resolver, then pass that source namespace into the existing relationship and reviewed-return owners. No sync code was edited here.

Residual risk is limited to the unimplemented owner APIs and the existing shared-checkout typecheck baseline. The commit gate reported three pre-existing `NOT_AT_REV` perf fixture diagnostics with no candidate delta and kicked the rolling HEAD typecheck.
