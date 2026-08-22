import * as React from 'react';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolvePluginUiText } from '@/sync/domains/plugins/ui/i18n';
import {
    evaluatePluginUiPolicy,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import { comparePluginContributionOrder } from '@/sync/domains/plugins/contributionOrder';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import {
    dispatchPluginSurfaceAction,
    type PluginSurfaceActionDispatchOutcome,
    type PluginSurfaceContributedActionTransport,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import {
    createPluginActionCurrentIntentHandler,
} from '@/components/plugins/surfaces/pluginSurfaceFeedback';
import {
    resolvePluginUiClientActionRegistration,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import type {
    PluginSurfaceOpenHandler,
    PluginSurfaceOpenOutcome,
} from '@/components/plugins/surfaces/openPluginSurface';
import type { PluginSurfaceScopedLaunchFacts } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import type {
    PluginUiProjectionModel,
    PluginUiSessionHeaderActionProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { CurrentUiContextSnapshotV1 } from '@happier-dev/protocol/plugins/ui';
import { createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * The session-header contribution family (EU-5c).
 *
 * A declaration supplies identity, label, applicability and a compiled semantic
 * command — nothing else. Everything downstream of "which contribution did the
 * user pick" belongs to owners this module only calls:
 *
 *  - command admission and local-id qualification: the Registry/CLI projection
 *    owner, which publishes only its resolved command shape;
 *  - applicability: `evaluatePluginUiPolicy` against the placement's own host
 *    facts (platform/channel/features), never an empty context;
 *  - ordering: `comparePluginContributionOrder`, shared with every other
 *    projected contribution family;
 *  - execution: `dispatchPluginSurfaceAction`, the canonical §3.5 dispatcher,
 *    which owns identity qualification, the `executionSurface: 'ui'` stamp and
 *    the typed failure vocabulary.
 *  - navigation: the existing SessionView-supplied `PluginSurfaceOpenHandler`,
 *    which owns surface currentness and exact target/container selection.
 *
 * This module routes that admitted command only. It does not recreate a local
 * command parser, a destination resolver, or a header-local executor.
 */
export const PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX = 'plugin-ui:';

/**
 * The one normalized presentation record consumed by both responsive Session
 * header placements. It carries the already-admitted command descriptor but
 * deliberately not any execution or navigation authority: selection still
 * re-resolves against the current projection in `dispatchPluginSessionHeaderAction`.
 */
export type PluginSessionHeaderActionPresentation = Readonly<{
    action: PluginUiSessionHeaderActionProjection;
    menuActionId: string;
    title: string;
    iconName: ReturnType<typeof resolvePluginUiIconName>;
    enabled: boolean;
}>;

const EMPTY_PLUGIN_SESSION_HEADER_ACTION_PRESENTATIONS: readonly PluginSessionHeaderActionPresentation[] = Object.freeze([]);

/**
 * Session header Actions are semantic commands, not a second scope resolver.
 * The registered Session scope already owns whether its retained projection is
 * current and exactly which machine/server/generation admitted it. Keep a
 * retained descriptor displayable, but do not treat it as interaction
 * authority after that owner revokes the scope.
 */
function resolveCurrentSessionHeaderActionScope(
    projection: PluginUiProjectionModel,
    scopedLaunchFacts: PluginSurfaceScopedLaunchFacts | null | undefined,
): PluginSurfaceScopedLaunchFacts | null {
    if (
        !scopedLaunchFacts
        || scopedLaunchFacts.interactionEnabled !== true
        || !scopedLaunchFacts.machineId
        || scopedLaunchFacts.machineId.trim().length === 0
        || scopedLaunchFacts.generation === null
        || !Number.isFinite(scopedLaunchFacts.generation)
        || projection.generation !== scopedLaunchFacts.generation
    ) {
        return null;
    }
    return scopedLaunchFacts;
}

/** Client-target Actions retain the Session projection's currentness without a daemon address. */
function isCurrentSessionHeaderActionProjection(
    projection: PluginUiProjectionModel,
    scopedLaunchFacts: PluginSurfaceScopedLaunchFacts | null | undefined,
): boolean {
    return scopedLaunchFacts?.interactionEnabled === true
        && scopedLaunchFacts.generation !== null
        && Number.isFinite(scopedLaunchFacts.generation)
        && projection.generation === scopedLaunchFacts.generation;
}

function readTitle(action: PluginUiSessionHeaderActionProjection): Readonly<{
    key: string | null;
    fallback: string;
}> {
    if (typeof action.title === 'string') {
        return { key: null, fallback: action.title };
    }
    return {
        key: action.title.key,
        fallback: action.title.fallback,
    };
}

export function createPluginSessionHeaderActionMenuId(action: PluginUiSessionHeaderActionProjection): string {
    return `${PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX}${action.id}`;
}

/**
 * The projected header contributions this host placement may show, in catalog
 * order. Both direct and overflow controls consume this same result; responsive
 * placement is decided by the Session header owner, not this normalizer.
 *
 * `policyContext` is REQUIRED: applicability is evaluated against the exact host
 * facts the placement owns. Passing an empty context (the previous behaviour)
 * silently hid every contribution that declared `compatibility.platforms` and
 * disabled every contribution whose `disabledWhen` referenced `host.platform`,
 * because a missing fact fails closed.
 */
export function resolvePluginSessionHeaderActionPresentations(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    locale?: string | null;
    policyContext: PluginUiPolicyEvaluationContext;
    scopedLaunchFacts: PluginSurfaceScopedLaunchFacts | null | undefined;
}>): readonly PluginSessionHeaderActionPresentation[] {
    const projection = params.projection;
    if (!projection) {
        return EMPTY_PLUGIN_SESSION_HEADER_ACTION_PRESENTATIONS;
    }
    const scopedAuthority = resolveCurrentSessionHeaderActionScope(projection, params.scopedLaunchFacts);
    const projectionCurrent = isCurrentSessionHeaderActionProjection(
        projection,
        params.scopedLaunchFacts,
    );
    const resolveContributedAction = createPluginUiProjectedActionResolver(projection.actionsById);

    const presentations = Object.values(projection.sessionHeaderActionsById)
        .map((action) => ({
            action,
            policy: evaluatePluginUiPolicy(action, params.policyContext),
        }))
        .filter(({ policy }) => policy.visible)
        .sort((left, right) => comparePluginContributionOrder(left.action, right.action))
        .map(({ action, policy }): PluginSessionHeaderActionPresentation => {
            const title = readTitle(action);
            const actionTarget = action.action.kind === 'executeAction'
                ? resolveContributedAction(action.action.action)
                : null;
            const actionEnabled = action.action.kind === 'executeAction'
                ? actionTarget?.execution.target === 'client'
                    ? projectionCurrent
                        && params.scopedLaunchFacts?.generation !== null
                        && params.scopedLaunchFacts?.generation !== undefined
                        && resolvePluginUiClientActionRegistration({
                            action: actionTarget,
                            projectionGeneration: params.scopedLaunchFacts.generation,
                            platform: resolvePluginUiClientExecutablePlatform(),
                        }) !== null
                    : actionTarget?.execution.target === 'daemon' && scopedAuthority !== null
                : scopedAuthority !== null;
            return Object.freeze({
                action,
                menuActionId: createPluginSessionHeaderActionMenuId(action),
                title: resolvePluginUiText({
                    projection,
                    pluginId: action.pluginId,
                    key: title.key,
                    locale: params.locale,
                    fallback: title.fallback,
                }),
                iconName: resolvePluginUiIconName(action.icon),
                enabled: policy.enabled && actionEnabled,
            });
        });
    return presentations.length > 0 ? Object.freeze(presentations) : EMPTY_PLUGIN_SESSION_HEADER_ACTION_PRESENTATIONS;
}

/**
 * Overflow is a thin host-control adapter over the shared normalized records.
 * It does not decide visibility, order, availability, or responsive placement.
 */
export function createPluginSessionHeaderActionDropdownItems(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    iconColor: string;
    locale?: string | null;
    policyContext: PluginUiPolicyEvaluationContext;
    scopedLaunchFacts: PluginSurfaceScopedLaunchFacts | null | undefined;
}>): readonly DropdownMenuItem[] {
    return resolvePluginSessionHeaderActionPresentations(params).map((presentation): DropdownMenuItem => ({
        id: presentation.menuActionId,
        title: presentation.title,
        icon: <Icon name={presentation.iconName} size={16} color={params.iconColor} />,
        ...(presentation.enabled ? {} : { disabled: true }),
    }));
}

/**
 * Resolve the projected header contribution a menu id refers to. Returns `null`
 * for non-plugin menu ids and for ids no longer in the current projection
 * (fail-closed).
 */
export function resolvePluginSessionHeaderAction(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    menuActionId: string;
}>): PluginUiSessionHeaderActionProjection | null {
    if (!params.menuActionId.startsWith(PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX)) {
        return null;
    }
    const descriptorId = params.menuActionId.slice(PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX.length);
    return params.projection?.sessionHeaderActionsById[descriptorId] ?? null;
}

/**
 * Dispatch a selected session-header contribution through its canonical owner:
 * `executeAction` through the plugin-surface action dispatcher and `openSurface`
 * through the existing SessionView surface handler.
 *
 * For `executeAction`, the target is passed STRUCTURED (`{ pluginId, localId }`),
 * never as the qualified string: a bare string would be offered to the
 * dispatcher's host ActionSpec branch first, so a plugin whose local action id
 * happened to match a `surfaces.plugin` ActionSpec id could be routed to the
 * wrong executor.
 *
 * Returns `null` when the menu id is not a current plugin header contribution,
 * so the caller can fall through to its own menu handling.
 */
export async function dispatchPluginSessionHeaderAction(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    menuActionId: string;
    /** Required for executeAction; openSurface remains delegated unchanged. */
    scopedLaunchFacts?: PluginSurfaceScopedLaunchFacts | null;
    /** Existing Session Account-lifetime predicate; never reconstructed by this adapter. */
    scopeIsCurrent?: (() => boolean) | null;
    sessionId?: string | null;
    execute?: PluginSurfaceContributedActionTransport;
    openSurface?: PluginSurfaceOpenHandler;
    readCurrentUiContext?: () => CurrentUiContextSnapshotV1 | null | undefined;
}>): Promise<PluginSurfaceActionDispatchOutcome | PluginSurfaceOpenOutcome | null> {
    const projection = params.projection;
    const action = resolvePluginSessionHeaderAction({
        projection,
        menuActionId: params.menuActionId,
    });
    if (!action || !projection) {
        return null;
    }

    const semanticAction = action.action;
    if (semanticAction.kind === 'openSurface') {
        if (!params.openSurface) {
            return { ok: false, code: 'unavailable', reason: 'plugin_ui_surface_open_unavailable' };
        }
        return await params.openSurface({
            destination: semanticAction.destination,
            ...(semanticAction.input === undefined ? {} : { input: semanticAction.input }),
            ...(semanticAction.subPath === undefined ? {} : { subPath: semanticAction.subPath }),
            ...(semanticAction.instanceKey === undefined ? {} : { instanceKey: semanticAction.instanceKey }),
        });
    }

    const scopedAuthority = resolveCurrentSessionHeaderActionScope(
        projection,
        params.scopedLaunchFacts,
    );
    const resolveContributedAction = createPluginUiProjectedActionResolver(projection.actionsById);
    const projectedAction = resolveContributedAction(semanticAction.action);
    const scopedMachineId = scopedAuthority?.machineId;
    const scopedGeneration = scopedAuthority?.generation;
    const clientProjectionGeneration = isCurrentSessionHeaderActionProjection(
        projection,
        params.scopedLaunchFacts,
    )
        ? params.scopedLaunchFacts?.generation
        : null;
    if (
        projectedAction?.execution.target === 'daemon'
        && (!scopedAuthority || !scopedMachineId || typeof scopedGeneration !== 'number')
    ) {
        return { ok: false, code: 'unavailable', reason: 'plugin_ui_action_unavailable' };
    }
    const isCurrent = params.scopeIsCurrent ?? (() => true);
    const requestCurrentIntent = projectedAction?.execution.target === 'client'
        && typeof clientProjectionGeneration === 'number'
        ? createPluginActionCurrentIntentHandler({
            requester: {
                pluginId: projectedAction.pluginId,
                contributionId: projectedAction.id,
                generationId: String(clientProjectionGeneration),
                invocationId: `ui-action:${clientProjectionGeneration}`,
            },
            isCurrent,
        })
        : undefined;
    return await dispatchPluginSurfaceAction({
        callerPluginId: action.pluginId,
        action: semanticAction.action,
        // `null` is the RPC owner's canonical no-input sentinel. The compiled
        // action itself retains absence so `openSurface` can distinguish it.
        input: semanticAction.input ?? null,
        resolveContributedAction,
        ...(projectedAction?.execution.target === 'daemon'
            ? {
                contributedAction: {
                    machineId: scopedMachineId!,
                    serverId: scopedAuthority!.serverId,
                    expectedGeneration: String(scopedGeneration),
                    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
                    ...(params.execute ? { execute: params.execute } : {}),
                },
            }
            : {}),
        ...(projectedAction?.execution.target === 'client'
            && typeof clientProjectionGeneration === 'number'
            && Number.isInteger(clientProjectionGeneration)
            && clientProjectionGeneration >= 0
            ? {
                clientAction: {
                    projectionGeneration: clientProjectionGeneration,
                    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
                    ...(params.openSurface ? { openSurface: params.openSurface } : {}),
                    ...(requestCurrentIntent ? { requestCurrentIntent } : {}),
                    ...(params.readCurrentUiContext
                        ? { currentUiContext: params.readCurrentUiContext }
                        : {}),
                },
            }
            : {}),
        ...(params.scopeIsCurrent ? { isCurrent: params.scopeIsCurrent } : {}),
    });
}
