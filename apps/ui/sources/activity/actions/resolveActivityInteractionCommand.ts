import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { PluginNotificationPushContextV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { GuardStopWarningPushDataV1Schema, readGuardStopWarningPushActionV1, MachineVitalsPushRoutingDataV1Schema } from '@happier-dev/protocol/activity/webhookPayload';
import type { GuardStopWarningPushDataV1 } from '@happier-dev/protocol/activity/webhookPayload';
import { machinePageHref, machineResourceAlertTab } from '@/components/machines/page/machinePageHref';
import { beginMachinePageTabIntent } from '@/components/machines/page/machinePageIntent';
import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';

import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';

import type { ParsedActivityInteraction } from './activityActionTypes';
import {
    createActivitySurfaceSessionRoute,
    parseActivitySurfaceSessionTarget,
    type ActivitySurfaceSessionTargetIdentity,
} from './activitySurfaceTargets';
import { parseActivityInteraction } from './parseActivityInteraction';

export type ActivityInteractionIdentity = Readonly<{
    /**
     * `null` is a Session with no Home binding — never a placeholder id. A Home whose profile id
     * is literally `local` is a real Home and keeps routing to itself (Lane 07.1 §4).
     */
    serverId: string | null;
    sessionId: string;
    activityName?: string | null;
    activityInstanceKey?: string | null;
}>;

export type ActivityInteractionTargetContext = Readonly<{
    serverId: string | null;
    sessionId: string | null;
    serverUrl?: string | null;
    activityName?: string | null;
    activityInstanceKey?: string | null;
}>;

export type ActivityInteractionIgnoreReason =
    | 'unknown_action'
    | 'unknown_server'
    | 'missing_identity'
    | 'malformed'
    | 'duplicate'
    | 'stale'
    | 'unsupported'
    | 'disabled';

export type ActivityInteractionCommand =
    // Account-bound navigation for either a stored notice or its live source;
    // neither path carries Session permission-response authority.
    | Readonly<{ kind: 'openNotice'; serverId: string; serverUrl: string; accountId: string; route: string;
        defaultSessionId?: string;
        pluginNotificationPress?: Readonly<{ notification: PluginNotificationPushContextV1; buttonId: string }> }>
    | Readonly<{ kind: 'openMachine'; machineId: string; serverId: string | null; serverUrl: string | null; tab: MachinePageTabParams; route: string }>
    | Readonly<{
        kind: 'openSession';
        sessionId: string;
        serverId: string | null;
        serverUrl: string | null;
        route: ReturnType<typeof createActivitySurfaceSessionRoute>;
        identity: ActivityInteractionIdentity | null;
        fallbackReason?: 'direct_actions_disabled' | 'privacy_restricted' | 'unsafe_target';
    }>
    | Readonly<{
        kind: 'openInbox';
        route: string;
    }>
    | Readonly<{
        /**
         * An Account-scoped workflow Run. It carries no Session identity on
         * purpose: a Run outlives its originating Session and is discoverable
         * by `runId` alone, so the Session-identity gate must not apply.
         */
        kind: 'openWorkflowRun';
        runId: string;
        serverId: string | null;
        serverUrl: string | null;
        route: string;
    }>
    | Readonly<{
        kind: 'executeAction';
        actionId: ActionId;
        payload: unknown;
        defaultSessionId: string;
        route?: string;
        guardWarning?: GuardStopWarningPushDataV1;
        target: ActivityInteractionTargetContext;
        identity: ActivityInteractionIdentity | null;
        surface: Readonly<{
            name: string | null;
            interaction: string;
        }>;
    }>
    | Readonly<{
        kind: 'focusComposer';
        sessionId: string;
        serverId: string | null;
        serverUrl: string | null;
        route: string;
        identity: ActivityInteractionIdentity | null;
    }>
    | Readonly<{
        kind: 'openSettings';
        route: string;
        destination: string;
        diagnostics: ActivityInteractionTargetContext | null;
    }>
    | Readonly<{
        kind: 'ignore';
        reason: ActivityInteractionIgnoreReason;
        target?: ActivityInteractionTargetContext;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(data: unknown, key: string): string {
    if (!isRecord(data)) return '';
    const value = data[key];
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeIdentity(identity: ActivityInteractionIdentity): ActivityInteractionIdentity | null {
    const serverId = typeof identity.serverId === 'string' ? identity.serverId.trim() || null : null;
    const sessionId = identity.sessionId.trim();
    if (!sessionId) return null;
    const activityName = typeof identity.activityName === 'string' ? identity.activityName.trim() : '';
    const activityInstanceKey = typeof identity.activityInstanceKey === 'string' ? identity.activityInstanceKey.trim() : '';
    return {
        serverId,
        sessionId,
        ...(activityName ? { activityName } : {}),
        ...(activityInstanceKey ? { activityInstanceKey } : {}),
    };
}

function readPrefixedSessionTarget(
    actionIdentifier: string,
    prefix: string,
): ActivitySurfaceSessionTargetIdentity | null {
    if (!actionIdentifier.startsWith(prefix)) return null;
    return parseActivitySurfaceSessionTarget(`open-session:${actionIdentifier.slice(prefix.length)}`);
}

function readRequestedSessionId(params: Readonly<{
    actionIdentifier: string;
    parsed: ParsedActivityInteraction | null;
    data: unknown;
}>): string {
    const targetIdentity =
        parseActivitySurfaceSessionTarget(params.actionIdentifier)
        ?? readPrefixedSessionTarget(params.actionIdentifier, 'focus-composer:');
    if (targetIdentity) {
        return targetIdentity.sessionId;
    }
    if (params.actionIdentifier === 'open-primary-session') {
        return readStringField(params.data, 'primarySessionId') || readStringField(params.data, 'sessionId');
    }
    return params.parsed?.permissionAction?.sessionId
        ?? readStringField(params.data, 'sessionId')
        ?? '';
}

function buildPayloadTarget(params: Readonly<{
    data: unknown;
    requestedSessionId: string;
    targetIdentity: ActivitySurfaceSessionTargetIdentity | null;
}>): ActivityInteractionTargetContext {
    const serverUrl = readStringField(params.data, 'serverUrl') || readStringField(params.data, 'server') || '';
    const activityName = readStringField(params.data, 'activityName');
    const activityInstanceKey = readStringField(params.data, 'activityInstanceKey');
    return {
        serverId: readStringField(params.data, 'serverId') || params.targetIdentity?.serverId || null,
        sessionId: params.requestedSessionId || readStringField(params.data, 'sessionId') || null,
        ...(serverUrl ? { serverUrl } : {}),
        ...(activityName ? { activityName } : {}),
        ...(activityInstanceKey ? { activityInstanceKey } : {}),
    };
}

function buildPayloadIdentity(target: ActivityInteractionTargetContext): ActivityInteractionIdentity | null {
    if (!target.serverId || !target.sessionId) return null;
    return normalizeIdentity({
        serverId: target.serverId,
        sessionId: target.sessionId,
        activityName: target.activityName ?? null,
        activityInstanceKey: target.activityInstanceKey ?? null,
    });
}

function identitiesMatch(
    known: ActivityInteractionIdentity,
    requested: ActivityInteractionIdentity,
): boolean {
    if (known.serverId !== requested.serverId) return false;
    if (known.sessionId !== requested.sessionId) return false;
    if (requested.activityName && known.activityName && known.activityName !== requested.activityName) return false;
    if (requested.activityInstanceKey && known.activityInstanceKey && known.activityInstanceKey !== requested.activityInstanceKey) return false;
    return true;
}

function resolveKnownIdentity(params: Readonly<{
    payloadIdentity: ActivityInteractionIdentity | null;
    requestedSessionId: string;
    knownIdentities: readonly ActivityInteractionIdentity[];
}>): ActivityInteractionIdentity | null {
    const normalizedKnown = params.knownIdentities
        .map(normalizeIdentity)
        .filter((identity): identity is ActivityInteractionIdentity => identity !== null);

    if (normalizedKnown.length === 0) {
        return null;
    }

    if (params.payloadIdentity) {
        return normalizedKnown.find((identity) => identitiesMatch(identity, params.payloadIdentity!)) ?? null;
    }

    if (!params.requestedSessionId) {
        return null;
    }

    const matches = normalizedKnown.filter((identity) => identity.sessionId === params.requestedSessionId);
    return matches.length === 1 ? matches[0]! : null;
}

function ignore(reason: ActivityInteractionIgnoreReason, target: ActivityInteractionTargetContext): ActivityInteractionCommand {
    return {
        kind: 'ignore',
        reason,
        ...(target.serverId || target.sessionId || target.serverUrl || target.activityName || target.activityInstanceKey
            ? { target }
            : {}),
    };
}

function openSessionCommand(params: Readonly<{
    identity: ActivityInteractionIdentity | null;
    target: ActivityInteractionTargetContext;
    fallbackReason?: 'direct_actions_disabled' | 'privacy_restricted' | 'unsafe_target';
}>): ActivityInteractionCommand {
    const sessionId = params.identity?.sessionId ?? params.target.sessionId;
    if (!sessionId) return ignore('missing_identity', params.target);
    // A known identity is authoritative, including its explicit "no Home binding".
    const serverId = params.identity ? params.identity.serverId : params.target.serverId ?? null;
    return {
        kind: 'openSession',
        sessionId,
        serverId,
        serverUrl: params.target.serverUrl ?? null,
        route: createActivitySurfaceSessionRoute(sessionId, serverId),
        identity: params.identity,
        ...(params.fallbackReason ? { fallbackReason: params.fallbackReason } : {}),
    };
}

function resolveSettingsCommand(actionIdentifier: string, target: ActivityInteractionTargetContext): ActivityInteractionCommand | null {
    if (!actionIdentifier.startsWith('open-settings:')) return null;
    const destination = actionIdentifier.slice('open-settings:'.length).trim();
    if (!destination) return ignore('malformed', target);
    return {
        kind: 'openSettings',
        route: `/settings/${encodeURIComponent(destination)}`,
        destination,
        diagnostics: target.serverId || target.sessionId || target.serverUrl ? target : null,
    };
}

export function resolveActivityInteractionCommand(params: Readonly<{
    actionIdentifier: string;
    defaultActionIdentifier: string;
    data: unknown;
    userText?: unknown;
    knownIdentities?: readonly ActivityInteractionIdentity[];
    requireKnownIdentity?: boolean;
    directActionsEnabled?: boolean;
    surfaceName?: string | null;
}>): ActivityInteractionCommand {
    const actionIdentifier = params.actionIdentifier.trim() || params.defaultActionIdentifier;
    if (isRecord(params.data) && params.data.topic === 'guard_stop_warning') {
        const warning = GuardStopWarningPushDataV1Schema.safeParse(params.data);
        if (!warning.success) return { kind: 'ignore', reason: 'malformed' };
        const parsed = parseActivityInteraction(params);
        if (!parsed) return { kind: 'ignore', reason: 'unknown_action' };
        const data = warning.data;
        if (!data.serverId) return { kind: 'ignore', reason: 'unknown_server' };
        const sessionId = data.rule === 'idle_terminals' ? '' : data.sessionId;
        const target = { serverId: data.serverId, sessionId: sessionId || null, serverUrl: data.serverUrl ?? null };
        const route = sessionId ? createActivitySurfaceSessionRoute(sessionId, data.serverId)
            : machinePageHref({ door: 'rail', target: { machineId: data.machineId, serverId: data.serverId }, tab: { id: 'guard' } });
        if (parsed.guardAction && params.directActionsEnabled !== false) {
            const action = readGuardStopWarningPushActionV1(data, parsed.guardAction, { serverId: data.serverId });
            if (!action) return { kind: 'ignore', reason: 'malformed' };
            return { kind: 'executeAction', actionId: action.actionId, payload: action.input,
                defaultSessionId: sessionId, route, guardWarning: data, target, identity: null,
                surface: { name: params.surfaceName ?? null, interaction: actionIdentifier } };
        }
        return sessionId ? openSessionCommand({ identity: null, target }) : { kind: 'openMachine',
            machineId: data.machineId, serverId: data.serverId, serverUrl: data.serverUrl ?? null, tab: { id: 'guard' }, route };
    }
    if (isRecord(params.data) && params.data.topic === 'resource_limit') {
        const parsed = MachineVitalsPushRoutingDataV1Schema.safeParse(params.data);
        if (!parsed.success) return { kind: 'ignore', reason: 'malformed' };
        if (actionIdentifier !== params.defaultActionIdentifier) return { kind: 'ignore', reason: 'unknown_action' };
        const data = parsed.data;
        if (!data.serverId && !data.serverUrl) return { kind: 'ignore', reason: 'missing_identity' };
        const tab = machineResourceAlertTab(data.kind, data.machineVitals?.kind === 'disk_nearly_full' ? data.machineVitals.volumeId : null);
        return { kind: 'openMachine', machineId: data.machineId, serverId: data.serverId ?? null, serverUrl: data.serverUrl ?? null, tab,
            route: machinePageHref({ door: 'rail', target: { machineId: data.machineId, serverId: data.serverId }, tab }) };
    }
    const targetIdentity =
        parseActivitySurfaceSessionTarget(actionIdentifier)
        ?? readPrefixedSessionTarget(actionIdentifier, 'focus-composer:');
    const parsed = parseActivityInteraction({
        actionIdentifier: params.actionIdentifier,
        defaultActionIdentifier: params.defaultActionIdentifier,
        data: params.data,
        userText: params.userText,
    });
    const requestedSessionId = readRequestedSessionId({
        actionIdentifier,
        parsed,
        data: params.data,
    });
    const target = buildPayloadTarget({
        data: params.data,
        requestedSessionId,
        targetIdentity,
    });
    const payloadIdentity = buildPayloadIdentity(target);
    const knownIdentity = resolveKnownIdentity({
        payloadIdentity,
        requestedSessionId,
        knownIdentities: params.knownIdentities ?? [],
    });
    const requireKnownIdentity = params.requireKnownIdentity !== false;
    const identity = knownIdentity ?? (requireKnownIdentity ? null : payloadIdentity);

    const settingsCommand = resolveSettingsCommand(actionIdentifier, target);
    if (settingsCommand) return settingsCommand;

    // Resolved before the Session-identity gate below: a workflow Run is
    // Account-scoped, so requiring a known Session identity would drop every
    // workflow deep link on a client that has not loaded that Session.
    if (parsed?.workflowRun && parsed.isOpenAction) {
        return {
            kind: 'openWorkflowRun',
            runId: parsed.workflowRun.runId,
            serverId: target.serverId,
            serverUrl: target.serverUrl ?? parsed.serverUrl ?? null,
            route: createWorkflowRunRoute(parsed.workflowRun.runId, target.serverId),
        };
    }

    if (actionIdentifier === 'open-inbox' || (parsed?.route === '/inbox' && parsed.permissionAction === null)) {
        return {
            kind: 'openInbox',
            route: '/inbox',
        };
    }

    if (!parsed && !actionIdentifier.startsWith('focus-composer:')) {
        return ignore('unknown_action', target);
    }

    if (!identity && requireKnownIdentity) {
        return ignore(payloadIdentity || requestedSessionId ? 'unknown_server' : 'missing_identity', target);
    }

    if (actionIdentifier.startsWith('focus-composer:')) {
        const sessionId = identity?.sessionId ?? target.sessionId ?? '';
        if (!sessionId) return ignore('missing_identity', target);
        const serverId = identity ? identity.serverId : target.serverId ?? null;
        return {
            kind: 'focusComposer',
            sessionId,
            serverId,
            serverUrl: target.serverUrl ?? null,
            route: createActivitySurfaceSessionRoute(sessionId, serverId),
            identity,
        };
    }

    if (parsed?.questionAction) {
        if (!identity && !target.serverUrl) return openSessionCommand({ identity, target, fallbackReason: 'unsafe_target' });
        if (params.directActionsEnabled === false) return openSessionCommand({ identity, target, fallbackReason: 'direct_actions_disabled' });
        return {
            kind: 'executeAction', actionId: 'session.user_action.answer',
            payload: { sessionId: parsed.questionAction.sessionId, requestId: parsed.questionAction.requestId,
                turnId: parsed.questionAction.turnId,
                answers: Object.entries(parsed.questionAction.answers).map(([question, values]) => ({ question, values })) },
            defaultSessionId: identity?.sessionId ?? parsed.questionAction.sessionId,
            route: parsed.route ?? undefined, target, identity,
            surface: { name: params.surfaceName ?? target.activityName ?? null, interaction: actionIdentifier },
        };
    }

    if (parsed?.permissionAction) {
        if (!identity && requireKnownIdentity) {
            return ignore('unknown_server', target);
        }
        if (!identity && !target.serverUrl) {
            return openSessionCommand({ identity, target, fallbackReason: 'unsafe_target' });
        }
        if (params.directActionsEnabled === false) {
            return openSessionCommand({ identity, target, fallbackReason: 'direct_actions_disabled' });
        }
        return {
            kind: 'executeAction',
            actionId: 'session.permission.respond' as ActionId,
            payload: {
                sessionId: parsed.permissionAction.sessionId,
                requestId: parsed.permissionAction.requestId,
                ...(parsed.permissionAction.turnId ? { turnId: parsed.permissionAction.turnId } : {}),
                decision: parsed.permissionAction.action,
            },
            defaultSessionId: identity?.sessionId ?? parsed.permissionAction.sessionId,
            target,
            identity,
            surface: {
                name: params.surfaceName ?? target.activityName ?? null,
                interaction: actionIdentifier,
            },
        };
    }

    if (parsed?.isOpenAction) {
        return openSessionCommand({ identity, target });
    }

    return ignore('unknown_action', target);
}
