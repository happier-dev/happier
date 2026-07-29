import type { ActionId } from '@happier-dev/protocol';

import type { ParsedActivityInteraction } from './activityActionTypes';
import {
    createActivitySurfaceSessionRoute,
    parseActivitySurfaceSessionTarget,
    type ActivitySurfaceSessionTargetIdentity,
} from './activitySurfaceTargets';
import { parseActivityInteraction } from './parseActivityInteraction';

export type ActivityInteractionIdentity = Readonly<{
    serverId: string;
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
    | Readonly<{
        kind: 'openSession';
        sessionId: string;
        serverId: string | null;
        serverUrl: string | null;
        route: string;
        identity: ActivityInteractionIdentity | null;
        fallbackReason?: 'direct_actions_disabled' | 'privacy_restricted' | 'unsafe_target';
    }>
    | Readonly<{
        kind: 'openInbox';
        route: string;
    }>
    | Readonly<{
        kind: 'executeAction';
        actionId: ActionId;
        payload: unknown;
        defaultSessionId: string;
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
    const serverId = identity.serverId.trim();
    const sessionId = identity.sessionId.trim();
    if (!serverId || !sessionId) return null;
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

function resolveRouteServerId(serverId: string | null): string | null {
    return serverId === 'local' ? null : serverId;
}

function openSessionCommand(params: Readonly<{
    identity: ActivityInteractionIdentity | null;
    target: ActivityInteractionTargetContext;
    fallbackReason?: 'direct_actions_disabled' | 'privacy_restricted' | 'unsafe_target';
}>): ActivityInteractionCommand {
    const sessionId = params.identity?.sessionId ?? params.target.sessionId;
    if (!sessionId) return ignore('missing_identity', params.target);
    const serverId = params.identity?.serverId ?? params.target.serverId ?? null;
    return {
        kind: 'openSession',
        sessionId,
        serverId,
        serverUrl: params.target.serverUrl ?? null,
        route: createActivitySurfaceSessionRoute(sessionId, resolveRouteServerId(serverId)),
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
    knownIdentities?: readonly ActivityInteractionIdentity[];
    requireKnownIdentity?: boolean;
    directActionsEnabled?: boolean;
    surfaceName?: string | null;
}>): ActivityInteractionCommand {
    const actionIdentifier = params.actionIdentifier.trim() || params.defaultActionIdentifier;
    const targetIdentity =
        parseActivitySurfaceSessionTarget(actionIdentifier)
        ?? readPrefixedSessionTarget(actionIdentifier, 'focus-composer:');
    const parsed = parseActivityInteraction({
        actionIdentifier: params.actionIdentifier,
        defaultActionIdentifier: params.defaultActionIdentifier,
        data: params.data,
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
        const serverId = identity?.serverId ?? target.serverId ?? null;
        return {
            kind: 'focusComposer',
            sessionId,
            serverId,
            serverUrl: target.serverUrl ?? null,
            route: createActivitySurfaceSessionRoute(
                sessionId,
                resolveRouteServerId(serverId),
            ),
            identity,
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
