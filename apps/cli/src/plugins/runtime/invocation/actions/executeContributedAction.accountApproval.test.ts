import { expect, it } from 'vitest';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { createExternalActionRuntime } from '@/daemon/externalActions/externalActionRuntime.testkit';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { executeContributedAction } from './executeContributedAction';

it.each(['agent', 'mcp'] as const)('defers ordinary Account approvals for %s with the existing durable receipt', async surface => {
  let stored: TargetActionApprovalRequestV1 | null = null;
  let effects = 0;
  const runtime = createExternalActionRuntime('global', 'acme.account-approval', () => { effects++; },
    undefined, undefined, undefined, undefined, 'writesRemote', undefined,
    { executionTarget: 'account', surfaces: [surface] });
  // Artifact persistence is replaced; the real target registry, approval
  // placement and current-intent policy decide custody and defer execution.
  const requestCurrentIntent = createTargetActionCurrentIntentAdapter({
    create: async request => { stored = request; return { artifactId: 'account-approval', request }; },
    read: async () => stored,
  });
  const context = { surface, runtimeAccountId: 'account', serverId: 'server-external',
    authority: 'account_automation' as const, actionCaller: { kind: 'host' as const } };
  const result = await executeContributedAction({ runtimeRegistry: runtime,
    actionId: 'acme.account-approval/inspect', input: {}, context, approvalContext: context, requestCurrentIntent });
  expect(result).toMatchObject({ matched: true, result: { ok: true, result: {
    kind: 'approval_request_created', artifactId: 'account-approval', actionId: 'action.invoke',
  } } });
  expect(stored).toMatchObject({ status: 'open', requestedSurface: surface,
    replayPlacement: { serverId: 'server-external', machineId: 'machine-local' } });
  expect(stored).not.toHaveProperty('approvalInputCustody', 'live_only');
  expect(effects).toBe(0);
});

it('retains live-only custody for declared Account secrets without a live receipt writer', async () => {
  let creates = 0;
  let effects = 0;
  const runtime = createExternalActionRuntime('global', 'acme.account-secret', () => { effects++; },
    undefined, undefined, undefined, undefined, 'writesRemote', undefined,
    { executionTarget: 'account', surfaces: ['mcp'],
      inputSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false },
      inputHints: { fields: [{ path: 'token', title: 'Token', widget: 'secret' }] } });
  const requestCurrentIntent = createTargetActionCurrentIntentAdapter({
    create: async request => { creates++; return { artifactId: 'secret-approval', request }; },
    read: async () => null,
  });
  const context = { surface: 'mcp' as const, runtimeAccountId: 'account', serverId: 'server-external',
    authority: 'account_automation' as const, actionCaller: { kind: 'host' as const } };
  expect(await executeContributedAction({ runtimeRegistry: runtime, actionId: 'acme.account-secret/inspect',
    input: { token: 'fixture-secret' }, context, approvalContext: context, requestCurrentIntent }))
    .toMatchObject({ matched: true, result: { ok: false, errorCode: 'plugin_action_current_intent_unavailable' } });
  expect({ creates, effects }).toEqual({ creates: 0, effects: 0 });
});

it.each([false, true])('keeps declared Account secrets live and redacted without replay placement=%s', async withoutReplayPlacement => {
  let stored: TargetActionApprovalRequestV1 | null = null;
  let effects = 0;
  let published!: () => void;
  const created = new Promise<void>(resolve => { published = resolve; });
  const controller = new AbortController();
  const runtime = createExternalActionRuntime('global', 'acme.account-secret-wait', () => { effects++; },
    undefined, withoutReplayPlacement ? () => null : undefined, undefined, undefined, 'writesRemote', undefined,
    { executionTarget: 'account', surfaces: ['mcp'],
      inputSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false },
      inputHints: { fields: [{ path: 'token', title: 'Token', widget: 'secret' }] } });
  const requestCurrentIntent = createTargetActionCurrentIntentAdapter({
    create: async (request, onReady) => {
      stored = request;
      onReady?.({ artifactId: 'live-account-approval', request });
      published();
      return { artifactId: 'live-account-approval', request };
    },
    read: async () => stored,
    update: async ({ request }) => { stored = request; return { ok: true }; },
    subscribeChanges: () => ({ dispose() {} }),
  });
  const context = { surface: 'mcp' as const, runtimeAccountId: 'account', serverId: 'server-external',
    signal: controller.signal, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const } };
  let settled = false;
  const pending = executeContributedAction({ runtimeRegistry: runtime, actionId: 'acme.account-secret-wait/inspect',
    input: { token: 'fixture-secret' }, context, approvalContext: context, requestCurrentIntent })
    .finally(() => { settled = true; });
  try {
    expect(await Promise.race([created.then(() => true), pending.then(() => false)])).toBe(true);
    expect(stored).toMatchObject({ status: 'open', approvalInputCustody: 'live_only' });
    expect(JSON.stringify(stored)).not.toContain('fixture-secret');
    expect({ settled, effects }).toEqual({ settled: false, effects: 0 });
  } finally { controller.abort(); await pending; }
});
