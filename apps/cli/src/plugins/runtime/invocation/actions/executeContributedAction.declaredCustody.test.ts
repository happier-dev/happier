import { expect, it } from 'vitest';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { createExternalActionRuntime } from '@/daemon/externalActions/externalActionRuntime.testkit';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { executeContributedAction } from './executeContributedAction';

it.each([{ parameters: [] }, { parameters: ['private-parameter'] }])('keeps declared SQL operands live-only and parameter values confidential: %j', async ({ parameters }) => {
  let stored: TargetActionApprovalRequestV1 | null = null;
  let effects = 0;
  let published!: () => void;
  const created = new Promise<void>(resolve => { published = resolve; });
  const controller = new AbortController();
  const runtime = createExternalActionRuntime('global', 'acme.live-sql', () => { effects++; },
    undefined, undefined, undefined, undefined, 'writesRemote', undefined,
    { surfaces: ['cli'], approvalInputCustody: 'live_only', secretInputPaths: ['parameters.[]'],
      inputSchema: { type: 'object', properties: { sql: { type: 'string' }, parameters: { type: 'array', items: { type: 'string' } } },
        required: ['sql', 'parameters'], additionalProperties: false } });
  const requestCurrentIntent = createTargetActionCurrentIntentAdapter({
    create: async (request, onReady) => {
      stored = request;
      onReady?.({ artifactId: 'live-sql-approval', request });
      published();
      return { artifactId: 'live-sql-approval', request };
    },
    read: async () => stored,
    update: async ({ request }) => { stored = request; return { ok: true }; },
    subscribeChanges: () => ({ dispose() {} }),
  });
  const context = { surface: 'cli' as const, runtimeAccountId: 'account', serverId: 'server-external',
    signal: controller.signal, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const } };
  const pending = executeContributedAction({ runtimeRegistry: runtime, actionId: 'acme.live-sql/inspect',
    input: { sql: 'DELETE FROM users', parameters }, context, approvalContext: context, requestCurrentIntent });
  try {
    expect(await Promise.race([created.then(() => true), pending.then(() => false)])).toBe(true);
    expect(stored).toMatchObject({ status: 'open', approvalInputCustody: 'live_only' });
    expect(JSON.stringify(stored)).toContain('DELETE FROM users');
    expect(JSON.stringify(stored)).not.toContain('private-parameter');
    expect(effects).toBe(0);
  } finally {
    controller.abort();
    await pending;
  }
});
