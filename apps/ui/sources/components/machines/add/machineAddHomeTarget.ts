import * as React from 'react';

import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { useServerFeaturesSnapshotForServerId, type ServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { buildHomeConnectionDescriptorForProfile, getServerProfileById, resolveSavedServerProfileByUrl,
    type ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { MachineAddHomeTarget } from './machineAddCommand';

function projectMachineAddHomeTarget(profile: ServerProfile | null, snapshot: ServerFeaturesRuntimeSnapshot,
    fallbackHomeUrl: string | null): MachineAddHomeTarget {
    return { descriptor: profile ? buildHomeConnectionDescriptorForProfile(profile) : null,
        guestCli: profile && snapshot.status === 'ready' ? snapshot.features.capabilities.guestCli : undefined,
        fallbackHomeUrl: profile?.serverUrl ?? fallbackHomeUrl };
}

/** Presentation consumes the selected Home's existing pushed feature snapshot. */
export function useMachineAddHomeTarget(profile: ServerProfile | null,
    options?: Readonly<{ enabled?: boolean; fallbackHomeUrl?: string | null }>): MachineAddHomeTarget {
    const snapshot = useServerFeaturesSnapshotForServerId(profile?.id, {
        enabled: profile !== null && options?.enabled !== false,
    });
    return React.useMemo(() => projectMachineAddHomeTarget(profile, snapshot, options?.fallbackHomeUrl ?? null),
        [profile, snapshot, options?.fallbackHomeUrl]);
}

/** URL-oriented onboarding resolves the same saved Home rather than inferring a CLI from its URL. */
export function useMachineAddHomeTargetAtUrl(serverUrl: string | null | undefined): MachineAddHomeTarget {
    const generation = useServerProfilesGeneration();
    const profile = React.useMemo(() => {
        const resolved = serverUrl ? resolveSavedServerProfileByUrl(serverUrl, { includeCanonicalServerUrl: true }) : null;
        return resolved?.kind === 'resolved' ? resolved.profile : null;
    }, [serverUrl, generation]);
    return useMachineAddHomeTarget(profile, { fallbackHomeUrl: serverUrl ?? null });
}

/** Action execution captures the same Home facts through the existing feature-read adapter. */
export async function readMachineAddHomeTargetForServerId(serverId: string,
    signal?: AbortSignal): Promise<MachineAddHomeTarget | null> {
    const profile = getServerProfileById(serverId);
    if (!profile) return null;
    const snapshot = await getServerFeaturesSnapshot({ serverId: profile.id, signal });
    return projectMachineAddHomeTarget(profile, snapshot, null);
}
