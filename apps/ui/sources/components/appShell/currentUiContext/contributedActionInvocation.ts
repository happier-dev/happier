import { arePluginMachineExecutionOriginsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { createPluginSurfaceActionFailureError } from '@/components/plugins/surfaces/actionFailure';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { getInstalledPluginUiClientExecutableComposition, resolvePluginUiClientActionRegistration, resolvePluginUiClientActionRefusal, type PluginUiClientActionRegistration } from '@/components/plugins/reactNative/clientExecutableContributions';
import { isPluginUiClientActionPending, isPluginUiClientExecutableAccountCurrent, type PluginUiClientActionAdmissionSource } from '@/components/plugins/reactNative/clientActionAdmission';
import { createPluginConnectionSettlement } from '@/components/plugins/surfaces/connectionSettlement';
import { readPluginUiAccountExecutableOrigin, type PluginUiAccountExecutableOrigin } from '@/components/plugins/reactNative/executableModuleHost';
import { dispatchPluginSurfaceAction, type PluginSurfaceHostActionBinding } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import { createPluginUiProjectedActionResolver, type PluginUiActionProjection, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionOrigin, resolvePluginUiExecutionDeclaration, type PluginUiContributionOriginV1 } from '@/sync/domains/plugins/ui/projectionUnion';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { areServerAccountScopesEqual, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readCurrentAppShellPluginUiProjection } from '../plugins/committedPluginUiProjection';

export type CurrentContributedAction = Readonly<{ action: PluginUiActionProjection }> & (
    | Readonly<{ kind: 'machine'; origin: PluginUiContributionOriginV1 }>
    | Readonly<{ kind: 'account'; origin: PluginUiAccountExecutableOrigin; accountRegistration: PluginUiClientActionRegistration }>
);

/** Both mounted and captured-scope invocations borrow the producer's exact current registration. */
export function resolveCurrentContributedAction(readProjection: () => PluginUiProjectionModel | null,
    identity: PluginContributionIdentityV1): CurrentContributedAction | null {
    const action = createPluginUiProjectedActionResolver(readProjection()?.actionsById)(identity);
    if (action && ('hostAccountOrigin' in action || action.execution.target === 'account' && action.execution.invokingUi)) {
        const origin = readPluginUiAccountExecutableOrigin(action);
        const accountRegistration = resolvePluginUiClientActionRegistration({ action, platform: resolvePluginUiClientExecutablePlatform() });
        if (!origin || !accountRegistration || accountRegistration.registration.accountLifetime?.isCurrent() === false
            || accountRegistration.registration.lifecycle.signal.aborted || !accountRegistration.registration.lifecycle.isCurrent()) return null;
        return Object.freeze({ kind: 'account', action, origin, accountRegistration });
    }
    const origin = action ? readPluginUiContributionOrigin(action) : null;
    if (!action || !origin || origin.phase !== 'current' || origin.interactionEnabled !== true) return null;
    // A Machine can publish its new declaration before AppShell registers its executable.
    if (action.execution.target === 'client' && !resolvePluginUiClientActionRegistration({
        action, platform: resolvePluginUiClientExecutablePlatform(),
    })) return null;
    return Object.freeze({ kind: 'machine', action, origin });
}

/** Wait for AppShell discovery, then borrow its exact lazy activation without starting another. */
export async function acquireCurrentContributedAction(input: Readonly<{
    readProjection(): PluginUiProjectionModel | null;
    identity: PluginContributionIdentityV1;
    admission?: PluginUiClientActionAdmissionSource;
    scope?: ServerAccountScope | null;
    signal?: AbortSignal;
    isCurrent(): boolean;
}>): Promise<CurrentContributedAction | null> {
    if (input.signal?.aborted || !input.isCurrent()) return null;
    const resolved = resolveCurrentContributedAction(input.readProjection, input.identity);
    if (resolved) return resolved;
    const source = input.admission;
    const owner = source?.read()?.accountLifetime;
    if (!source || !owner || !owner.isCurrent()
        || input.scope && !areServerAccountScopesEqual(input.scope, owner.scope)) return null;
    const isCurrent = () => !input.signal?.aborted && input.isCurrent() && owner.isCurrent();
    const isPending = () => {
        const admission = source.read();
        if (!isPluginUiClientExecutableAccountCurrent(admission?.accountLifetime, owner)) return false;
        const action = createPluginUiProjectedActionResolver(input.readProjection()?.actionsById)(input.identity);
        // Acquisition has not borrowed a registration yet. Follow its current
        // declaration through replacement, including a temporary discovery gap;
        // only the returned registration pins an observation to an occurrence.
        if (resolveCurrentContributedAction(input.readProjection, input.identity)) return false;
        // Only the Account census can supply a missing declaration here. An
        // unread Machine catalog might never be requested by any surface.
        if (admission?.accountCensusPending) {
            return !action || !resolvePluginUiClientActionRefusal({ action, platform: admission.platform });
        }
        return isPluginUiClientActionPending({ admission, accountLifetime: owner, action, currentAction: action });
    };
    const settlement = createPluginConnectionSettlement();
    let unsubscribeAdmission: (() => void) | undefined;
    let unsubscribeRegistration: (() => void) | undefined;
    const retirement = owner.onRetire(settlement.notify);
    try {
        const pending = settlement.wait({ isPending, isCurrent, signal: input.signal });
        if (pending) {
            unsubscribeAdmission = source.subscribe(settlement.notify);
            unsubscribeRegistration = getInstalledPluginUiClientExecutableComposition().subscribe(settlement.notify);
            // Close the read/subscribe gap through the same push-driven waiter.
            settlement.notify();
            await pending;
        }
        if (!isCurrent()) return null;
        // Borrow only the registration current after the settlement await;
        // no earlier declaration owns this not-yet-started observation.
        return resolveCurrentContributedAction(input.readProjection, input.identity);
    } finally {
        unsubscribeAdmission?.();
        unsubscribeRegistration?.();
        retirement.dispose();
        settlement.dispose();
    }
}

export function isResolvedContributedActionCurrent(readProjection: () => PluginUiProjectionModel | null,
    identity: PluginContributionIdentityV1, resolved: CurrentContributedAction): boolean {
    const current = resolveCurrentContributedAction(readProjection, identity);
    if (!current || !resolvePluginUiExecutionDeclaration(resolved.action, { current: current.action })) return false;
    if (resolved.kind === 'account') return current.kind === 'account'
        && current.accountRegistration.registration === resolved.accountRegistration.registration;
    return current.kind === 'machine' && current.origin.machineId === resolved.origin.machineId
        && current.origin.serverId === resolved.origin.serverId
        && (current.origin.executionOrigin === resolved.origin.executionOrigin
            || (current.origin.executionOrigin !== null && resolved.origin.executionOrigin !== null
                && arePluginMachineExecutionOriginsEqual(current.origin.executionOrigin, resolved.origin.executionOrigin)));
}

/** An explicit host scope needs no mounted command, navigation reader or plugin caller identity. */
export async function executeCapturedScopeContributedAction(
    request: Parameters<NonNullable<ActionExecutorDeps['invokeContributedAction']>>[0],
    hostAction: PluginSurfaceHostActionBinding,
    accountLifetime: ServerAccountScopeLifetime,
    invokeMounted?: () => Promise<ActionExecuteResult>,
): Promise<ActionExecuteResult> {
    const refused = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode,
        details: { actionHandlerInvocation: 'notStarted' } });
    const scope = accountLifetime.scope;
    const readProjection = () => readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true });
    const target = request.context.externalActionTarget;
    const machineId = target?.kind === 'machine' ? target.machineId : undefined;
    const committed = resolveCurrentContributedAction(readProjection, request.action);
    const resolved = machineId && committed?.kind === 'machine' && committed.origin.machineId !== machineId ? null : committed;
    const parsedInput = PluginJsonValueV2Schema.safeParse(request.input ?? null);
    if ((!resolved && !machineId) || !parsedInput.success || request.signal?.aborted || !accountLifetime.isCurrent()) {
        return refused('contributed_action_unavailable');
    }
    if (resolved && (!areServerProfileIdentifiersEquivalent(resolved.origin.serverId, scope.serverId)
        || resolved.kind === 'account' && resolved.origin.accountId !== scope.accountId)) return refused('action_account_scope_changed');
    if (resolved && request.context.expectedContributedActionOccurrenceId !== undefined
        && request.context.expectedContributedActionOccurrenceId !== resolved.action.occurrenceId) return refused('plugin_action_generation_retired');
    if (resolved && invokeMounted) return invokeMounted();
    const isCurrent = () => !request.signal?.aborted && accountLifetime.isCurrent()
        && (!resolved || isResolvedContributedActionCurrent(readProjection, request.action, resolved));
    // A cold exact Machine has no AppShell declaration yet. The common
    // dispatcher joins that Machine's current Action projection before admission.
    const daemonMachineId = resolved
        ? resolved.kind === 'machine' && resolved.action.execution.target === 'daemon' ? resolved.origin.machineId : undefined
        : machineId;
    const sessionId = request.context.defaultSessionId ?? request.messageActionReference?.sessionId;
    const outcome = await dispatchPluginSurfaceAction({
        action: request.action, input: parsedInput.data,
        ...(request.context.invocationServices?.connectedAccountPurposeBinding
            ? { connectedAccountPurposeBinding: request.context.invocationServices.connectedAccountPurposeBinding } : {}),
        ...(request.context.invocationServices?.managedBootstrapCredential
            ? { managedBootstrapCredential: request.context.invocationServices.managedBootstrapCredential } : {}),
        ...(request.context.actionRequestId ? { actionRequestId: request.context.actionRequestId } : {}),
        invocationSurface: 'ui', hostAction, actionAccountLifetime: accountLifetime, pluginUiProjection: readProjection(),
        ...(resolved ? {
            resolveContributedAction: identity => createPluginUiProjectedActionResolver(readProjection()?.actionsById)(identity),
        } : {}),
        requiredDangerLevel: request.requiredDangerLevel,
        expectedContributorOccurrenceId: request.context.expectedContributedActionOccurrenceId,
        clientAction: { ...(sessionId ? { sessionId } : {}),
            ...(request.messageActionReference ? { messageActionReference: request.messageActionReference } : {}) },
        ...(daemonMachineId ? {
            contributedAction: { machineId: daemonMachineId, serverId: scope.serverId, accountLifetime,
                ...(sessionId ? { sessionId } : {}),
                ...(request.messageActionReference ? { messageActionReference: request.messageActionReference } : {}) },
        } : {}),
        ...(request.signal ? { signal: request.signal } : {}), isCurrent,
    });
    if (outcome.ok) return { ok: true, result: outcome.result };
    return { ok: false, ...normalizeActionExecutorThrownError(createPluginSurfaceActionFailureError(outcome)) };
}
