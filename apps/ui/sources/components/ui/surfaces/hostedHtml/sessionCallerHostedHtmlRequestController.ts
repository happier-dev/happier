import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { buildQualifiedPluginContributionKey, PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import {
    PluginUiExecuteActionRequestV1Schema,
    PluginUiResourceSubscriptionRequestV1Schema,
    type PluginUiJsonValueV1,
    type PluginUiResourceSubscriptionEventV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    createPluginUiProjectedActionResolver,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import type { CallerHostedHtmlHostApiRequestHandler } from '@/components/plugins/hostApi/hostedWebAdapter';
import {
    dispatchPluginSurfaceAction,
    type PluginSurfaceHostActionExecute,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import {
    createPluginSurfaceResourceReadHandler,
    type PluginSurfaceResourceReadTransport,
} from '@/components/plugins/surfaces/pluginSurfaceResourceRead';
import {
    createPluginSurfaceResourceWatchHandlers,
    type PluginSurfaceResourceWatchTransport,
} from '@/components/plugins/surfaces/pluginSurfaceResourceWatch';

type CurrentPluginTarget = Readonly<{
    machineId: string;
    serverId: string;
    generation: number;
    projection: PluginUiProjectionModel;
    isCurrent: () => boolean;
}>;

export type SessionCallerHostedHtmlRequestController = Readonly<{
    handleRequest: CallerHostedHtmlHostApiRequestHandler;
    dispose(): void;
}>;

type ResourceHandlers = ReturnType<typeof createPluginSurfaceResourceWatchHandlers>;

function isJsonRecord(
    value: PluginUiJsonValueV1 | undefined,
): value is Readonly<Record<string, PluginUiJsonValueV1>> {
    return value !== null
        && value !== undefined
        && typeof value === 'object'
        && !Array.isArray(value);
}

function readJsonRecord(
    value: PluginUiJsonValueV1 | undefined,
): Readonly<Record<string, PluginUiJsonValueV1>> | null {
    return isJsonRecord(value) ? value : null;
}

function readExactQualifiedReference(value: unknown): Readonly<{ pluginId: string; localId: string }> | null {
    const parsed = PluginContributionIdentityV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function assertProjectedResource(
    target: CurrentPluginTarget,
    reference: Readonly<{ pluginId: string; localId: string }>,
): void {
    const projected = target.projection.resourcesById[
        buildQualifiedPluginContributionKey(reference)
    ];
    if (!projected || projected.pluginId !== reference.pluginId || projected.id !== reference.localId) {
        throw new Error('plugin_resource_not_found');
    }
}

/**
 * Host-private request adapter for one caller-authored Session document.
 *
 * It deliberately creates no plugin caller. Qualified contributed Actions and
 * Resources resolve against the incumbent current daemon projection, then use
 * the same Action/Resource dispatchers as installed surfaces. The Resource RPC
 * still names the target plugin as `callerPluginId` because that legacy field
 * selects the target plugin service; it is never projected into guest context
 * or used as caller provenance. Bare ActionSpec invocations are host-stamped as
 * Account automation: executable document code is not a present-user caller,
 * even when its frame is visible on the UI surface.
 */
export function createSessionCallerHostedHtmlRequestController(input: Readonly<{
    sessionId: string;
    serverId: string;
    serverIdentityId: string;
    accountId: string;
    executeHostAction: PluginSurfaceHostActionExecute;
    isAccountCurrent: () => boolean;
    /** Current exact-Home Session read authority supplied by the canonical Session projection. */
    isSessionCurrent: () => boolean;
    pluginTarget: CurrentPluginTarget | null;
    publishResourceEvent: (event: PluginUiResourceSubscriptionEventV1) => void;
    notify: (input: Readonly<{ requestId: string; message: string; severity: 'info' | 'warning' | 'error' }>) => void;
    dispatchAction?: typeof dispatchPluginSurfaceAction;
    readResource?: PluginSurfaceResourceReadTransport;
    watchResource?: Partial<PluginSurfaceResourceWatchTransport>;
}>): SessionCallerHostedHtmlRequestController {
    let disposed = false;
    const watchHandlersByPluginId = new Map<string, ResourceHandlers>();
    const subscriptionPluginIds = new Map<string, string>();
    const isCurrent = (): boolean => !disposed && input.isAccountCurrent() && input.isSessionCurrent();
    const readPluginTarget = (): CurrentPluginTarget => {
        const target = input.pluginTarget;
        if (!target || !isCurrent() || !target.isCurrent()) {
            throw new Error('caller_surface_retired');
        }
        return target;
    };
    const watchHandlers = (pluginId: string, target: CurrentPluginTarget): ResourceHandlers => {
        const existing = watchHandlersByPluginId.get(pluginId);
        if (existing) return existing;
        const occurrenceId = target.projection.installedPackagesById[pluginId]?.occurrenceId;
        if (!occurrenceId) throw new Error('caller_surface_retired');
        const created = createPluginSurfaceResourceWatchHandlers({
            pluginId,
            resource: {
                machineId: target.machineId,
                serverId: target.serverId,
                expectedCallerOccurrenceId: occurrenceId,
                context: { kind: 'session', sessionId: input.sessionId },
            },
            deliver: input.publishResourceEvent,
            isCurrent: () => isCurrent() && target.isCurrent(),
            ...(input.watchResource === undefined ? {} : { transport: input.watchResource }),
        });
        watchHandlersByPluginId.set(pluginId, created);
        return created;
    };

    const handleRequest: CallerHostedHtmlHostApiRequestHandler = async (request, options) => {
        if (!isCurrent()) throw new Error('caller_surface_retired');
        if (request.method === 'executeAction') {
            const parsed = PluginUiExecuteActionRequestV1Schema.safeParse(request.payload);
            if (!parsed.success) throw new Error('caller_surface_action_invalid');
            const actionInput = parsed.data.input;
            const actionInputRecord = readJsonRecord(actionInput);
            if (actionInputRecord
                && Object.prototype.hasOwnProperty.call(actionInputRecord, 'sessionId')
                && actionInputRecord.sessionId !== input.sessionId) {
                throw new Error('caller_surface_session_mismatch');
            }
            if (typeof parsed.data.action === 'string') {
                const actionId = ActionIdSchema.safeParse(parsed.data.action);
                if (!actionId.success) throw new Error('caller_surface_action_invalid');
                if (
                    actionId.data === 'session.message.send'
                    && options?.consumeHostTransientActivation?.() !== true
                ) {
                    throw new Error('caller_surface_transient_activation_required');
                }
                const result = await input.executeHostAction(actionId.data, parsed.data.input, {
                    serverId: input.serverId,
                    serverIdentityId: input.serverIdentityId,
                    runtimeAccountId: input.accountId,
                    defaultSessionId: input.sessionId,
                    actionRequestId: request.requestId,
                    surface: 'ui',
                    // Caller-authored HTML is executable automation, not a
                    // host-observed present-user gesture. Stamp this at the
                    // bridge so the shared Action policy keeps its dangerous
                    // default confirmation floor; the document cannot supply
                    // authority or any approval bypass through Action input.
                    authority: 'account_automation',
                    ...(options?.signal ? { signal: options.signal } : {}),
                });
                if (!result.ok) throw new Error(result.errorCode);
                return result.result as PluginUiJsonValueV1;
            }
            const target = readPluginTarget();
            const outcome = await (input.dispatchAction ?? dispatchPluginSurfaceAction)({
                action: parsed.data.action,
                ...(parsed.data.input === undefined ? {} : { input: parsed.data.input }),
                resolveContributedAction: createPluginUiProjectedActionResolver(target.projection.actionsById),
                contributedAction: {
                    machineId: target.machineId,
                    serverId: target.serverId,
                    sessionId: input.sessionId,
                },
                clientAction: {
                    sessionId: input.sessionId,
                },
                invocationSurface: 'ui',
                isContributedActionAvailable: target.isCurrent,
                isCurrent: () => isCurrent() && target.isCurrent(),
                ...(options?.signal ? { signal: options.signal } : {}),
            });
            if (!outcome.ok) throw new Error(outcome.reason);
            return outcome.result;
        }
        if (request.method === 'readResource' || request.method === 'watchResource') {
            const payload = request.payload;
            const record = readJsonRecord(payload);
            const reference = readExactQualifiedReference(record?.resource);
            if (!reference) throw new Error('caller_surface_resource_invalid');
            const target = readPluginTarget();
            assertProjectedResource(target, reference);
            if (request.method === 'readResource') {
                const occurrenceId = target.projection.installedPackagesById[reference.pluginId]?.occurrenceId;
                if (!occurrenceId) throw new Error('caller_surface_retired');
                const handler = createPluginSurfaceResourceReadHandler({
                    pluginId: reference.pluginId,
                    resource: {
                        machineId: target.machineId,
                        serverId: target.serverId,
                        expectedCallerOccurrenceId: occurrenceId,
                        context: { kind: 'session', sessionId: input.sessionId },
                        ...(input.readResource === undefined ? {} : { read: input.readResource }),
                    },
                    isCurrent: () => isCurrent() && target.isCurrent(),
                });
                return await handler(request, options);
            }
            const parsedWatch = PluginUiResourceSubscriptionRequestV1Schema.safeParse(record);
            if (!parsedWatch.success) throw new Error('caller_surface_resource_invalid');
            const result = await watchHandlers(reference.pluginId, target).watchResource(request, options);
            subscriptionPluginIds.set(parsedWatch.data.subscriptionId, reference.pluginId);
            return result;
        }
        if (request.method === 'disposeHostResource') {
            const payload = request.payload;
            const record = readJsonRecord(payload);
            const subscriptionId = typeof record?.subscriptionId === 'string'
                ? record.subscriptionId
                : null;
            if (subscriptionId === null) throw new Error('caller_surface_resource_invalid');
            const pluginId = subscriptionPluginIds.get(subscriptionId);
            if (!pluginId) throw new Error('caller_surface_resource_invalid');
            subscriptionPluginIds.delete(subscriptionId);
            return await watchHandlersByPluginId.get(pluginId)!.disposeHostResource(request);
        }
        if (request.method === 'notify') {
            const payload = request.payload;
            const record = readJsonRecord(payload);
            const message = typeof record?.message === 'string' ? record.message.trim() : '';
            if (!message) throw new Error('caller_surface_notify_invalid');
            input.notify({
                requestId: request.requestId,
                message,
                severity: record?.severity === 'warning' || record?.severity === 'error'
                    ? record.severity
                    : 'info',
            });
            return null;
        }
        throw new Error('caller_surface_method_unavailable');
    };

    return Object.freeze({
        handleRequest,
        dispose(): void {
            if (disposed) return;
            disposed = true;
            for (const handlers of watchHandlersByPluginId.values()) handlers.dispose();
            watchHandlersByPluginId.clear();
            subscriptionPluginIds.clear();
        },
    });
}
