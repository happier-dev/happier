import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import { reloadConfiguration } from '@/configuration';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import type { RpcActionExecutorContext } from '../_actionDispatchAdapter';
import { createExecutionRunRpcActionExecutor } from './dispatchExecutionRunRpcAction';

describe('detached Run starting Account isolation', () => {
  let directory: string;
  let manager: ExecutionRunHostBridge;
  const attribution = { serverId: 'home', accountId: 'alice', machineId: 'machine', installationId: 'installation' };
  const cases = [
    { actionId: 'execution.run.get', input: {} },
    { actionId: 'execution.run.wait', input: {} },
    { actionId: 'execution.run.stop', input: {} },
    { actionId: 'execution.run.send', input: { message: 'Foreign input', localInputId: 'foreign-input' } },
    { actionId: 'execution.run.send', input: { message: 'Foreign resume', localInputId: 'foreign-resume', resume: true } },
    { actionId: 'execution.run.ensure', input: { resume: true } },
    { actionId: 'execution.run.ensure_or_start', input: { resume: true } },
    { actionId: 'execution.run.cancel_turn', input: { occurrenceId: 'occurrence', turnId: 'turn' } },
    { actionId: 'execution.run.stream.start', input: { message: 'Foreign stream' } },
    { actionId: 'execution.run.stream.read', input: { streamId: 'stream', cursor: 0 } },
    { actionId: 'execution.run.stream.cancel', input: { streamId: 'stream' } },
    { actionId: 'execution.run.action', input: { actionId: 'review.triage', input: {} } },
  ] satisfies ReadonlyArray<{ actionId: ActionId; input: Record<string, unknown> }>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'happier-detached-run-account-'));
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    reloadConfiguration();
    // Real retained storage and bridge recovery; no Run/authorization logic is mocked.
    const run: ExecutionRunState = {
      runId: 'alice-run', callId: 'alice-call', sidechainId: 'alice-sidechain', sessionId: null,
      depth: 0, intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
      instructions: 'Private Alice instructions', permissionMode: 'read_only', retentionPolicy: 'resumable',
      runClass: 'bounded', ioMode: 'request_response', status: 'cancelled', startedAtMs: 1, finishedAtMs: 2,
      requesterWorkAttributionV1: attribution,
    };
    await retainExecutionRunState(run);
    await retainExecutionRunState({ ...run, runId: 'bob-run', callId: 'bob-call', sidechainId: 'bob-sidechain',
      requesterWorkAttributionV1: { ...attribution, accountId: 'bob' } });
    await retainExecutionRunState({ ...run, runId: 'legacy-run', callId: 'legacy-call', sidechainId: 'legacy-sidechain',
      requesterWorkAttributionV1: undefined });
    manager = new ExecutionRunHostBridge({ parentProvider: 'daemon.executionRuns', cwd: directory, sendAcp: async () => {} });
  });

  afterEach(async () => {
    await manager?.dispose();
    vi.unstubAllEnvs();
    reloadConfiguration();
    await rm(directory, { recursive: true, force: true });
  });

  function requester(accountId: string, role: 'use' | 'manage'): RpcActionExecutorContext {
    return { surface: 'rpc', authority: 'present_user', serverId: 'home',
      // An installed/custodian runtime Account is not the admitted caller.
      runtimeAccountId: 'alice', requesterWorkAttributionV1: attribution,
      machineAdmission: { actorAccountId: accountId, custodianAccountId: 'alice', machineId: 'machine',
        installationId: 'installation', role, encryptionMode: 'plain' } };
  }

  function executor() {
    return createExecutionRunRpcActionExecutor({ manager, context: { sessionId: null, cwd: directory },
      policy: resolveExecutionRunPolicy({ defaults: { maxConcurrentRuns: null,
        boundedTimeoutMs: null, reviewBoundedTimeoutMs: null, maxTurns: null } }), isExecutionRunsEnabled: () => true });
  }

  it.each((['use', 'manage'] as const).flatMap(role => cases.map(test => ({ ...test, role }))))
  ('refuses another Account $role requester for $actionId ($input)', async ({ actionId, input, role }) => {
    await manager.recoverRetainedRuns();
    if (actionId === 'execution.run.stop') {
      const live = manager.get('alice-run')!;
      live.status = 'running';
      await retainExecutionRunState(live);
    }
    const before = structuredClone(manager.get('alice-run'));
    const request = { sessionId: null, runId: 'alice-run', ...input };
    getActionSpec(actionId).inputSchema.parse(request);
    const result = await executor().execute(actionId, request, requester('bob', role));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
    expect(manager.get('alice-run')).toEqual(before);
  });

  it.each(['use', 'manage'] as const)('lists only the requester Account Runs for %s', async role => {
    const result = await executor().execute('execution.run.list', { sessionId: null }, requester('bob', role));
    expect(result).toMatchObject({ ok: true, result: { runs: [{ runId: 'bob-run' }] } });
    expect(JSON.stringify(result)).not.toContain('alice-run');
    expect(JSON.stringify(result)).not.toContain('legacy-run');
  });

  it('selects the owner newest Runs before applying a list limit', async () => {
    await manager.recoverRetainedRuns();
    const own = manager.get('bob-run')!;
    own.startedAtMs = 3;
    const foreign = manager.get('alice-run')!;
    foreign.startedAtMs = 4;
    await retainExecutionRunState(own);
    await retainExecutionRunState(foreign);
    await retainExecutionRunState({ ...own, runId: 'bob-older', callId: 'bob-older-call', sidechainId: 'bob-older-sidechain', startedAtMs: 1 });
    await retainExecutionRunState({ ...foreign, runId: 'alice-older', callId: 'alice-older-call', sidechainId: 'alice-older-sidechain', startedAtMs: 0 });
    // A fresh bridge reads the same retained records, including the newer foreign Run.
    await manager.dispose();
    manager = new ExecutionRunHostBridge({ parentProvider: 'daemon.executionRuns', cwd: directory, sendAcp: async () => {} });
    expect(await executor().execute('execution.run.list', { sessionId: null, limit: 1 }, requester('bob', 'use')))
      .toMatchObject({ ok: true, result: { runs: [{ runId: 'bob-run' }] } });
  });

  it('stamps an external-action start without Machine admission and keeps owner control', async () => {
    const callerInputAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-private-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
      actionId: 'execution.run.start', requestId: 'external-start', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' },
    } });
    const context: RpcActionExecutorContext = { surface: 'rpc', authority: 'present_user', serverId: 'home', callerInputAuthorization };
    const start = await executor().execute('execution.run.start', { sessionId: null, intent: 'agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, instructions: 'Keep starting Account on retained failure',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
    }, context);
    // Native preparation is deliberately absent: the real start must retain its
    // failed Run with the same starting Account used by later controls.
    const created = manager.listPublic().filter(run => !['alice-run', 'bob-run', 'legacy-run'].includes(run.runId));
    expect(created, JSON.stringify(start)).toHaveLength(1);
    const run = manager.get(created[0]!.runId)!;
    expect(run.requesterWorkAttributionV1).toEqual({ ...attribution, accountId: 'bob' });
    expect(await executor().execute('execution.run.get', { sessionId: null, runId: run.runId }, context))
      .toMatchObject({ ok: true, result: { run: { runId: run.runId } } });
  });

  it('keeps the starting Account read and stop path available', async () => {
    const runExecutor = executor();
    expect(await runExecutor.execute('execution.run.get', { sessionId: null, runId: 'alice-run' }, requester('alice', 'use')))
      .toMatchObject({ ok: true, result: { run: { runId: 'alice-run' } } });
    const live = manager.get('alice-run')!;
    live.status = 'running';
    await retainExecutionRunState(live);
    const stopped = await runExecutor.execute('execution.run.stop', { sessionId: null, runId: 'alice-run' }, requester('alice', 'use'));
    expect(stopped, JSON.stringify(stopped)).toMatchObject({ ok: true });
  });

  it('does not grant the Machine custodian access to another Account Run', async () => {
    expect(await executor().execute('execution.run.get', { sessionId: null, runId: 'bob-run' }, requester('alice', 'manage')))
      .toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
  });

  it('refuses missing requester and missing stored starting Account', async () => {
    expect(await executor().execute('execution.run.get', { sessionId: null, runId: 'alice-run' }, { surface: 'rpc', runtimeAccountId: 'alice' }))
      .toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
    expect(await executor().execute('execution.run.get', { sessionId: null, runId: 'legacy-run' }, requester('alice', 'manage')))
      .toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
  });
});
