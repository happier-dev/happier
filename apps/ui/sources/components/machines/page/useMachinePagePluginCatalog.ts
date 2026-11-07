import * as React from 'react';

import { useAppShellPluginUiDeclarationSources } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { selectPluginPagePlacements, usePluginPages, type PluginPageTarget } from '@/components/plugins/pages/pluginPages';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { usePluginExecutionOriginProjectionDemand } from '@/sync/domains/machines/administration/usePluginExecutionOriginProjectionDemand';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';

import type { MachinePageTarget } from './useMachinePageTarget';

export type MachinePagePluginCatalog = Readonly<{
    target: Extract<PluginPageTarget, { kind: 'machine' }>;
    pluginPages: ReturnType<typeof usePluginPages>;
    projection: ReturnType<typeof useAppShellPluginUiDeclarationSources>['projection'];
    authority: ReturnType<typeof useAppShellPluginUiDeclarationSources>['accountLifetime'];
}>;

/**
 * The presented Machine supplies its own declaration demand, including owner
 * installations absent from a Use viewer's Account census. AppShell observes
 * the shared acquisition; selected pages still use the existing Surface owner.
 */
export function useMachinePagePluginCatalog(
    machine: Pick<MachinePageTarget, 'serverId' | 'machineId' | 'machine' | 'switchReady'>,
    policyContext?: PluginUiPolicyEvaluationContext,
): MachinePagePluginCatalog {
    const declarations = useAppShellPluginUiDeclarationSources();
    const locale = usePreferredLanguage();
    const target = React.useMemo((): Extract<PluginPageTarget, { kind: 'machine' }> => ({
        kind: 'machine', serverId: machine.serverId, machineId: machine.machineId,
    }), [machine.serverId, machine.machineId]);
    const localize = usePluginLocalizedTextResolver({ locale, projection: declarations.projection });
    const ready = machine.switchReady && machine.machine !== null
        && target.serverId.trim().length > 0 && target.machineId.trim().length > 0;
    const sameAccountHome = declarations.accountLifetime?.isCurrent() === true
        && areServerProfileIdentifiersEquivalent(declarations.accountLifetime.scope.serverId, target.serverId);
    const presented = useLayoutPresentationActive();
    const serverIdentityId = resolvePortableServerIdentityForRoutingId(target.serverId);
    const demandTarget = React.useMemo(() => ready && sameAccountHome && presented && serverIdentityId
        ? { serverIdentityId, machineId: target.machineId } : null,
    [presented, ready, sameAccountHome, serverIdentityId, target.machineId]);
    usePluginExecutionOriginProjectionDemand(demandTarget, { accountLifetime: declarations.accountLifetime, observe: false });
    const placements = React.useMemo(() => ready && sameAccountHome
        ? selectPluginPagePlacements(declarations.projection, { container: 'appPage', targetKind: 'machine' })
        : [], [ready, sameAccountHome, declarations.projection]);
    const pluginPages = usePluginPages({ target, placements, policyContext, localize });
    return React.useMemo(() => ({
        target, pluginPages, projection: declarations.projection, authority: declarations.accountLifetime,
    }), [target, pluginPages, declarations.projection, declarations.accountLifetime]);
}

const NO_PAGES: ReturnType<typeof usePluginPages> = [];
const MachinePagePluginPagesContext = React.createContext<ReturnType<typeof usePluginPages>>(NO_PAGES);

/** The Machine page hands its admitted plugin pages to the tab body that mounts the selected one. */
export const MachinePagePluginPagesProvider = MachinePagePluginPagesContext.Provider;

export function useMachinePagePluginPages(): ReturnType<typeof usePluginPages> {
    return React.useContext(MachinePagePluginPagesContext);
}
