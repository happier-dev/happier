import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionExecutor, type ApprovalRequest } from '@happier-dev/protocol';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ReviewCommentV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import { ReviewCommentActionInputSchemasV1, ReviewCommentActionOutputSchemasV1 } from '@happier-dev/protocol/reviews/comments/actions';

import { reloadConfiguration } from '@/configuration';
import { readRetainedExecutionRunRecord } from '@/daemon/executionRunRegistry';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { finishExecutionRun } from './finishExecutionRun';
import { projectExecutionRunPublicState } from './publicState';
import { createExecutionRunOccurrenceWitnessRegistry, projectExecutionRunInputTurns } from './runOccurrenceWitness';
import { settleExecutionRunController } from './settleExecutionRunController';
import type { ExecutionRunState } from './executionRunTypes';
import { createTestExecutionRunHostRuntime } from './testkit';

let directory: string;
let priorHome: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'happier-run-approval-'));
  priorHome = process.env.HAPPIER_HOME_DIR;
  process.env.HAPPIER_HOME_DIR = directory;
  reloadConfiguration();
});
afterEach(() => {
  if (priorHome === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = priorHome;
  reloadConfiguration();
  rmSync(directory, { recursive: true, force: true });
});

function controllerFixture(occurrenceId: string, kind: ExecutionRunController['kind']): ExecutionRunController {
  const common = { controllerOccurrenceId: occurrenceId, cancelled: false, lastMarkerWriteAtMs: 0,
    terminalPromise: Promise.resolve(), resolveTerminal: () => {} };
  return kind === 'voice_agent' ? {
    ...common, kind, voiceAgentId: 'run', transcript: { persistenceMode: 'ephemeral', epoch: 0 },
    externalStreamIdByInternal: new Map(), internalStreamIdByExternal: new Map(),
    pendingTranscriptTurnByExternalStreamId: new Map(), terminalReadByExternalStreamId: new Map(), readInFlightByExternalStreamId: new Map(),
  } : {
    ...common, kind, backend: createTestExecutionRunHostRuntime(), backendSupportsResume: false, runtimeId: 'native-run',
    buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: 'stream', streamWriter: null,
    turnCount: 0, turnEpoch: 0, turnInFlight: false, turnCancelReason: null, turnCancelEpoch: null,
    admittedLiveInterventions: [], admittedLiveInterventionsSignal: null,
  };
}

describe('terminal Run approval occurrence custody', () => {
  it.each([
    { kind: 'backend', status: 'succeeded', replacement: false },
    { kind: 'backend', status: 'failed', replacement: false },
    { kind: 'backend', status: 'cancelled', replacement: false },
    { kind: 'voice_agent', status: 'succeeded', replacement: false },
    { kind: 'backend', status: 'succeeded', replacement: true },
    { kind: 'voice_agent', status: 'succeeded', replacement: true },
  ] as const)('replays $kind/$status approval once after its Run settles, even after a later occurrence (replacement=$replacement)', async ({ kind, status, replacement }) => {
    const run: ExecutionRunState = {
      runId: 'run', callId: 'call', sidechainId: 'sidechain', sessionId: 'session', depth: 0,
      intent: kind === 'voice_agent' ? 'voice_agent' : 'delegate', backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, instructions: 'Propose an edit',
      permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
      status: 'running', startedAtMs: 1,
    };
    const runs = new Map([[run.runId, run]]);
    const controllers = new Map([[run.runId, controllerFixture('original-occurrence', kind)]]);
    const registry = createExecutionRunOccurrenceWitnessRegistry(controllers);
    const register = () => {
      const controller = controllers.get(run.runId)!;
      const lifetime = new AbortController();
      const registration = registry.register({ runId: run.runId, sidechainId: run.sidechainId, controller,
        runtimeLifetimeSignal: lifetime.signal, readActiveTurnAdmissionWitness: () => null });
      controller.releaseSessionInputAttachment = async () => { registration.dispose(); };
      return lifetime;
    };
    const lifetime = register();
    let approval: ApprovalRequest | null = null;
    let body = 'Original finding';
    let effects = 0;
    const executor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      // Artifact persistence, Home authorization and the comment service are system boundaries.
      approvalsCreate: async ({ request }) => { approval = structuredClone(request); return { artifactId: 'approval' }; },
      approvalsGet: async () => structuredClone(approval),
      approvalsUpdate: async ({ request }) => { approval = structuredClone(request); return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
      executionRunGet: async () => {
        const current = runs.get(run.runId)!;
        const inputTurns = projectExecutionRunInputTurns({ runId: run.runId, retained: current.inputTurns,
          controller: controllers.get(run.runId), reader: registry.reader });
        return ExecutionRunGetResponseSchema.parse({ run: projectExecutionRunPublicState({ ...current, inputTurns }) });
      },
      reviewCommentAction: async ({ input }) => {
        const nextBody = ReviewCommentActionInputSchemasV1['reviews.comments.edit'].parse(input).nextBody;
        if (typeof nextBody === 'string') body = nextBody;
        else if (nextBody.t === 'plain' && typeof nextBody.v === 'string') body = nextBody.v;
        else throw new Error('Expected the plain comment-edit boundary');
        effects += 1;
        return ReviewCommentActionOutputSchemasV1['reviews.comments.edit'].parse({ comment: ReviewCommentV1Schema.parse({
          v: 1, id: 'comment', accountId: 'account', workspace: { machineId: 'machine', path: '/workspace' }, sessionId: 'session',
          anchor: { kind: 'file', filePath: 'a.ts' }, snapshot: { kind: 'none', capturedAt: 1 }, body,
          bodyVersion: 2, edits: [], author: { kind: 'plugin', pluginId: 'acme.external-review' }, state: 'open', flags: {},
          dispositions: {}, threadId: 'comment', transitions: [], createdAt: 1, updatedAt: 2, serverRevision: 2,
        }) });
      },
    });
    await expect(executor.execute('reviews.comments.edit', {
      workspace: { machineId: 'machine', path: '/workspace' }, commentId: 'comment',
      expectedServerRevision: 1, expectedBodyVersion: 1, nextBody: 'Approved edit', clientMutationId: 'edit',
    }, {
      surface: 'agent', authority: 'account_automation', serverId: 'home', serverIdentityId: 'srv_home',
      actionRequestId: 'request', defaultSessionId: 'session', defaultSessionMachineId: 'machine',
      runtimeRunId: run.runId, runtimeRunOccurrenceId: 'original-occurrence',
      actionCaller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 },
      reviewCommentPrincipal: { actor: { kind: 'agent', agentId: 'acme.external/agent', sessionId: 'session' } },
    })).resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(approval).toMatchObject({ executionOriginV1: { runId: run.runId, runOccurrenceId: 'original-occurrence' } });
    expect(body).toBe('Original finding');

    if (replacement) {
      controllers.set(run.runId, controllerFixture('replacement-occurrence', kind));
      register();
    }
    // Native failure/Stop can retire live authority before host terminal publication.
    if (status !== 'succeeded') lifetime.abort();
    await finishExecutionRun({ runId: run.runId, next: { status, finishedAtMs: 2 }, toolResult: { output: 'Finished' },
      runs, controllers, budgetRegistry: null, parentProvider: 'codex', sendAcp: async () => {},
      enqueueMarkerWrite: async (_id, write) => { await write(); }, terminalMarkerWritePromises: new Map() });
    const controller = controllers.get(run.runId)!;
    await settleExecutionRunController({ runId: run.runId, controller, controllers });
    expect(controllers.size).toBe(0);
    expect(registry.reader.readCurrentRunOccurrence(run.runId)).toBeNull();
    // Read the producer's sealed persisted state through its actual restart reader.
    const retained = await readRetainedExecutionRunRecord(run.runId);
    expect(retained?.state.status).toBe(status);
    // Source identity survives independently of optional parent-report custody.
    expect(retained?.state).toMatchObject({ terminalOccurrenceId: expect.any(String) });
    runs.set(run.runId, retained!.state);
    const decide = () => executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
      surface: 'cli', authority: 'present_user', serverId: 'home', serverIdentityId: 'srv_home',
      runtimeAccountId: 'account', actionCaller: { kind: 'host' },
    });
    const decision = await decide();
    // The exact reviewed edit is approved; a later Run occurrence does not withdraw it.
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(body).toBe('Approved edit');
    expect(effects).toBe(1);
    await decide();
    expect(effects).toBe(1);
  });
});
