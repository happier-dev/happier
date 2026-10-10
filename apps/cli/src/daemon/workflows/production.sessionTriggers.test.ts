import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, admitAgentStartV1,
  openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1,
  type WorkflowDefinitionV1,
} from '@happier-dev/protocol';
import * as scm from '@/scm/readWorktreeChangeFingerprint';
import { createProductionWorkflowRunCoordinator, type WorkflowProductionExecutionDeps } from './production';
import { createPlainWorkflowRunKeyCensusFixture } from './workflowRunStorage.testkit';
import { prepareWorkflowAcceptedWorkspaceTarget } from './resolveWorkflowWorkspace';
import type { WorkflowClaimForCoordination } from './worker';

const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
const previousRunId = '1d4dd16c-d69b-4115-a3b0-e3c92f47f3bd';
const accountId = 'account-1';
const machineId = 'machine-1';
const witness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
const project = { machineId, directory: '/repo', checkoutRootPath: '/repo' };
const captured = new Error('accepted_snapshot_captured');
const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {
  agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
}, blocks: [{ kind: 'step', id: 'work', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] };

function execution(): WorkflowProductionExecutionDeps {
  return { credentials: { token: 'token', encryption: null }, serverId: 'server-1',

    machineAdmissionTransport: async () => { throw new Error('No session effect before acceptance'); },
    resolveExistingSessionConversation: async () => { throw new Error('No conversation effect before acceptance'); },
    detachedRun: { actionExecutor: { execute: async () => { throw new Error('No detached effect before acceptance'); } },
      buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) },
  };
}

function claim(source: WorkflowDefinitionV1, previous?: string): WorkflowClaimForCoordination {
  return { runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1', scopeSessionId: 'origin-session',
    causeWorkDepth: 0, accountCurrentness: witness, automationCause: { kind: 'manual', invokedAt: 1 },
    ...(previous ? { lastSucceededRun: { runId: previousRunId, checkpointEnvelope: previous } } : {}),
    definitionEnvelope: JSON.stringify({ t: 'plain', v: { inlineDefinition: source,
      workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } } }),
  };
}

function previousCheckpoint(endFingerprint?: string) {
  // Deliberately construct the old/new wire bytes, including an absent value.
  return JSON.stringify({ t: 'plain', v: { v: 2, binding: { v: 1, purpose: 'checkpoint', accountId, runId: previousRunId },
    content: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: 'previous-root', nextSequence: '1',
      frontier: { nextBlockOrdinal: 1, paused: false }, ...(endFingerprint ? { endFingerprint } : {}) } } });
}

function admissionHarness(prepareWorkspace: typeof prepareWorkflowAcceptedWorkspaceTarget = async () => ({ ok: true, workspaceTarget: { project } })) {
  const snapshots: unknown[] = [];
  const effects: string[] = [];
  const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId,
    resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
    resolveAccountEncryption: async () => ({ kind: 'available', witness }), isAcceptedAuthorizationCurrent: async () => true,
    execution: execution(), onCommittedTransition: () => {},
    prepareAcceptedWorkspaceTarget: prepareWorkspace,
    resolveMaterializationHost: async ({ runId: id, workDepth, directory }) => ({
      effects: { resolveTargetAvailability: async () => true },
      admitLeaf: async (leaf, facts) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, {
        caller: { kind: 'originless', runId: id, runDepth: workDepth }, baseline: { machineId, directory },
        ledSubtreeSessionIds: [], roles: {}, workDepthLimit: 4, callerPermissionCeiling: facts.permissionCeiling,
      }),
    }),
    storage: { observeChanges: () => ({ dispose: async () => {} }), execute: async (operation) => {
      if (operation.operation === 'run-key.census') return createPlainWorkflowRunKeyCensusFixture({ runId: previousRunId, accountId });
      effects.push(operation.operation);
      if (operation.operation !== 'accepted-snapshot.resolve') throw new Error('Unexpected storage effect');
      const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
        envelope: parseWorkflowStoredContentEnvelopeV1(operation.acceptedEnvelope) });
      if (opened.kind !== 'available') throw new Error('Accepted snapshot unavailable');
      snapshots.push(opened.content);
      throw captured;
    } },
  });
  return { coordinate, snapshots, effects };
}

afterEach(() => vi.restoreAllMocks());

describe('scoped workflow claim admission', () => {
  it('refuses a literal self-target inherited through a nested definition before snapshot effects', async () => {
    const harness = admissionHarness();
    const source: WorkflowDefinitionV1 = { ...definition, defaults: { ...definition.defaults,
      conversation: { kind: 'existing_session', sessionId: 'origin-session', machineId } },
      blocks: [{ kind: 'if', id: 'nested', when: { kind: 'compare', operator: 'eq',
        left: { kind: 'literal', value: true }, right: { kind: 'literal', value: true } }, then: definition.blocks, otherwise: [] }] };
    await expect(harness.coordinate(claim(source))).resolves.toMatchObject({ state: 'failed', reason: 'self_target', admission: 'refused' });
    expect(harness.effects).toEqual([]);
  });

  it('allows origin_session through the same scoped claim boundary', async () => {
    const harness = admissionHarness();
    await expect(harness.coordinate(claim({ ...definition, defaults: { ...definition.defaults,
      conversation: { kind: 'origin_session' } } }))).rejects.toBe(captured);
    expect(harness.snapshots[0]).toMatchObject({ origin: { originSessionId: 'origin-session' } });
  });

  it('skips an unchanged claimed tree without freezing a snapshot or starting work', async () => {
    const read = vi.spyOn(scm, 'readWorktreeChangeFingerprint').mockResolvedValue({ kind: 'available', fingerprint: 'F-b' });
    const harness = admissionHarness();
    await expect(harness.coordinate(claim({ ...definition, inputs: [{ name: 'diffFingerprint', valueType: 'string', required: false }] },
      previousCheckpoint('F-b')))).resolves.toEqual({ state: 'skipped', reason: 'diff_unchanged', admission: 'refused' });
    expect(harness.effects).toEqual([]);
    expect(read).toHaveBeenCalledExactlyOnceWith('/repo');
  });

  it('fingerprints the prepared canonical project path rather than its authored home alias', async () => {
    const read = vi.spyOn(scm, 'readWorktreeChangeFingerprint').mockImplementation(async (directory) => directory === '/home/reviewer/repo'
      ? { kind: 'available', fingerprint: 'F-b' } : { kind: 'unavailable' });
    const harness = admissionHarness((input) => prepareWorkflowAcceptedWorkspaceTarget({ ...input,
      env: { NODE_ENV: 'test', HOME: '/home/reviewer' }, platform: 'linux', pathIsDirectory: async () => true,
      inspectLocation: async () => ({ inspection: { rootPath: '/home/reviewer/repo' } }),
    }));
    const occurrence = claim({ ...definition, inputs: [{ name: 'diffFingerprint', valueType: 'string', required: false }] }, previousCheckpoint('F-b'));
    const definitionEnvelope = JSON.stringify({ t: 'plain', v: { inlineDefinition: { ...definition,
      inputs: [{ name: 'diffFingerprint', valueType: 'string', required: false }] },
      workspace: { directory: '~/repo' }, executionTarget: { kind: 'session' } } });
    await expect(harness.coordinate({ ...occurrence, definitionEnvelope })).resolves.toMatchObject({ state: 'skipped', reason: 'diff_unchanged' });
    expect(read).toHaveBeenCalledExactlyOnceWith('/home/reviewer/repo');
    expect(harness.effects).toEqual([]);
  });

  it.each([
    { current: 'F-c', previous: 'F-b', expected: 'F-c' },
    { current: undefined, previous: 'F-b', expected: undefined },
    { current: 'F-b', previous: undefined, expected: 'F-b' },
  ])('runs with changed or unavailable evidence ($current / $previous)', async ({ current, previous, expected }) => {
    vi.spyOn(scm, 'readWorktreeChangeFingerprint').mockResolvedValue(current
      ? { kind: 'available', fingerprint: current } : { kind: 'unavailable' });
    const harness = admissionHarness();
    await expect(harness.coordinate(claim({ ...definition, inputs: [{ name: 'diffFingerprint', valueType: 'string', required: false }] },
      previousCheckpoint(previous)))).rejects.toBe(captured);
    expect(harness.snapshots[0]).toMatchObject({ inputs: expected ? { diffFingerprint: expected } : {} });
  });

  it('does not read SCM when the definition did not opt in', async () => {
    const read = vi.spyOn(scm, 'readWorktreeChangeFingerprint');
    await expect(admissionHarness().coordinate(claim(definition, previousCheckpoint('F-b')))).rejects.toBe(captured);
    expect(read).not.toHaveBeenCalled();
  });
});
