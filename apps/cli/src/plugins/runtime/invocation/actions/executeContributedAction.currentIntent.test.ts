import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { bindPresentUserActionConfirmationV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

import { createExternalActionRuntime } from '@/daemon/externalActions/externalActionRuntime.testkit';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker } from './createCommittedContributedActionDeps';

it('carries the pressed contributed Action review back to the Person without opening an Inbox approval', async () => {
  const pluginId = 'acme.native-write';
  const privateValue = 'private-native-parameter';
  const input = { statement: 'UPDATE example SET value = $1', value: privateValue };
  const action = { action: { pluginId, localId: 'inspect' }, input };
  const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    runtimeAccountId: 'person', serverId: 'home', actionRequestId: 'present-write' } satisfies ActionExecutorContext;
  const writes: unknown[] = [];
  const runtime = createExternalActionRuntime('global', pluginId, undefined,
    undefined, undefined, undefined, undefined, 'writesRemote', undefined, {
      surfaces: ['ui'], placementBindings: [],
      inputSchema: { type: 'object', properties: { statement: { type: 'string' }, value: { type: 'string' } },
        required: ['statement', 'value'] },
      inputHints: { fields: [{ path: 'value', title: 'Bound parameter', widget: 'secret' }] },
      onInput: value => writes.push(value),
    });
  const lease = { registry: runtime, source: 'ephemeral' as const, durableRevision: -1, release: async () => {} };
  const executor = createActionExecutor({
    listContributedActionDefinitions: createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease }),
    invokeContributedAction: createCommittedContributedActionInvoker({
      acquireRuntimeRegistryLease: async () => lease,
      daemonHoldsApprovalWaiter: true,
      requestCurrentIntent: async () => { throw new Error('A Person press should not publish an Inbox approval'); },
    }),
  });
  try {
    const review = await executor.execute('action.invoke', action, context);
    expect(review).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required',
      details: { reviewDigest: expect.any(String), review: { preview: { contributedAction: expect.any(Object) } } } });
    expect(JSON.stringify(review)).toContain(input.statement);
    expect(JSON.stringify(review).includes(privateValue)).toBe(false);
    expect(writes).toEqual([]);
    if (review.ok) throw new Error('The native write must be reviewed first');
    const reviewDigest = (review.details as { reviewDigest: string }).reviewDigest;
    const confirmed = bindPresentUserActionConfirmationV1('action.invoke', action, context, reviewDigest);
    expect(await executor.execute('action.invoke', action, confirmed)).toMatchObject({ ok: true });
    expect(writes).toEqual([input]);
  } finally {
    await runtime.dispose();
  }
});
