import * as React from 'react';
import type { SystemTaskSpec } from '@happier-dev/protocol';

import type {
    PersonalHomeRelocationDestination,
    PersonalHomeRelocationRecovery,
    PersonalHomeRuntimeControlOperations,
} from '@/components/settings/server/localControl/PersonalHomeRuntimeControlSection';
import { createPersonalHomeRelocationTaskContinuation, resolveRelocationDirectoryPublication,
    type RelocationDirectoryPublication } from './personalHomeRelocationTaskContinuation';
import { isEligiblePersonalHomeRelocationHost } from '@/components/settings/server/localControl/personalHomeRelocationEligibility';
import { runRelayRuntimeUninstallTask } from '@/components/settings/server/localControl/useLocalRelayRuntimeControl';
import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import { buildRemoteSshManageHostSystemTaskSpec } from '@/components/systemTasks/specs/remoteSsh/buildRemoteSshManageHostSystemTaskSpec';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { randomUUID } from '@/platform/randomUUID';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useRemoteHostCatalogSnapshot } from '@/sync/store/settings/remoteHostCatalogSnapshot';
import { withRemoteHostSshConfig } from '@/sync/ops/remoteHosts/remoteHostOperations';
import { createUiHomeRuntimeActionClient } from '@/sync/ops/actions/homeRuntimeActionClient';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import {
    findPersonalHomeBootstrapCompletedProfile,
    getAccountServiceEndpointSnapshot,
    listServerProfiles,
    resolveServerProfileScopeId,
    subscribeAccountServiceEndpoint,
    type AccountServiceEndpointV1,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { t } from '@/text';


function useRelocationDirectoryPublication(enabled: boolean): RelocationDirectoryPublication | null {
    const [endpoint, setEndpoint] = React.useState<AccountServiceEndpointV1 | null>(getAccountServiceEndpointSnapshot);
    const [publication, setPublication] = React.useState<RelocationDirectoryPublication | null>(null);

    React.useEffect(() => subscribeAccountServiceEndpoint(setEndpoint), []);

    React.useEffect(() => {
        let cancelled = false;
        if (!enabled || !endpoint?.url.trim()) {
            setPublication(null);
            return undefined;
        }
        setPublication(null);
        void (async () => {
            const resolved = await resolveRelocationDirectoryPublication(endpoint);
            if (!cancelled) setPublication(resolved);
        })().catch(() => {
            if (!cancelled) setPublication(null);
        });
        return () => {
            cancelled = true;
        };
    }, [enabled, endpoint]);

    return publication;
}

export type PersonalHomeRuntimeOperations = Readonly<{
    /** This desktop's Personal Home profile (the receipt written at setup), when exactly one exists. */
    personalHomeProfile: ServerProfile | null;
    operations: PersonalHomeRuntimeControlOperations;
    searchApproval: ReturnType<typeof useMountedActionExecution>['approval'];
}>;

/**
 * The operations the Personal Home runtime section runs on the desktop that hosts it: backups,
 * restore, relocation to a Remote host, search repair, logs and data location, uninstall (plan
 * `2026-09-26-home-owner-console` §3.7, AM-3 — one composition, rendered by the Home console's
 * Runtime and Data pages). Runtime-scoped operations follow the managed runtime itself; only
 * profile-scoped ones (search repair, relocation, profile removal) need the Personal Home receipt.
 */
export function usePersonalHomeRuntimeOperations(params: Readonly<{
    /** Removes the saved profile from this app; offered only where the surface owns profile removal. */
    removeProfile?: (profile: ServerProfile) => Promise<void>;
    /** The saved profiles the surface already holds; defaults to the profile store. */
    profiles?: readonly ServerProfile[];
}> = {}): PersonalHomeRuntimeOperations {
    const { removeProfile, profiles } = params;
    const profilesGeneration = useServerProfilesGeneration();
    const personalHomeProfile = React.useMemo(
        () => findPersonalHomeBootstrapCompletedProfile(profiles ?? listServerProfiles()),
        [profiles, profilesGeneration],
    );
    const searchAction = useMountedActionExecution(personalHomeProfile ? resolveServerProfileScopeId(personalHomeProfile) : null);
    const runtimeAction = React.useMemo(() => createUiHomeRuntimeActionClient(), []);
    const hostScope = useActiveServerAccountScope();
    const hostCatalog = useRemoteHostCatalogSnapshot(hostScope);
    const remoteHostsManagementEnabled = useFeatureEnabled('remoteHosts.management');
    const remoteHostsSecretMaterialEnabled = useFeatureEnabled('remoteHosts.secretMaterial');
    const relocationDirectoryPublication = useRelocationDirectoryPublication(personalHomeProfile !== null);
    const eligibleRelocationHosts = React.useMemo(
        () => (remoteHostsManagementEnabled ? (hostCatalog?.data ?? []).filter((host) => (
            isEligiblePersonalHomeRelocationHost(host, remoteHostsSecretMaterialEnabled)
        )) : []),
        [remoteHostsManagementEnabled, hostCatalog?.data, remoteHostsSecretMaterialEnabled],
    );
    const relocationDestinations = React.useMemo<readonly PersonalHomeRelocationDestination[]>(
        () => eligibleRelocationHosts.map((host) => ({
                id: host.id,
                title: host.name,
                subtitle: host.ssh.target,
            })),
        [eligibleRelocationHosts],
    );
    const prepareRelocation = React.useCallback(async (
        destinationId: string,
        recovery?: PersonalHomeRelocationRecovery,
    ) => {
        if (!personalHomeProfile?.serverIdentityId) {
            throw new Error(t('errors.operationFailed'));
        }
        const destination = eligibleRelocationHosts.find((host) => host.id === destinationId);
        if (!destination) {
            throw new Error(t('errors.operationFailed'));
        }
        if (!hostScope || !hostCatalog || hostCatalog.stale || hostCatalog.catalog.status !== 'ready' || hostCatalog.catalog.cleanup === 'pending'
            || typeof hostCatalog.catalog.revision !== 'number') throw new Error('remote_host_catalog_unavailable');
        const revision = hostCatalog.catalog.revision;
        const channel = resolvePreferredPublicReleaseRingLabelForCurrentApp();
        const operationId = recovery?.operationId ?? `relocation-${randomUUID()}`;
        const sourceDescriptorRevision = recovery?.sourceDescriptorRevision
            ?? personalHomeProfile.homeConnectionDescriptor?.revision
            ?? 1;
        // Resolve again at the commit boundary so a configured Directory wins
        // even when the screen's capability probe has not settled yet.
        const directoryPublication = relocationDirectoryPublication
            ?? await resolveRelocationDirectoryPublication(getAccountServiceEndpointSnapshot());
        const respondToPrompt = await createPersonalHomeRelocationTaskContinuation({
            operationId, profile: personalHomeProfile, directoryPublication,
        });
        return {
            withTaskSpec: async <T,>(run: (spec: SystemTaskSpec, startSpec?: (spec: SystemTaskSpec) => Promise<string>) => Promise<T>): Promise<T> => {
                const account = await captureLazyActionAccountContext(hostScope.serverId);
                try {
                    if (account.accountId !== hostScope.accountId) throw new Error('action_account_scope_changed');
                    return await withRemoteHostSshConfig(account, { hostId: destination.id, expectedRevision: revision }, async ({ config, assertCurrent }) => {
                        assertCurrent();
                        return run(buildRemoteSshManageHostSystemTaskSpec({
                            action: 'personalHome.relocate',
                            channel,
                            sshTarget: config.value.sshTarget,
                            sshPort: config.value.sshPort ? String(config.value.sshPort) : '',
                            sshAuth: config.value.sshAuth,
                            identityFilePath: config.value.identityFilePath,
                            identityPrivateKey: config.value.identityPrivateKey,
                            sshConfigFilePath: config.value.sshConfigFilePath,
                            sshPassword: config.value.password,
                            knownHostsMode: 'app',
                            serviceMode: 'user',
                            relayRuntime: { channel, mode: 'user' },
                            personalHomeRelocation: {
                                operationId,
                                destinationMachineId: destination.id,
                                sourceDescriptorRevision,
                                ...(recovery ? { recoveryAction: recovery.recoveryAction } : {}),
                            },
                        }), async () => {
                            assertCurrent();
                            const outcome = await runtimeAction('relay.runtime.personal_home.relocate', {
                                hostId: destination.id, expectedRevision: revision,
                                sourceServerId: resolveServerProfileScopeId(personalHomeProfile),
                                operationId, sourceDescriptorRevision,
                                ...(recovery ? { recoveryAction: recovery.recoveryAction } : {}),
                            }, { serverId: hostScope.serverId, expectedAccountId: hostScope.accountId });
                            if (!('status' in outcome) || outcome.status !== 'task_started') throw new Error('reason' in outcome ? outcome.reason : t('settings.systemTaskStartFailed'));
                            return outcome.taskId;
                        });
                    });
                } finally { account.dispose(); }
            },
            respondToPrompt,
        };
    }, [eligibleRelocationHosts, hostCatalog, hostScope, personalHomeProfile, relocationDirectoryPublication, runtimeAction]);
    const prepareRelocationRecovery = React.useCallback(async (recovery: PersonalHomeRelocationRecovery) => {
        return await prepareRelocation(recovery.destinationMachineId, recovery);
    }, [prepareRelocation]);
    // Runtime-scoped Personal Home operations follow the authoritative managed runtime, not a saved
    // profile receipt: removing the profile from this app must not disarm backup, restore, verify,
    // diagnostics, or safe runtime uninstall for the Home still running on this computer. Only
    // genuinely profile-scoped actions are withheld when no completed profile remains, because they
    // have no target rather than because the Home is gone.
    const personalHomeOperations = React.useMemo<PersonalHomeRuntimeControlOperations>(() => {
        const openPath = async (path: string) => {
            const normalizedPath = path.trim();
            if (!normalizedPath) throw new Error(t('settings.systemTaskOpenLogsFailed'));
            const outcome = await runtimeAction('relay.runtime.open_path', { path: normalizedPath });
            if (!('status' in outcome) || outcome.status !== 'completed') throw new Error('reason' in outcome ? outcome.reason : t('settings.systemTaskOpenLogsFailed'));
        };
        return {
            ...(personalHomeProfile ? {
                repairSearch: async () => {
                    const result = await searchAction.execute('home.search.rebuild', {});
                    if (!result.ok) {
                        if (result.errorCode === 'approval_canceled' || result.errorCode === 'approval_rejected') return false;
                        throw new Error(result.error);
                    }
                    if (!getActionSpec('home.search.rebuild').outputSchema?.safeParse(result.result).success) throw new Error(t('errors.operationFailed'));
                    return true;
                },
                ...(removeProfile ? { removeProfile: async () => await removeProfile(personalHomeProfile) } : {}),
            } : {}),
            uninstallRuntime: async () => {
                await runRelayRuntimeUninstallTask(getDefaultSystemTaskRunner());
            },
            openDataLocation: openPath,
            openLogs: openPath,
            revealBackupOutput: async (path: string) => {
                const normalizedPath = path.trim();
                if (!normalizedPath) throw new Error(t('settings.systemTaskOpenLogsFailed'));
                const outcome = await runtimeAction('relay.runtime.reveal_output', { path: normalizedPath });
                if (!('status' in outcome) || outcome.status !== 'completed') throw new Error('reason' in outcome ? outcome.reason : t('settings.systemTaskOpenLogsFailed'));
            },
            selectBackupArchive: async () => {
                const outcome = await runtimeAction('relay.runtime.personal_home.choose_archive', {});
                if (!('path' in outcome)) throw new Error('reason' in outcome ? outcome.reason : t('errors.operationFailed'));
                return outcome.path;
            },
            selectBackupExportDestination: async () => {
                const outcome = await runtimeAction('relay.runtime.personal_home.choose_backup_destination', {});
                if (!('path' in outcome)) throw new Error('reason' in outcome ? outcome.reason : t('errors.operationFailed'));
                return outcome.path;
            },
            // Relocation needs the adopted profile's stable Home identity and descriptor revision,
            // so it stays profile-scoped alongside search repair and profile removal.
            ...(personalHomeProfile && relocationDestinations.length > 0
                ? {
                    relocation: {
                        destinations: relocationDestinations,
                        prepare: prepareRelocation,
                        prepareRecovery: prepareRelocationRecovery,
                    },
                }
                : {}),
        };
    }, [removeProfile, personalHomeProfile, prepareRelocation, prepareRelocationRecovery, relocationDestinations, runtimeAction, searchAction.execute]);

    return React.useMemo(() => ({ personalHomeProfile, operations: personalHomeOperations, searchApproval: searchAction.approval }), [personalHomeProfile, personalHomeOperations, searchAction.approval]);
}
