import { SAVED_HEALTH_ALERT_TEST_ACTION_ID } from '@happier-dev/protocol/actions/notificationConfigurationActionIds';
import { NotificationConfigurationActionInputSchemas, SavedHealthAlertTestResultSchema, SavedHealthAlertTestApprovalReviewSchema,
    type SavedHealthAlertTestResult, type SavedHealthAlertTestApprovalReview } from '@happier-dev/protocol/actions/notificationConfigurationActionFamily';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope, readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import type { StoredCredentials } from '@/persistence';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { createCliHealthCheckSourceReader } from '@/session/actions/workflowTriggers';
import { createCliNotificationCatalogForHost } from '@/session/actions/cliActionDeps/notifications';
import { createHostPluginNotificationChannels } from './pluginNotificationChannels';
import { dispatchSavedHealthAlertTestAsync, listActivityNotificationChannels } from './dispatchActivityNotification';
import { PushNotificationClient } from '@/api/pushNotifications';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliDeploymentActionDeps } from '@/deployments/createCliDeploymentActionDeps';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { HealthCheckSourceConfigV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import { projectSavedHealthAlertSelection } from '@/deployments/healthChecks/readSavedHealthCheckSource';

export type SavedHealthAlertTestRequest = import('@happier-dev/protocol/actions/notificationConfigurationActionFamily').SavedHealthAlertTestApprovalReview['request'];
export type SavedHealthAlertTestForHostResult = SavedHealthAlertTestResult | ActionExecuteFailure;
type SavedHealthAlertTestHost = Readonly<{
    credentials: StoredCredentials; accountId: string; serverId: string; serverHttpBaseUrl: string;
    machineId: string; isCurrent?: () => boolean | Promise<boolean>;
}>;

/** Each preview or effect boundary reads its current saved selection once. */
async function readSavedHealthAlertTestSelection(host: SavedHealthAlertTestHost, selector: SavedHealthAlertTestRequest, signal: AbortSignal): Promise<
    SavedHealthAlertTestForHostResult | Readonly<{ kind: 'selected'; channel: NonNullable<HealthCheckSourceConfigV1['alerts']>['channels'][number];
        target: Readonly<{ controllerMachineId: string; channelId: string }> }>> {
        const target = { controllerMachineId: host.machineId, channelId: selector.channelId };
        const unavailable = (reason: string): SavedHealthAlertTestResult => ({ status: 'unavailable', ...target, reason });
        let source;
        try { source = await createCliHealthCheckSourceReader({ ...host, signal })(selector.sourceInstanceId); }
        catch (error) {
            signal.throwIfAborted();
            if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
                return unavailable(error.code);
            }
            throw error;
        }
        if (!source) return unavailable('health_check_source_unconfigured');
        if (source.revision !== selector.expectedSourceRevision) return unavailable('health_check_source_revision_changed');
        const subject = source.source.subject;
        let controllerMachineId: string | null = subject.kind === 'machineService' ? source.observer?.machineId ?? null : null;
        if (subject.kind === 'environment') {
            const { deploymentAction } = createCliDeploymentActionDeps({ serverHttpBaseUrl: host.serverHttpBaseUrl,
                localAccount: { accountId: host.accountId, token: host.credentials.token },
                admitAccount: async serverId => serverId === host.serverId ? null
                    : { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' },
                resolveRequestHeaders: async () => ({ ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                    Authorization: `Bearer ${host.credentials.token}` }),
                dispatchReceipt: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' }),
            });
            const result = await deploymentAction!('deployments.environments.get', {
                serverId: host.serverId, environmentId: subject.environmentId,
            }, { signal });
            const failure = readActionFailureEnvelope(result, { treatReturnedErrorEnvelopeAsFailure: true });
            if (failure) return failure;
            const opened = DeploymentEnvironmentGetResultV1Schema.parse(result);
            if (!opened.ok) return { ok: false, errorCode: opened.error, error: opened.error };
            controllerMachineId = opened.environment.controllerMachineId;
        }
        if (controllerMachineId !== host.machineId) return unavailable('health_alert_controller_changed');
        const selection = projectSavedHealthAlertSelection(source);
        if (selection.kind === 'paused') return { status: 'paused', ...target };
        const alerts = selection.alerts;
        if (!alerts) return unavailable('health_alerts_unconfigured');
        if (!alerts.channels.length) return { status: 'off', ...target };
        const channel = alerts.channels[selector.channelIndex];
        if (!channel || channel.channelId !== selector.channelId) return unavailable('health_alert_channel_not_selected');
        return { kind: 'selected' as const, channel, target };
}

/** Readonly approval disclosure uses the same selection/controller authority as execution. */
export function createSavedHealthAlertTestPreparationReceiverForHost(host: SavedHealthAlertTestHost) {
    return async (selector: SavedHealthAlertTestRequest, signal: AbortSignal): Promise<SavedHealthAlertTestApprovalReview | ActionExecuteFailure> => {
        const selected = await readSavedHealthAlertTestSelection(host, selector, signal);
        if (!('kind' in selected)) {
            if ('errorCode' in selected) return selected;
            if (selected.status === 'unavailable') return { ok: false, errorCode: selected.reason, error: selected.reason };
            return { request: selector, controllerMachineId: host.machineId, destination: null,
                disclosure: selected.status === 'off' ? 'Alerts are off. No notification will be sent.'
                    : 'This health source is paused. No notification will be sent.' };
        }
        const catalog = createCliNotificationCatalogForHost({ ...host, isCredentialCurrent: host.isCurrent });
        try {
            const context = await catalog.readContext(signal, { maintainSource: false });
            const configured = (await listActivityNotificationChannels({ ...context,
                pluginNotifications: createHostPluginNotificationChannels() })).find(channel => channel.value === selector.channelId);
            const item = context.notificationChannelCatalog.status === 'ready'
                ? context.notificationChannelCatalog.channels.find(channel => channel.id === selector.channelId) : undefined;
            if (!configured) return { ok: false, errorCode: 'health_alert_channel_unavailable', error: 'health_alert_channel_unavailable' };
            if (configured.destinationSetup && selected.channel.destination === undefined) return {
                ok: false, errorCode: 'health_alert_destination_unconfigured', error: 'health_alert_destination_unconfigured' };
            const destination = selected.channel.destination ?? (item?.kind === 'webhook'
                ? { kind: item.kind, channelId: item.id, url: item.url }
                : { kind: item?.kind ?? 'plugin', channelId: selector.channelId });
            return SavedHealthAlertTestApprovalReviewSchema.parse({ request: selector, controllerMachineId: host.machineId,
                destination, disclosure: 'This destination receives readable notification text outside Happier, including for an end-to-end encrypted Account.' });
        } catch (error) { signal.throwIfAborted(); return catalog.projectFailure(error); }
    };
}

/** Effect admission reads the saved source once; senders receive only its selected destination. */
export function createSavedHealthAlertTestReceiverForHost(host: SavedHealthAlertTestHost) {
    return async (selector: SavedHealthAlertTestRequest, signal: AbortSignal): Promise<SavedHealthAlertTestForHostResult> => {
        const selected = await readSavedHealthAlertTestSelection(host, selector, signal);
        if (!('kind' in selected)) return selected;
        const { channel, target } = selected;
        const pluginNotifications = createHostPluginNotificationChannels();
        const catalog = createCliNotificationCatalogForHost({ ...host,
            isCredentialCurrent: host.isCurrent, resolvePluginNotifications: () => pluginNotifications });
        try {
            const notificationContext = await catalog.readContext(signal);
            const result = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => dispatchSavedHealthAlertTestAsync({
                ...notificationContext, channel, signal, pluginNotifications,
                expoPushSender: new PushNotificationClient(host.credentials.token, host.serverHttpBaseUrl, host.serverId),
            }));
            return { ...result, ...target };
        } catch (error) {
            signal.throwIfAborted();
            return await catalog.projectFailure(error);
        }
    };
}

/** The public preparation port reaches the addressed controller without sending. */
export function createSavedHealthAlertTestApprovalForHost(host: Readonly<{
    credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string;
}>) {
    return async (input: SavedHealthAlertTestRequest, context?: Readonly<{ signal?: AbortSignal }>): Promise<SavedHealthAlertTestApprovalReview | ActionExecuteFailure> => {
        context?.signal?.throwIfAborted();
        const selector = NotificationConfigurationActionInputSchemas[SAVED_HEALTH_ALERT_TEST_ACTION_ID].parse(input);
        if (selector.serverId !== host.serverId) return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
        const result = await callExactMachineRpc({ credentials: host.credentials, machineId: selector.machineId,
            serverUrl: host.serverHttpBaseUrl, requireCurrentMachine: true, requiredMachineKind: 'persistent',
            method: RPC_METHODS.DAEMON_SERVICE_HEALTH_DELIVER, request: { kind: 'prepareTest', ...selector },
            ...(context?.signal ? { signal: context.signal } : {}) });
        const failure = readActionFailureEnvelope(result, { treatReturnedErrorEnvelopeAsFailure: true });
        if (failure) return failure;
        return SavedHealthAlertTestApprovalReviewSchema.parse(readMachineActionRpcResult(result));
    };
}

/** The public Action forwards only a saved selector to its exact controller. */
export function createSavedHealthAlertTestForHost(host: Readonly<{
    credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string;
}>) {
    return async (input: SavedHealthAlertTestRequest, context?: Readonly<{ signal?: AbortSignal }>): Promise<SavedHealthAlertTestForHostResult> => {
        context?.signal?.throwIfAborted();
        const selector = NotificationConfigurationActionInputSchemas[SAVED_HEALTH_ALERT_TEST_ACTION_ID].parse(input);
        if (selector.serverId !== host.serverId) return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
        const result = await callExactMachineRpc({ credentials: host.credentials, machineId: selector.machineId,
            serverUrl: host.serverHttpBaseUrl, requireCurrentMachine: true, requiredMachineKind: 'persistent',
            method: RPC_METHODS.DAEMON_SERVICE_HEALTH_DELIVER, request: { kind: 'test', ...selector },
            ...(context?.signal ? { signal: context.signal } : {}) });
        const failure = readActionFailureEnvelope(result, { treatReturnedErrorEnvelopeAsFailure: true });
        if (failure) return failure;
        return SavedHealthAlertTestResultSchema.parse(readMachineActionRpcResult(result));
    };
}
