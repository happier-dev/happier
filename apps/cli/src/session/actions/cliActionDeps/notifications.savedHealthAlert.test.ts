import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createCliNotificationActionDeps } from './notifications';
import { createSavedHealthAlertTestForHost } from '@/notifications/activity/savedHealthAlertDelivery';
import { prepareApprovalRequest, buildApprovalSummary } from '@happier-dev/protocol/actions/executor/approvalPreparation';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SAVED_HEALTH_ALERT_TEST_ACTION_ID } from '@happier-dev/protocol/actions/notificationConfigurationActionIds';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';

const network = vi.hoisted(() => ({ call: vi.fn() }));
// Machine RPC is the network boundary; the public selector and host adapter remain real.
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callExactMachineRpc: network.call }));
afterEach(() => vi.clearAllMocks());

it.each(['ui', 'agent'] as const)('discloses the exact saved destination and controller before a %s Test confirmation', async surface => {
    const input = { serverId: 'home', machineId: 'controller', sourceInstanceId: 'saved-source',
        channelId: 'happier.channel.slack/alerts', channelIndex: 0, expectedSourceRevision: 'source-revision' };
    const destination = { connectionId: 'production-slack', endpoint: { kind: 'shared', audience: 'shared', id: 'C1', label: 'Production alerts' } };
    network.call.mockResolvedValue({ request: input, controllerMachineId: 'controller', destination,
        disclosure: 'Readable notification text leaves Happier, including for an end-to-end encrypted Account.' });
    const deps = createCliNotificationActionDeps({ credentials: { token: 'account-token', encryption: null },
        serverId: 'home', serverHttpBaseUrl: 'https://home.test' }, null);
    const review = await prepareApprovalRequest({
        // This preparation uses only the real notification host ports; unrelated executor ports are not reached.
        deps: deps as ActionExecutorDeps, actionId: SAVED_HEALTH_ALERT_TEST_ACTION_ID,
        input, actionArgs: input, context: { surface },
    });
    if (!review || 'ok' in review) throw new Error('Expected a readonly approval review');
    const summary = buildApprovalSummary(getActionSpec(SAVED_HEALTH_ALERT_TEST_ACTION_ID), input, review.preview);
    expect(summary).toContain('controller');
    expect(summary).toContain(destination.connectionId);
    expect(summary).toContain(destination.endpoint.id);
    expect(summary).toContain('end-to-end encrypted');
    expect(network.call.mock.calls.every(([request]) => request.request.kind === 'prepareTest')).toBe(true);
});

it('preserves a controller refusal before parsing a saved alert Test success', async () => {
    const refusal = { errorCode: 'health_check_source_revision_mismatch', error: 'Saved source changed',
        effectAttempted: false, details: { controllerMachineId: 'replacement-controller' } };
    network.call.mockResolvedValue(refusal);
    const test = createSavedHealthAlertTestForHost({ credentials: { token: 'account-token', encryption: null },
        serverId: 'home', serverHttpBaseUrl: 'https://home.test' });
    expect(await test({ serverId: 'home', machineId: 'controller', sourceInstanceId: 'saved-source',
        channelId: 'happier.channel.slack/alerts', channelIndex: 0, expectedSourceRevision: 'old-source-revision' }))
        .toEqual({ ok: false, ...refusal });
});

it('routes a saved alert Test to its addressed controller without accepting caller destination or content', async () => {
    const credentials = { token: 'account-token', encryption: null };
    const input = { serverId: 'home', machineId: 'controller', sourceInstanceId: 'saved-source',
        channelId: 'happier.channel.slack/alerts', channelIndex: 0, expectedSourceRevision: 'source-revision' };
    const result = { status: 'sent', controllerMachineId: 'controller', channelId: input.channelId };
    network.call.mockResolvedValue(result);
    const deps = createCliNotificationActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.test' }, null);
    expect(await deps.notificationConfigurationAction?.({ actionId: 'notifications.test', input,
        context: { surface: 'cli' } })).toEqual(result);
    expect(network.call).toHaveBeenCalledWith(expect.objectContaining({ credentials, machineId: 'controller',
        serverUrl: 'https://home.test', method: RPC_METHODS.DAEMON_SERVICE_HEALTH_DELIVER,
        requireCurrentMachine: true, requiredMachineKind: 'persistent',
        request: { kind: 'test', ...input } }));
});
