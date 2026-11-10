import { createAccountScopedCryptoMaterialSnapshotV1, readAccountScopedCiphertextKindByte, sealAccountScopedBlobCiphertext,
  admitAgentStartV1, DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '@happier-dev/protocol';
import { AutomationV3WorkerFailRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { describe, expect, it, vi } from 'vitest';
import { createProductionWorkflowRunCoordinator } from '@/daemon/workflows/production';
import { executeClaimedRun } from './automationRunExecutor';
import type { AvailableAutomationAccountEncryptionV1 } from '@/plugins/runtime/automations/automationAccountCurrentness';
import { createWorkflowMaterializationHostV1 } from '@/session/actions/workflowMaterializationHost';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { openAutomationRunFailureDetailStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationRunFailureDetailStoredContent';

describe('Automation Run failure detail sealing', () => {
  it.each([
    ['plain', true, false], ['e2ee', true, false], ['plain', false, false], ['e2ee', false, false],
    ['plain', true, true], ['e2ee', true, true],
  ] as const)('settles a %s Workflow admission refusal with matching content identity (%s), uninstalled Agent (%s)', async (mode, contentIdentityMatches, uninstalled) => {
    const witness = { mode, version: 41, contentKeyFingerprint: mode === 'plain' ? null : 'content-key-41' };
    const material = mode === 'e2ee' ? createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(19) },
    }) : undefined;
    const encryption: AvailableAutomationAccountEncryptionV1 = material
      ? { kind: 'available' as const, witness: { ...witness, mode: 'e2ee' as const, contentKeyFingerprint: 'content-key-41' }, material }
      : { kind: 'available' as const, witness: { ...witness, mode: 'plain' as const, contentKeyFingerprint: null } };
    const currentEncryption: AvailableAutomationAccountEncryptionV1 = contentIdentityMatches
      ? material
        ? { kind: 'available', material, witness: { mode: 'e2ee', contentKeyFingerprint: 'content-key-41', version: 42 } }
        : { kind: 'available', witness: { mode: 'plain', contentKeyFingerprint: null, version: 42 } }
      : { kind: 'available' as const,
        witness: { mode: 'e2ee' as const, version: 42, contentKeyFingerprint: 'rotated-content-key' },
        material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
          material: { type: 'legacy', secret: new Uint8Array(32).fill(20) } }),
      };
    // Run persistence and machine transport are external boundaries. Admission
    // and the private refusal settlement execute through their actual owners.
    const storage = vi.fn(async () => { throw new Error('unadmitted_run_must_not_write'); });
    const machineAdmissionTransport = vi.fn(async () => { throw new Error('unadmitted_run_must_not_dispatch'); });
    const resolveMaterializationHost: NonNullable<Parameters<typeof createProductionWorkflowRunCoordinator>[0]['resolveMaterializationHost']> = async ({ runId, workDepth, directory }) => ({
      ...await createWorkflowMaterializationHostV1({ credentials: { token: 'token', encryption: null },
        readRoleSelection: async () => ({}), readLaunchProfile: async () => null, readWorkflowDefinition: async () => null,
        // Machine RPC is the boundary; inventory, materialization and settlement remain real.
        callMachineAction: async ({ method }) => method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
          ? { protocolVersion: 1, projection: { v: 2, generation: 1, agentsById: { muse: {
            id: 'muse', identity: { pluginId: 'happier.agent.muse', localId: 'muse' },
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
          } } } }
          : { protocolVersion: 1, results: { 'cli.muse': { ok: true, data: {
            installed: false, version: null, latestVersion: null, update: { supported: false, command: null },
            signIn: { status: 'unknown', loginSupport: 'unsupported' }, platform: { supported: true },
            install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [],
          } } } },
      })({ machineId: 'machine-1', directory }),
      admitLeaf: async (leaf, facts) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
        { kind: 'workflow_run_leaf', leaf }, { caller: { kind: 'originless', runId, runDepth: workDepth },
          baseline: { machineId: 'machine-1', directory }, ledSubtreeSessionIds: [], roles: {}, workDepthLimit: 4,
          callerPermissionCeiling: facts.permissionCeiling }),
    });
    const coordinate = createProductionWorkflowRunCoordinator({
      token: 'token', accountId: 'account-1', machineId: 'machine-1',
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => encryption,
      isAcceptedAuthorizationCurrent: async () => true,
      execution: { credentials: { token: 'token', encryption: null }, serverId: 'server-1', machineAdmissionTransport,
        resolveExistingSessionConversation: async () => null,
        detachedRun: { actionExecutor: { execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) },
          buildActionContext: () => ({ surface: 'cli', authority: 'account_automation' }) } },
      onCommittedTransition: () => {}, storage: { execute: storage, observeChanges: () => ({ async dispose() {} }) },
      ...(uninstalled ? {
        prepareAcceptedWorkspaceTarget: async () => ({ ok: true as const,
          workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
        resolveMaterializationHost,
      } : {}),
    });
    const failRun = vi.fn(async (_failure: Parameters<Parameters<typeof executeClaimedRun>[0]['claimClient']['failRun']>[0]) => {});
    const definitionContent = uninstalled ? {
      inlineDefinition: { version: 1, inputs: [], defaults: { engine: { agentTarget: {
        kind: 'agent', identity: { pluginId: 'happier.agent.muse', localId: 'muse' },
      } } }, blocks: [{ kind: 'step', id: 'ask', document: { text: 'reply', references: [], attachments: [] },
        input: [], result: { kind: 'text' } }] },
      workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
    } : null;
    const definitionEnvelope = material && uninstalled
      ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
        material: material.material, payload: definitionContent, randomBytes: length => new Uint8Array(length).fill(7) }) }
      : { t: 'plain', v: definitionContent };
    await executeClaimedRun({
      machineId: 'machine-1', heartbeatMs: 60_000, leaseDurationMs: 120_000,
      claimClient: { heartbeatRun: async (request: { leaseDurationMs: number }) => Date.now() + request.leaseDurationMs, failRun },
      coordinateWorkflowRun: coordinate, resolveAutomationAccountEncryption: async () => currentEncryption,
      claimed: { protocol: 'v3', accountCurrentness: witness,
        automation: { id: 'automation-1', name: 'Private refusal', enabled: true },
        run: { id: 'run-private-failure', automationId: 'automation-1', revision: 0, attempt: 1, leaseExpiresAt: Date.now() + 120_000,
          recipeKind: 'workflow-v2', triggerId: null, cause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0,
          executionInputEnvelope: JSON.stringify(definitionEnvelope), resultDelivery: { kind: 'none' } } },
    });
    expect(storage).not.toHaveBeenCalled();
    expect(machineAdmissionTransport).not.toHaveBeenCalled();
    if (!contentIdentityMatches) {
      expect(failRun).not.toHaveBeenCalled();
      return;
    }
    const failure = failRun.mock.calls[0]?.[0];
    expect(failure).toMatchObject({ runId: 'run-private-failure', errorCode: uninstalled ? 'target_unavailable' : 'source_unavailable',
      accountCurrentness: { ...witness, version: 42 } });
    expect(failure).not.toHaveProperty('errorMessage');
    const { protocol: _protocol, runId: _runId, ...body } = failure!;
    expect(AutomationV3WorkerFailRequestSchema.safeParse(body).success).toBe(true);
    const envelope = JSON.parse(String(failure?.errorDetailEnvelope));
    if (uninstalled) {
      const opened = openAutomationRunFailureDetailStoredEnvelopeV1({ mode, envelope,
        ...(material ? { material: material.material } : {}) });
      expect(opened).toMatchObject({ kind: 'available', detail: expect.stringContaining('agent_not_installed') });
      expect(opened).toMatchObject({ detail: expect.stringContaining('not installed on this Machine') });
      if (mode === 'e2ee') expect(String(failure?.errorDetailEnvelope)).not.toContain('agent_not_installed');
      return;
    }
    if (mode === 'plain') {
      expect(envelope).toEqual({ t: 'plain', v: { v: 1,
        correspondence: { automationId: 'automation-1', runId: 'run-private-failure' },
        detail: 'Workflow trigger admission refused: source_unavailable' } });
    } else {
      expect(envelope).toMatchObject({ t: 'encrypted' });
      expect(String(failure?.errorDetailEnvelope)).not.toContain('Workflow trigger admission refused');
      expect(readAccountScopedCiphertextKindByte(envelope.c)).toBe(22);
    }
  });
});
