import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { formatQualifiedPluginResourcePolicyId, isActionEnabledByActionsSettings, type ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
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
    type PluginSurfaceContributedActionTransport,
    type PluginSurfaceHostActionExecute,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import { createPluginSurfaceHostApiError } from '@/components/plugins/surfaces/createPluginSurfaceHostApi';
import { createPluginSurfaceActionFailurePayload } from '@/components/plugins/surfaces/actionFailure';
import {
    createPluginSurfaceResourceReadHandler,
    type PluginSurfaceResourceReadTransport,
    type PluginSurfaceResourceBinding,
} from '@/components/plugins/surfaces/pluginSurfaceResourceRead';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import type { PluginUiLaunchInputV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiHostApiSurfaceTargetV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginResourceContextV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import {
    createPluginSurfaceResourceWatchHandlers,
    type PluginSurfaceResourceWatchTransport,
} from '@/components/plugins/surfaces/pluginSurfaceResourceWatch';

export type CurrentCallerHostedHtmlPluginTarget = Readonly<{
    machineId: string | null;
    serverId: string | null;
    projection: PluginUiProjectionModel;
    isCurrent: () => boolean;
}>;

export type SessionCallerHostedHtmlRequestController = Readonly<{
    handleRequest: CallerHostedHtmlHostApiRequestHandler;
    updateSurfaceTarget?(target: PluginUiHostApiSurfaceTargetV1): void;
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

/** The viewer's exact current declaration selects the Resource's origin and context. */
export function resolveCallerHostedHtmlResourceBindingV1(input: Readonly<{
    target: CurrentCallerHostedHtmlPluginTarget;
    reference: Readonly<{ pluginId: string; localId: string }>;
    serverId: string;
    sessionId?: string;
    mountInstanceKey?: string;
    launchInput?: PluginUiLaunchInputV1;
    surfaceTarget?: PluginUiHostApiSurfaceTargetV1;
}>): Readonly<{ machineId: string; serverId: string; expectedCallerOccurrenceId: string; context: PluginResourceContextV1 }> | null {
    const { target, reference } = input;
    if (!target.isCurrent()) return null;
    const declarations = Object.values(target.projection.resourcesById).filter(row => row.pluginId === reference.pluginId && row.id === reference.localId);
    const declaration = declarations.length === 1 ? declarations[0] : null;
    const plugin = target.projection.installedPackagesById[reference.pluginId];
    if (!declaration || declaration.pluginId !== reference.pluginId || declaration.id !== reference.localId
        || !plugin?.enabled || !plugin.occurrenceId
        || declaration.occurrenceId !== undefined && declaration.occurrenceId !== plugin.occurrenceId) return null;
    const origin = readPluginUiContributionOrigin(declaration);
    const packageOrigin = readPluginUiContributionOrigin(plugin);
    const machineId = target.machineId ?? origin?.machineId;
    const serverId = target.serverId ?? origin?.serverId;
    if (!machineId || serverId !== input.serverId
        || origin && (origin.phase !== 'current' || !origin.interactionEnabled || origin.machineId !== machineId || origin.serverId !== serverId)
        || packageOrigin && (packageOrigin.machineId !== machineId || packageOrigin.serverId !== serverId)) return null;
    const context = declaration.scope === 'global' ? { kind: 'global' as const }
        : declaration.scope === 'session' && input.sessionId
            && (!input.surfaceTarget || input.surfaceTarget.kind === 'session' && input.surfaceTarget.sessionId === input.sessionId)
            ? { kind: 'session' as const, sessionId: input.sessionId, ...(input.surfaceTarget ? { target: input.surfaceTarget } : {}) }
        : declaration.scope === 'surface' && input.mountInstanceKey ? { kind: 'surface' as const, mountInstanceKey: input.mountInstanceKey,
            launchInput: input.launchInput ?? {}, ...(input.surfaceTarget ? { target: input.surfaceTarget } : {}) } : null;
    return context ? { machineId, serverId, expectedCallerOccurrenceId: plugin.occurrenceId, context } : null;
}

/**
 * Host-private request adapter for a caller-authored document or saved widget.
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
    sessionId?: string;
    serverId: string;
    serverIdentityId: string;
    accountId: string;
    executeHostAction: PluginSurfaceHostActionExecute;
    isAccountCurrent: () => boolean;
    /** Current exact-Home Session read authority supplied by the canonical Session projection. */
    isSessionCurrent?: () => boolean;
    /** Host-observed ownership, not a fact supplied by the document. Missing ownership fails closed. */
    isSessionOwned?: () => boolean;
    /** Host-admitted fact that someone other than the viewer owns the surface this HTML comes from. */
    isContentForeign?: () => boolean;
    readActionsSettings?: (signal?: AbortSignal) => Promise<ActionsSettingsV1>;
    pluginTarget: CurrentCallerHostedHtmlPluginTarget | null;
    surfaceTarget?: PluginUiHostApiSurfaceTargetV1;
    mountInstanceKey?: string;
    launchInput?: PluginUiLaunchInputV1;
    publishResourceEvent: (event: PluginUiResourceSubscriptionEventV1) => void;
    notify: (input: Readonly<{ requestId: string; message: string; severity: 'info' | 'warning' | 'error' }>) => void;
    executeContributedAction?: PluginSurfaceContributedActionTransport;
    readResource?: PluginSurfaceResourceReadTransport;
    watchResource?: Partial<PluginSurfaceResourceWatchTransport>;
}>): SessionCallerHostedHtmlRequestController {
    let disposed = false;
    const watchHandlersByResourceKey = new Map<string, ResourceHandlers>();
    const subscriptionResourceKeys = new Map<string, string>();
    let surfaceTarget = input.surfaceTarget;
    let resourceTargetController = new AbortController();
    const retireResourceTarget = () => {
        resourceTargetController.abort();
        for (const handlers of watchHandlersByResourceKey.values()) handlers.dispose();
        watchHandlersByResourceKey.clear();
        subscriptionResourceKeys.clear();
    };
    const isCurrent = (): boolean => !disposed && input.isAccountCurrent()
        && (input.sessionId === undefined || input.isSessionCurrent?.() === true);
    // The one audience decision: HTML from a Session or surface someone else owns.
    const callerContext = () => input.isContentForeign?.() === true
        || input.sessionId !== undefined && input.isSessionOwned?.() !== true
        ? { callerSurface: 'foreign_session_html' as const } : {};
    const readSettings = async (signal?: AbortSignal) => {
        const settings = await input.readActionsSettings?.(signal) ?? { v: 1 as const, actions: {} };
        return settings;
    };
    const readPluginTarget = (): CurrentCallerHostedHtmlPluginTarget => {
        const target = input.pluginTarget;
        if (!target || !target.isCurrent()) {
            throw new Error('caller_surface_retired');
        }
        return target;
    };
    const watchHandlers = (key: string, pluginId: string, target: CurrentCallerHostedHtmlPluginTarget, binding: PluginSurfaceResourceBinding): ResourceHandlers => {
        const existing = watchHandlersByResourceKey.get(key);
        if (existing) return existing;
        const resourceSignal = resourceTargetController.signal;
        const created = createPluginSurfaceResourceWatchHandlers({
            pluginId,
            resource: binding,
            deliver: input.publishResourceEvent,
            isCurrent: () => isCurrent() && target.isCurrent() && !resourceSignal.aborted,
            ...(input.watchResource === undefined ? {} : { transport: input.watchResource }),
        });
        watchHandlersByResourceKey.set(key, created);
        return created;
    };

    const handleRequest: CallerHostedHtmlHostApiRequestHandler = async (request, options) => {
        if (!isCurrent()) throw new Error('caller_surface_retired');
        if (request.method === 'executeAction') {
            const parsed = PluginUiExecuteActionRequestV1Schema.safeParse(request.payload);
            if (!parsed.success) throw new Error('caller_surface_action_invalid');
            const actionInput = parsed.data.input;
            const actionInputRecord = readJsonRecord(actionInput);
            if (input.sessionId !== undefined && actionInputRecord
                && Object.prototype.hasOwnProperty.call(actionInputRecord, 'sessionId')
                && actionInputRecord.sessionId !== input.sessionId) {
                throw new Error('caller_surface_session_mismatch');
            }
            if (typeof parsed.data.action === 'string') {
                const actionId = ActionIdSchema.safeParse(parsed.data.action);
                if (!actionId.success) throw new Error('caller_surface_action_invalid');
                const result = await input.executeHostAction(actionId.data, parsed.data.input, {
                    serverId: input.serverId,
                    serverIdentityId: input.serverIdentityId,
                    runtimeAccountId: input.accountId,
                    ...(input.sessionId ? { defaultSessionId: input.sessionId } : {}),
                    actionRequestId: request.requestId,
                    surface: 'ui',
                    ...callerContext(),
                    // Caller-authored HTML is executable automation, not a
                    // host-observed present-user gesture. Stamp this at the
                    // bridge so the shared Action policy keeps its dangerous
                    // default confirmation floor; the document cannot supply
                    // authority or any approval bypass through Action input.
                    authority: 'account_automation',
                    ...(options?.signal ? { signal: options.signal } : {}),
                });
                if (!result.ok) return createPluginSurfaceHostApiError(result.errorCode, [result.errorCode]);
                return result.result as PluginUiJsonValueV1;
            }
            const target = readPluginTarget();
            const action = target.projection.actionsById[buildQualifiedPluginContributionKey(parsed.data.action)];
            const origin = readPluginUiContributionOrigin(action);
            const machineId = target.machineId ?? origin?.machineId;
            const serverId = target.serverId ?? origin?.serverId;
            if (!machineId || serverId !== input.serverId || origin && (origin.phase !== 'current' || !origin.interactionEnabled
                || origin.machineId !== machineId || origin.serverId !== serverId)) throw new Error('caller_surface_retired');
            const settings = await readSettings(options?.signal);
            const outcome = await dispatchPluginSurfaceAction({
                action: parsed.data.action,
                ...(parsed.data.input === undefined ? {} : { input: parsed.data.input }),
                resolveContributedAction: createPluginUiProjectedActionResolver(target.projection.actionsById),
                contributedAction: {
                    machineId,
                    serverId,
                    ...(input.executeContributedAction ? { execute: input.executeContributedAction } : {}),
                    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                },
                ...(input.sessionId ? { clientAction: { sessionId: input.sessionId } } : {}),
                invocationSurface: 'ui',
                hostAction: { execute: input.executeHostAction, context: {
                    serverId: input.serverId, serverIdentityId: input.serverIdentityId, runtimeAccountId: input.accountId,
                    authority: 'account_automation', surface: 'ui', actionsSettings: settings, ...callerContext(),
                } },
                isContributedActionAvailable: target.isCurrent,
                isCurrent: () => isCurrent() && target.isCurrent(),
                ...(options?.signal ? { signal: options.signal } : {}),
            });
            if (!outcome.ok) return createPluginSurfaceActionFailurePayload(outcome);
            return outcome.result;
        }
        if (request.method === 'readResource' || request.method === 'watchResource') {
            const payload = request.payload;
            const record = readJsonRecord(payload);
            const reference = readExactQualifiedReference(record?.resource);
            if (!reference) throw new Error('caller_surface_resource_invalid');
            const target = input.pluginTarget;
            if (!target) throw new Error('caller_surface_retired');
            const binding = resolveCallerHostedHtmlResourceBindingV1({ target, reference, serverId: input.serverId,
                sessionId: input.sessionId, mountInstanceKey: input.mountInstanceKey, launchInput: input.launchInput, surfaceTarget });
            // Own-Session callers keep the incumbent missing-declaration result without
            // acquiring Account settings for a Resource that cannot be read.
            if (!binding && !callerContext().callerSurface) throw new Error('plugin_resource_not_found');
            const settings = await readSettings(options?.signal);
            const context = { surface: 'ui' as const, ...callerContext() };
            const policyId = formatQualifiedPluginResourcePolicyId(reference);
            if (!isActionEnabledByActionsSettings(policyId, settings, context)) {
                return createPluginSurfaceHostApiError('action_disabled', ['action_disabled']);
            }
            // Resources have no approval continuation. Ask refuses without creating a prompt;
            // an explicit Allowed choice reaches the incumbent read/watch RPC unchanged.
            if (isApprovalRequiredByActionsSettings(policyId, settings, context)) {
                return createPluginSurfaceHostApiError('approval_required', ['approval_required']);
            }
            const resourceSignal = resourceTargetController.signal;
            if (!binding) throw new Error('plugin_resource_not_found');
            if (request.method === 'readResource') {
                const handler = createPluginSurfaceResourceReadHandler({
                    pluginId: reference.pluginId,
                    resource: {
                        ...binding,
                        ...(input.readResource === undefined ? {} : { read: input.readResource }),
                    },
                });
                const cancellation = mergeAbortSignals([resourceSignal, options?.signal]);
                try { return await handler(request, { ...options, signal: cancellation.signal }); }
                finally { cancellation.dispose(); }
            }
            const parsedWatch = PluginUiResourceSubscriptionRequestV1Schema.safeParse(record);
            if (!parsedWatch.success) throw new Error('caller_surface_resource_invalid');
            const key = buildQualifiedPluginContributionKey(reference);
            const previousKey = subscriptionResourceKeys.get(parsedWatch.data.subscriptionId);
            if (previousKey && previousKey !== key) {
                // Re-establishing one guest id retires its previous contextual
                // owner before opening a Resource with a different scope.
                await watchHandlersByResourceKey.get(previousKey)!.disposeHostResource({
                    ...request, payload: { subscriptionId: parsedWatch.data.subscriptionId },
                });
            }
            const result = await watchHandlers(key, reference.pluginId, target, binding).watchResource(request, options);
            if (resourceSignal.aborted) throw new Error('caller_surface_retired');
            subscriptionResourceKeys.set(parsedWatch.data.subscriptionId, key);
            return result;
        }
        if (request.method === 'disposeHostResource') {
            const payload = request.payload;
            const record = readJsonRecord(payload);
            const subscriptionId = typeof record?.subscriptionId === 'string'
                ? record.subscriptionId
                : null;
            if (subscriptionId === null) throw new Error('caller_surface_resource_invalid');
            const resourceKey = subscriptionResourceKeys.get(subscriptionId);
            if (!resourceKey) throw new Error('caller_surface_resource_invalid');
            subscriptionResourceKeys.delete(subscriptionId);
            return await watchHandlersByResourceKey.get(resourceKey)!.disposeHostResource(request);
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
        updateSurfaceTarget(target: PluginUiHostApiSurfaceTargetV1): void {
            if (disposed || target === surfaceTarget) return;
            if (input.sessionId !== undefined && (target.kind !== 'session' || target.sessionId !== input.sessionId)) {
                throw new Error('caller_surface_session_mismatch');
            }
            retireResourceTarget();
            surfaceTarget = target;
            resourceTargetController = new AbortController();
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            retireResourceTarget();
        },
    });
}
