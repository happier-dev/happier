import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { approvalArtifactSubjectIndexedKindV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { deriveManagedDeleteApprovalSubjectKeyV1, deriveManagedPowerApprovalSubjectKeyV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { ManagedMachineRefV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { selectNewestOpenApprovalSubjectId } from '@/sync/store/domains/artifactInventoryIndex';
import { sync } from '@/sync/sync';

const noApprovals = { startId: null, deleteId: null };

/** Open review links for a single managed Machine. The review screen opens the body by ID. */
export function useOpenManagedMachineApprovalIds(
    serverId: string | null | undefined,
    machine: ManagedMachineRefV1 | null | undefined,
    includeDelete: boolean,
): Readonly<{ startId: string | null; deleteId: string | null }> {
    const scope = useAccountSettingsScope();
    const profilesGeneration = useServerProfilesGeneration();
    const presented = useLayoutPresentationActive();
    const homeId = machine?.homeId;
    const managedId = machine?.managedId;
    const subject = React.useMemo(() => {
        if (!homeId || !managedId) return null;
        const startKind = approvalArtifactSubjectIndexedKindV1(deriveManagedPowerApprovalSubjectKeyV1({ homeId, managedId, intent: 'start' }));
        const deleteKind = includeDelete
            ? approvalArtifactSubjectIndexedKindV1(deriveManagedDeleteApprovalSubjectKeyV1({ homeId, managedId })) : null;
        return { startKind, deleteKind, selection: { kinds: deleteKind ? [deleteKind, startKind] : [startKind], approvalStates: ['open'] as const } };
    }, [homeId, managedId, includeDelete]);
    const matchingServer = Boolean(scope && (!serverId || areServerProfileIdentifiersEquivalent(scope.serverId, serverId)));
    React.useEffect(() => {
        if (!scope || !subject || !matchingServer || !presented) return;
        return sync.observeArtifactInventory(scope, subject.selection, { refreshOnAdmission: true });
    }, [scope?.serverId, scope?.accountId, subject, matchingServer, profilesGeneration, presented]);

    return storage(useShallow(state => {
        if (!subject || !matchingServer || !areServerAccountScopesEqual(state.profileScope, scope)) return noApprovals;
        return {
            startId: selectNewestOpenApprovalSubjectId(state, subject.startKind),
            deleteId: subject.deleteKind ? selectNewestOpenApprovalSubjectId(state, subject.deleteKind) : null,
        };
    }));
}

export function useOpenManagedMachineStartApprovalId(
    machine: ManagedMachineRefV1 | null | undefined,
): string | null {
    return useOpenManagedMachineApprovalIds(undefined, machine, false).startId;
}
