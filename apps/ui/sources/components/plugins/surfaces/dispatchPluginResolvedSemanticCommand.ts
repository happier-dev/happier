import type { CurrentUiContextSnapshotV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiResolvedSemanticCommandV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { getPluginMachineExecutionOriginRef } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';

import {
    createPluginUiProjectedActionResolver,
    isPluginProjectedActionExecutable,
    type PluginUiActionProjection,
    type PluginUiProjectedActionResolver,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import {
    PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY,
    readPluginUiContributionOrigin,
    resolvePluginUiExecutionDeclaration,
} from '@/sync/domains/plugins/ui/projectionUnion';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { readPluginUiAccountExecutableOrigin } from '@/sync/domains/plugins/ui/projectionOrigins';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import type { PopoverAnchor } from '@/components/ui/popover';
import { launchPluginSurfaceAction } from './launchPluginSurfaceAction';
import type { PluginSurfaceScopedLaunchFacts } from './pluginSurfaceLaunchAuthority';
import type {
    PluginSurfaceActionDispatchOutcome,
    PluginSurfaceContributedActionTransport,
} from './pluginSurfaceActionDispatch';
import type {
    PluginSurfaceOpenHandler,
    PluginSurfaceOpenOutcome,
} from './openPluginSurface';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

/**
 * The one host router from an already-resolved plugin semantic command to its
 * canonical owner.
 *
 * Every declarative family whose descriptor carries `executeAction |
 * openSurface` — Session header actions today, Universal Search provider rows
 * now — routes through here. Each family still owns which contribution the
 * reader picked and which host facts scope it; none of them owns *how* a
 * command executes. Before this module there was one such router living inside
 * the Session-header adapter, and a second family would have had to copy its
 * daemon/client target branch, its generation check and its current-intent
 * handler — three places for one decision.
 *
 * It adds no authority: `launchPluginSurfaceAction` remains the §3.5 dispatcher
 * that owns identity qualification, the `executionSurface: 'ui'` stamp,
 * AbortSignal/RPC cancellation and the typed failure vocabulary, and the
 * caller-supplied `openSurface` remains the destination owner.
 */

/**
 * Semantic commands are not a second scope resolver. The registered scope
 * already owns whether its retained projection is current and exactly which
 * machine/server admitted it. A retained descriptor stays
 * displayable, but it is not interaction authority once that owner revokes it.
 */
export function resolveCurrentPluginSemanticCommandScope(
    _projection: PluginUiProjectionModel,
    scopedLaunchFacts: PluginSurfaceScopedLaunchFacts | null | undefined,
): PluginSurfaceScopedLaunchFacts | null {
    if (
        !scopedLaunchFacts
        || scopedLaunchFacts.interactionEnabled !== true
        || !scopedLaunchFacts.machineId
        || scopedLaunchFacts.machineId.trim().length === 0
    ) {
        return null;
    }
    return scopedLaunchFacts;
}

/** Client-target Actions retain the projection's currentness without a daemon address. */
export function isCurrentPluginSemanticCommandProjection(
    _projection: PluginUiProjectionModel,
    scopedLaunchFacts: PluginSurfaceScopedLaunchFacts | null | undefined,
): boolean {
    return scopedLaunchFacts?.interactionEnabled === true;
}

function hasContributionOriginField(entry: unknown): boolean {
    return entry !== null
        && typeof entry === 'object'
        && Object.prototype.hasOwnProperty.call(entry, PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY);
}

function resolveProjectedActionExecutionScope(
    projection: PluginUiProjectionModel,
    projectedAction: PluginUiActionProjection,
    scopedLaunchFacts: PluginSurfaceScopedLaunchFacts | null | undefined,
): PluginSurfaceScopedLaunchFacts | null {
    if (!hasContributionOriginField(projectedAction)) {
        return resolveCurrentPluginSemanticCommandScope(projection, scopedLaunchFacts);
    }
    if (!isCurrentPluginSemanticCommandProjection(projection, scopedLaunchFacts)) return null;
    const origin = readPluginUiContributionOrigin(projectedAction);
    const executionOrigin = origin?.executionOrigin ?? null;
    const executionRef = executionOrigin ? getPluginMachineExecutionOriginRef(executionOrigin) : null;
    if (
        !origin
        || origin.phase !== 'current'
        || origin.interactionEnabled !== true
        || (
            executionRef !== null
            && (
                executionRef.pluginId !== projectedAction.pluginId
                || executionRef.machineId !== origin.machineId
            )
        )
    ) return null;
    return Object.freeze({
        serverId: origin.serverId,
        machineId: origin.machineId,
        interactionEnabled: true,
    });
}

export type DispatchPluginResolvedSemanticCommandInput = Readonly<{
    actionInputAnchor?: PopoverAnchor;
    projection: PluginUiProjectionModel;
    /** The plugin whose contribution the reader activated. */
    callerPluginId: string;
    command: PluginUiResolvedSemanticCommandV1;
    /** An already-captured query execution; retirement cannot silently select its replacement. */
    expectedAction?: PluginUiActionProjection;
    scopedLaunchFacts?: PluginSurfaceScopedLaunchFacts | null;
    /** Existing Account-lifetime predicate; never reconstructed by this router. */
    scopeIsCurrent?: (() => boolean) | null;
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    sessionId?: string | null;
    execute?: PluginSurfaceContributedActionTransport;
    openSurface?: PluginSurfaceOpenHandler;
    readCurrentUiContext?: () => CurrentUiContextSnapshotV1 | null | undefined;
    /**
     * Forwarded to the canonical dispatcher, which refuses an already-aborted
     * invocation and carries the signal into machine-RPC cancellation.
     */
    signal?: AbortSignal;
}>;

export async function dispatchPluginResolvedSemanticCommand(
    input: DispatchPluginResolvedSemanticCommandInput,
): Promise<PluginSurfaceActionDispatchOutcome | PluginSurfaceOpenOutcome> {
    const { projection, command } = input;
    if (command.kind === 'openSurface') {
        if (
            !isCurrentPluginSemanticCommandProjection(projection, input.scopedLaunchFacts)
            || input.scopeIsCurrent?.() === false
        ) {
            return { ok: false, code: 'stale_surface', reason: 'plugin_ui_generation_retired' };
        }
        if (!input.openSurface) {
            return { ok: false, code: 'unavailable', reason: 'plugin_ui_surface_open_unavailable' };
        }
        return await input.openSurface({
            destination: command.destination,
            ...(command.input === undefined ? {} : { input: command.input }),
            ...(command.subPath === undefined ? {} : { subPath: command.subPath }),
            ...(command.instanceKey === undefined ? {} : { instanceKey: command.instanceKey }),
            ...(command.presentation === undefined ? {} : { presentation: command.presentation }),
        });
    }

    const resolveDeclaration = createPluginUiProjectedActionResolver(projection.actionsById);
    const expectedAction = input.expectedAction;
    const isExpectedAction = (identity: PluginContributionIdentityV1) => expectedAction !== undefined
        && expectedAction.pluginId === identity.pluginId && expectedAction.id === identity.localId;
    const readAccountDeclaration: PluginUiProjectedActionResolver = identity => {
        if (!input.accountLifetime?.isCurrent()) return null;
        const current = createPluginUiProjectedActionResolver(readCurrentAppShellPluginUiProjection({
            scope: input.accountLifetime.scope, declarationsOnly: true,
        })?.actionsById)(identity);
        return current?.hostAccountOrigin ? current : null;
    };
    const resolveContributedAction: PluginUiProjectedActionResolver = identity => {
        const declaration = resolveDeclaration(identity) ?? readAccountDeclaration(identity);
        if (!declaration) return null;
        const expected = isExpectedAction(identity) ? expectedAction : undefined;
        if (declaration.execution.target !== 'account' || !input.accountLifetime
            || readPluginUiAccountExecutableOrigin(declaration)) {
            return expected ? resolvePluginUiExecutionDeclaration(expected, { current: declaration }) : declaration;
        }
        return resolvePluginUiExecutionDeclaration(expected ?? declaration, { current: readAccountDeclaration(identity) });
    };
    // A captured query fixes the original intent, not the identities of the
    // independently admitted Actions its handler may call.
    const projectedAction = expectedAction && !isExpectedAction(command.action)
        ? null : resolveContributedAction(command.action);
    if (!isPluginProjectedActionExecutable(projectedAction)) {
        return { ok: false, code: 'unavailable', reason: 'plugin_ui_action_unavailable' };
    }
    // Account code stays local; an explicit current Machine is only a borrowed
    // address for nested source operations, never the Account artifact supplier.
    const accountOrigin = readPluginUiAccountExecutableOrigin(projectedAction);
    const scopedAuthority = accountOrigin
        ? resolveCurrentPluginSemanticCommandScope(projection, input.scopedLaunchFacts)
        : resolveProjectedActionExecutionScope(projection, projectedAction, input.scopedLaunchFacts);
    const scopedMachineId = scopedAuthority?.machineId;
    if (
        projectedAction.execution.target === 'daemon'
        && (!scopedAuthority || !scopedMachineId)
    ) {
        return { ok: false, code: 'unavailable', reason: 'plugin_ui_action_unavailable' };
    }
    const launched = await launchPluginSurfaceAction({
        actionInputAnchor: input.actionInputAnchor,
        callerPluginId: input.callerPluginId,
        // Structured, never the qualified string: a bare string would be offered
        // to the dispatcher's host ActionSpec branch first, so a plugin whose
        // local action id matched a `surfaces.plugin` ActionSpec id could be
        // routed to the wrong executor.
        action: command.action,
        ...(command.input === undefined ? {} : { input: command.input }),
        resolveContributedAction,
        pluginUiProjection: projection,
        ...(accountOrigin && input.accountLifetime ? {
            hostAction: {
                execute: scopedHomeActionExecutor(input.accountLifetime.scope),
                context: {
                    serverId: input.accountLifetime.scope.serverId,
                    expectedAccountId: input.accountLifetime.scope.accountId,
                    ...(input.sessionId ? { defaultSessionId: input.sessionId } : {}),
                },
            },
        } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...((projectedAction.execution.target === 'daemon'
            || (accountOrigin && scopedMachineId))
            ? {
                contributedAction: {
                    machineId: scopedMachineId!,
                    serverId: scopedAuthority!.serverId,
                    ...(accountOrigin && input.accountLifetime
                        ? { accountLifetime: input.accountLifetime } : {}),
                    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                    ...(input.execute ? { execute: input.execute } : {}),
                },
            }
            : {}),
        ...(projectedAction.execution.target !== 'daemon'
            ? {
                clientAction: {
                    ...(input.execute ? { execute: input.execute } : {}),
                    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                    ...(input.openSurface ? { openSurface: input.openSurface } : {}),
                    ...(input.readCurrentUiContext
                        ? { currentUiContext: input.readCurrentUiContext }
                        : {}),
                },
            }
            : {}),
        ...(input.scopeIsCurrent ? { isCurrent: input.scopeIsCurrent } : {}),
    });
    return launched.outcome;
}
