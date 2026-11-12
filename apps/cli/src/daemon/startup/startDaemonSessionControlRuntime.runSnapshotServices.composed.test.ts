import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';

import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import {
  AgentRuntimeDaemonServiceRequestV1Schema,
  AgentRuntimeDaemonServiceResponseV1Schema,
  type AgentRuntimeDaemonServiceRequestV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The listener is an OS boundary. The fixture supplies Home responses; startup,
// snapshot acquisition/release, invocation preparation and dispatch stay real.
vi.mock('@/daemon/controlServer', () => ({
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
  },
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); boundary.control = null; });

it('preserves the real snapshot service failure and its diagnostic cause', async () => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control);
  const services = boundary.control?.agentRuntimeDaemonServices;
  if (!services) throw new Error('Missing production daemon service dispatch');
  const privateText = 'PRIVATE_EXCEPTION_TEXT';
  const failures = [
    { error: new TypeError(privateText), code: 'runner_plugin_services_unavailable',
      cause: { code: 'TypeError', stage: 'dispatch' } },
    { error: new PluginError({ code: 'provider_model_not_found', message: privateText,
        details: { cause: { code: 'ENOENT', stage: 'registry_acquisition' } } }),
      code: 'provider_model_not_found', cause: { code: 'ENOENT', stage: 'registry_acquisition' } },
  ];
  for (const failure of failures) {
    // Cancellation is an OS boundary; all snapshot and failure projection logic remains real.
    const result = AgentRuntimeDaemonServiceResponseV1Schema.parse(await services.dispatch(
      AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
        context: { token: 'a'.repeat(43), sessionId: h.sessionId },
        operation: { kind: 'execution_run.snapshot.acquire_v1' } }),
      { sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent,
        trackedSession: h.tracked, invocationContext: h.tracked.runnerAgentInvocationContext!,
        isCurrent: async () => true, signal: AbortSignal.abort(failure.error) }));
    expect(result).toMatchObject({ ok: false, error: { code: failure.code, cause: failure.cause } });
    expect(JSON.stringify(result)).not.toContain(privateText);
  }
});

it('keeps exact Run service custody through rejected replacements and permits only close after snapshot release', async () => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control);
  const services = boundary.control?.agentRuntimeDaemonServices;
  if (!services) throw new Error('Missing production daemon service dispatch');
  const context = { sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent,
    trackedSession: h.tracked, invocationContext: h.tracked.runnerAgentInvocationContext!,
    isCurrent: async () => true, signal: h.signal };
  const dispatch = async (operation: AgentRuntimeDaemonServiceRequestV1['operation'], snapshotId?: string,
    activeContext = context) => AgentRuntimeDaemonServiceResponseV1Schema.parse(await services.dispatch(
      AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
        context: { token: 'a'.repeat(43), sessionId: activeContext.sessionId,
          ...(snapshotId ? { executionRunSnapshotId: snapshotId } : {}) }, operation }), activeContext));
  const acquire = async (activeContext = context) => {
    const response = await dispatch({ kind: 'execution_run.snapshot.acquire_v1',
      backendTarget: { kind: 'backend', backendId: h.retainedAgent.agentId } }, undefined, activeContext);
    if (!response.ok || response.result.kind !== 'execution_run.snapshot') throw new Error('Missing real Run snapshot');
    return response.result.snapshotId;
  };
  const first = await acquire();
  const replacement = await acquire();
  const foreignParent = { ...context, sessionId: 'foreign-parent',
    trackedSession: { ...h.tracked, happySessionId: 'foreign-parent' } };
  const foreign = await acquire(foreignParent);
  const prepare = () => ({ kind: 'plugin_services.prepare_v1' as const,
    ...h.operationBase('resumed-run'), executionRunCwd: h.cwd });
  const read = () => ({ kind: 'plugin_storage.get_v1' as const,
    ...h.operationBase('resumed-run'), scope: 'ephemeral' as const, key: 'custody' });
  const close = () => ({ kind: 'plugin_services.close_v1' as const, ...h.operationBase('resumed-run') });
  const unavailableSnapshot = { ok: false, error: { code: 'execution_run_contribution_snapshot_unavailable' } };

  expect(await dispatch(prepare(), first)).toMatchObject({ ok: true });
  expect(await dispatch({ kind: 'plugin_storage.set_v1', ...h.operationBase('resumed-run'),
    scope: 'ephemeral', key: 'custody', value: { t: 'string', value: 'first-occurrence' } }, first)).toMatchObject({ ok: true });
  for (const rejected of [randomUUID(), foreign]) {
    expect(await dispatch(prepare(), rejected)).toMatchObject(unavailableSnapshot);
    // Rejection must preserve the actual invocation and its state, not merely
    // leave a retained authority row that no longer owns working services.
    expect(await dispatch(read(), first)).toMatchObject({ ok: true,
      result: { value: { t: 'string', value: 'first-occurrence' } } });
  }
  expect(await dispatch(prepare(), replacement)).toMatchObject({ ok: true });
  expect(await dispatch(close(), first)).toMatchObject({ ok: false,
    error: { code: 'plugin_services_invocation_unavailable' } });
  expect(await dispatch(read(), replacement)).toMatchObject({ ok: true });

  expect(await dispatch({ kind: 'execution_run.snapshot.release_v1', snapshotId: replacement })).toMatchObject({ ok: true });
  expect(await dispatch(read(), replacement)).toMatchObject(unavailableSnapshot);
  for (const activeContext of [foreignParent,
    { ...context, runner: { ...h.runner, snapshotIdentity: 'foreign-runner' } },
    { ...context, retainedAgent: { ...h.retainedAgent, pluginVersion: 'foreign-parent' } }]) {
    expect(await dispatch(close(), replacement, activeContext)).toMatchObject({ ok: false,
      error: { code: 'plugin_services_invocation_unavailable' } });
  }
  expect(await dispatch(close(), replacement)).toMatchObject({ ok: true });
  expect(await dispatch(close(), replacement)).toMatchObject({ ok: false,
    error: { code: 'plugin_services_invocation_unavailable' } });
  expect(await dispatch({ kind: 'execution_run.snapshot.release_v1', snapshotId: first })).toMatchObject({ ok: true });
  expect(await dispatch({ kind: 'execution_run.snapshot.release_v1', snapshotId: foreign }, undefined, foreignParent)).toMatchObject({ ok: true });
});
