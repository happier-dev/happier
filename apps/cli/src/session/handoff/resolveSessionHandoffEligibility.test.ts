import { describe, expect, it, vi } from 'vitest';

import type { HandoffExportSessionMetadataV1 } from '@happier-dev/agents';
import { buildOpenCodeRuntimeIdentityDescriptorV1 } from '@happier-dev/plugins-opencode/agent/identity/runtimeDescriptor';
import { resolveLinkedExternalSessionMetadataV1 } from '@happier-dev/protocol';
import { resolveSessionHandoffEligibility } from './resolveSessionHandoffEligibility';

function resolveEligibilityFromOwnerMetadata(input: Readonly<{
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
  sessionAgentId?: string | null;
  runtimeDeps?: Record<string, unknown>;
}>) {
  const metadata = input.metadata && typeof input.metadata === 'object'
    ? input.metadata as Record<string, unknown>
    : {};
  return resolveSessionHandoffEligibility({
    // These owner-view fixtures isolate host-fact resolution; the export-path test
    // separately proves that production callers supply the strict handoff projection.
    metadata: metadata as HandoffExportSessionMetadataV1,
    sourceMachineId: metadata.machineId,
    externalSessionLinkResolution:
      resolveLinkedExternalSessionMetadataV1(metadata),
    accountSettings: input.accountSettings,
    sessionAgentId: input.sessionAgentId,
    ...input.runtimeDeps,
  });
}

describe('resolveSessionHandoffEligibility', () => {
  it('allows an eligible persisted Claude session', async () => {
    await expect(
      resolveEligibilityFromOwnerMetadata({
        metadata: {
          flavor: 'claude',
          machineId: 'machine_source',
          claudeSessionId: 'sess_1',
        },
      }),
    ).resolves.toEqual({
      eligible: true,
      agentId: 'claude',
      storageMode: 'persisted',
      sourceMachineId: 'machine_source',
      vendorHandoffId: 'sess_1',
    });
  });

  it('allows an eligible direct OpenCode session', async () => {
    await expect(
      resolveEligibilityFromOwnerMetadata({
        metadata: {
          flavor: 'opencode',
          machineId: 'machine_source',
          opencodeSessionId: 'sess_2',
          externalSessionV1: {
            v: 1,
            agentId: 'opencode',
            machineId: 'machine_source',
            remoteSessionId: 'sess_2',
            source: { kind: 'opencodeServer', directory: '/repo' },
            linkedAtMs: 1,
          },
        },
      }),
    ).resolves.toEqual({
      eligible: true,
      agentId: 'opencode',
      storageMode: 'direct',
      sourceMachineId: 'machine_source',
      vendorHandoffId: 'sess_2',
    });
  });

  it('resolves provider identity from runtime descriptor metadata when flavor is unavailable', async () => {
    await expect(
      resolveEligibilityFromOwnerMetadata({
        metadata: {
          machineId: 'machine_source',
          externalSessionV1: {
            v: 1,
            agentId: 'opencode',
            machineId: 'machine_source',
            remoteSessionId: 'opencode_runtime_1',
            source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
            linkedAtMs: 1,
            runtimeDescriptorV1: buildOpenCodeRuntimeIdentityDescriptorV1({
              backendMode: 'server',
              providerSessionId: 'opencode_runtime_1',
              serverBaseUrl: 'http://127.0.0.1:4096/',
              serverBaseUrlExplicit: true,
            }),
          },
        },
      }),
    ).resolves.toEqual({
      eligible: true,
      agentId: 'opencode',
      storageMode: 'direct',
      sourceMachineId: 'machine_source',
      vendorHandoffId: 'opencode_runtime_1',
    });
  });

  it('resolves agent identity from canonical external-session links when flavor is unavailable', async () => {
    await expect(
      resolveEligibilityFromOwnerMetadata({
        metadata: {
          machineId: 'machine_source',
          externalSessionV1: {
            v: 1,
            agentId: 'opencode',
            machineId: 'machine_source',
            remoteSessionId: 'opencode_runtime_2',
            source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
            linkedAtMs: 1,
          },
        },
      }),
    ).resolves.toEqual({
      eligible: true,
      agentId: 'opencode',
      storageMode: 'direct',
      sourceMachineId: 'machine_source',
      vendorHandoffId: 'opencode_runtime_2',
    });
  });

  it('recognizes an A13-retained legacy directSessionV1 link as direct storage', async () => {
    await expect(
      resolveEligibilityFromOwnerMetadata({
        metadata: {
          machineId: 'machine_source',
          directSessionV1: {
            v: 1,
            providerId: 'opencode',
            machineId: 'machine_source',
            remoteSessionId: 'opencode_legacy',
            source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
            linkedAtMs: 1,
          },
        },
      }),
    ).resolves.toEqual({
      eligible: true,
      agentId: 'opencode',
      storageMode: 'direct',
      sourceMachineId: 'machine_source',
      vendorHandoffId: 'opencode_legacy',
    });
  });

  it('rejects an OpenCode session whose canonical and rollback links require reconciliation', async () => {
    await expect(
      resolveEligibilityFromOwnerMetadata({
        metadata: {
          flavor: 'opencode',
          machineId: 'machine_source',
          opencodeSessionId: 'opencode_conflict',
          externalSessionV1: {
            v: 1,
            agentId: 'opencode',
            machineId: 'machine_source',
            remoteSessionId: 'opencode_conflict',
            source: { kind: 'opencodeServer', directory: '/repo/current' },
            linkedAtMs: 1,
          },
          directSessionV1: {
            v: 1,
            providerId: 'opencode',
            machineId: 'machine_source',
            remoteSessionId: 'opencode_conflict',
            source: { kind: 'opencodeServer', directory: '/repo/stale' },
            linkedAtMs: 1,
          },
        },
      }),
    ).resolves.toEqual({
      eligible: false,
      reasonCode: 'linked_session_reconciliation_required',
    });
  });

  it('rejects sessions whose provider cannot be inferred', async () => {
    await expect(resolveEligibilityFromOwnerMetadata({ metadata: { machineId: 'm1' } })).resolves.toEqual({
      eligible: false,
      reasonCode: 'agent_unknown',
    });
  });

  it('rejects sessions missing a source machine id', async () => {
    await expect(
      resolveEligibilityFromOwnerMetadata({
        metadata: { flavor: 'claude', claudeSessionId: 'sess_1' },
      }),
    ).resolves.toEqual({
      eligible: false,
      reasonCode: 'source_machine_missing',
    });
  });

  it('rejects malformed external-session metadata instead of falling back to persisted storage', async () => {
    await expect(
      resolveEligibilityFromOwnerMetadata({
        metadata: {
          flavor: 'pi',
          machineId: 'machine_source',
          piSessionId: 'sess_pi',
          externalSessionV1: {
            v: 1,
            agentId: 'pi',
          },
        },
      }),
    ).resolves.toEqual({
      eligible: false,
      reasonCode: 'linked_session_invalid',
    });
  });

  it('allows a codex app-server session without requiring account settings', async () => {
    await expect(
      resolveEligibilityFromOwnerMetadata({
        metadata: {
          flavor: 'codex',
          machineId: 'machine_source',
          codexSessionId: 'codex_1',
          codexBackendMode: 'appServer',
        },
      }),
    ).resolves.toEqual({
      eligible: true,
      agentId: 'codex',
      storageMode: 'persisted',
      sourceMachineId: 'machine_source',
      vendorHandoffId: 'codex_1',
    });
  });

  it('allows an installed external Agent only through its exact declared handoff surface', async () => {
    const resolveExecutionSurfaces = vi.fn(async (backendId: string) => ({
      terminalRuntime: null,
      externalSession: null,
      attach: null,
      handoff: {
        evaluateAvailability: async (request: { operation: string; sessionId?: string }) => {
          expect(request).toMatchObject({
            operation: 'exportBundle',
            sessionId: 'acme-session-1',
          });
          return { available: true as const };
        },
        exportBundle: async () => ({ ok: false as const, code: 'handoff_failed' as const }),
        importBundle: async () => ({ ok: false as const, code: 'handoff_failed' as const }),
      },
      fork: null,
      checkpoint: null,
    }));

    await expect(
      resolveEligibilityFromOwnerMetadata({
        metadata: {
          machineId: 'machine_source',
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'acme.handoff',
            agent: { providerSessionId: 'acme-session-1' },
          },
        },
        runtimeDeps: {
          resolveCurrentExecutionSurfacesForAgent: async (agentId: string) => (
            agentId === 'acme.handoff'
              ? {
                backendId: 'acme.handoff.backend',
                executionSurfaces: await resolveExecutionSurfaces('acme.handoff.backend'),
              }
              : null
          ),
        },
      }),
    ).resolves.toEqual({
      eligible: true,
      agentId: 'acme.handoff',
      backendId: 'acme.handoff.backend',
      storageMode: 'persisted',
      sourceMachineId: 'machine_source',
      vendorHandoffId: 'acme-session-1',
    });
    expect(resolveExecutionSurfaces).toHaveBeenCalledWith('acme.handoff.backend');
  });

  it('uses the generic provider session id from the strict handoff projection for an installed Agent', async () => {
    await expect(
      resolveEligibilityFromOwnerMetadata({
        metadata: {
          machineId: 'machine_source',
          providerSessionId: 'acme-session-2',
        },
        sessionAgentId: 'acme.handoff',
        runtimeDeps: {
          resolveCurrentExecutionSurfacesForAgent: async () => ({
            backendId: 'acme.handoff.backend',
            executionSurfaces: {
              terminalRuntime: null,
              externalSession: null,
              attach: null,
              handoff: {
                evaluateAvailability: async (request: { sessionId?: string }) => {
                  expect(request.sessionId).toBe('acme-session-2');
                  return { available: true as const };
                },
                exportBundle: async () => ({ ok: false as const, code: 'handoff_failed' as const }),
                importBundle: async () => ({ ok: false as const, code: 'handoff_failed' as const }),
              },
              fork: null,
              checkpoint: null,
            },
          }),
        },
      }),
    ).resolves.toEqual({
      eligible: true,
      agentId: 'acme.handoff',
      backendId: 'acme.handoff.backend',
      storageMode: 'persisted',
      sourceMachineId: 'machine_source',
      vendorHandoffId: 'acme-session-2',
    });
  });

  it('fails closed when an installed external Agent has no current handoff capability', async () => {
    await expect(
      resolveEligibilityFromOwnerMetadata({
        metadata: {
          machineId: 'machine_source',
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'acme.handoff',
            agent: { providerSessionId: 'acme-session-1' },
          },
        },
      }),
    ).resolves.toEqual({
      eligible: false,
      reasonCode: 'handoff_unsupported',
      agentId: 'acme.handoff',
      storageMode: 'persisted',
    });
  });

  it('fails closed when resolving an installed external Agent runtime rejects', async () => {
    await expect(
      resolveEligibilityFromOwnerMetadata({
        metadata: {
          machineId: 'machine_source',
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'acme.handoff',
            agent: { providerSessionId: 'acme-session-1' },
          },
        },
        runtimeDeps: {
          resolveCurrentExecutionSurfacesForAgent: async () => {
            throw new Error('runtime reloaded');
          },
        },
      }),
    ).resolves.toEqual({
      eligible: false,
      reasonCode: 'handoff_unsupported',
      agentId: 'acme.handoff',
      storageMode: 'persisted',
    });
  });
});
