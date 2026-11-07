import type { PluginContributionClientPlatform } from '@happier-dev/protocol/plugins/contributions/catalog';
import type { AppShellClientExecutableActivationState } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import type { PluginUiProjectionPhase } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { isPluginProjectedActionExecutable, type PluginUiActionProjection, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { resolvePluginUiExecutionDeclaration } from '@/sync/domains/plugins/ui/projectionUnion';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { resolvePluginUiClientActionRegistration, resolvePluginUiClientActionRefusal } from './clientExecutableContributions';
import { isProjectedPluginUiClientActionTarget, type PluginUiClientExecutableProjectionSource } from './clientExecutableProjection';

export type PluginUiClientActionAdmission = Readonly<{
    projection: PluginUiProjectionModel | null;
    /** Catalog/Artifact replacement settlement, never positive executable admission. */
    declarationPhase?: PluginUiProjectionPhase;
    hasEstablishingMembers?: boolean;
    mountedActionProjections?: readonly PluginUiClientExecutableProjectionSource[];
    platform: PluginContributionClientPlatform;
    activation: AppShellClientExecutableActivationState;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
}>;

export type PluginUiClientActionAdmissionSource = Readonly<{
    read(): PluginUiClientActionAdmission | null;
    subscribe(listener: () => void): () => void;
}>;

export function isPluginUiClientExecutableAccountCurrent(
    owner: ActiveServerAccountScopeLifetime | null | undefined,
    caller: ActiveServerAccountScopeLifetime | null | undefined,
): boolean {
    // Routed credentials and the active Account have independent lifetimes.
    return owner?.isCurrent() === true && caller?.isCurrent() === true
        && areServerAccountScopesEqual(owner.scope, caller.scope);
}

/** Pending is a positive exact-target fact, never inferred from missing registration. */
export function isPluginUiClientActionPending(input: Readonly<{
    admission: PluginUiClientActionAdmission | null | undefined;
    accountLifetime: ActiveServerAccountScopeLifetime | null | undefined;
    action: PluginUiActionProjection | null | undefined;
    currentAction: PluginUiActionProjection | null | undefined;
}>): boolean {
    const { admission, action, currentAction } = input;
    if (admission?.activation.status !== 'establishing'
        || !isPluginUiClientExecutableAccountCurrent(admission.accountLifetime, input.accountLifetime)
        || !action || action.execution.target === 'daemon'
        || !isPluginProjectedActionExecutable(currentAction)
        || !resolvePluginUiExecutionDeclaration(action, { current: currentAction })
        || resolvePluginUiClientActionRegistration({ action, platform: admission.platform })
        || resolvePluginUiClientActionRefusal({ action, platform: admission.platform })) return false;
    return [...(admission.projection ? [{ projection: admission.projection }] : []), ...(admission.mountedActionProjections ?? [])]
        .some(source => isProjectedPluginUiClientActionTarget({ action, source, platform: admission.platform }));
}
