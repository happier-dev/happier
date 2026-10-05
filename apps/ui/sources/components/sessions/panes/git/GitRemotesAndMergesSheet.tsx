import * as React from 'react';
import type { Router } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { SourceControlBranchIntegrationSection } from '@/components/workspaces/scm/update/SourceControlBranchIntegrationSection';
import { SourceControlPublishRepositorySection } from '@/components/workspaces/scm/update/SourceControlPublishRepositorySection';
import { SourceControlRemotesSection } from '@/components/workspaces/scm/update/SourceControlRemotesSection';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { Modal } from '@/modal';
import { useProjectForSession, useSessionListRenderableWithServerScope, useSessionProjectScmInFlightOperation, useSessionProjectScmSnapshot } from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveSessionWorkspacePath } from '@/sync/domains/session/resolveSessionWorkspacePath';
import { sessionScmHostingRepositoryDescribePublishTargets, sessionScmHostingRepositoryPublish } from '@/sync/ops/sessions';
import { t } from '@/text';

import { useSessionGitRepositoryMutations } from './useSessionGitRepositoryMutations';

type Props = Readonly<{ sessionId: string; serverId?: string; navigation: Pick<Router, 'push'>; onClose: () => void }>;

/**
 * The rare repository tasks the Git pane's one scroll does not carry (Git lab: "Sync stops being a place"):
 * remotes, starting a merge or rebase, and putting a repository without a remote on a host. Opened from the
 * header menu; it reads the live snapshot itself and writes through the same operation lock and log.
 */
function GitRemotesAndMergesSheetBody(props: Props) {
    const router = props.navigation;
    const { theme } = useUnistyles();
    const snapshot = useSessionProjectScmSnapshot(props.sessionId, props.serverId);
    const inFlight = useSessionProjectScmInFlightOperation(props.sessionId, props.serverId);
    const session = useSessionListRenderableWithServerScope(props.serverId, props.sessionId);
    const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
    const project = useProjectForSession(props.sessionId, props.serverId);
    const activeServer = useActiveServerSnapshot();
    const sessionPath = resolveSessionWorkspacePath({ sessionPath: ownerMetadata?.path ?? null, projectPath: project?.key?.rootPath ?? null });
    const mutations = useSessionGitRepositoryMutations({ sessionId: props.sessionId, serverId: props.serverId, sessionPath });
    const busy = inFlight !== null;
    const providerKind = snapshot?.hostingProvider?.kind ?? null;
    const machineId = project?.key.machineId ?? ownerMetadata?.machineId ?? null;
    const serverId = props.serverId ?? project?.key.serverId ?? activeServer.serverId;
    const openMachineInstallables = React.useCallback(() => {
        if (!machineId) return;
        props.onClose();
        router.push(`/machine/${encodeURIComponent(machineId)}/installables${serverId ? `?serverId=${encodeURIComponent(serverId)}` : ''}` as never);
    }, [machineId, props, router, serverId]);
    const openGitHub = React.useCallback(() => {
        props.onClose();
        router.push({ pathname: '/(app)/settings/connected-services/[serviceId]', params: { serviceId: 'github' } });
    }, [props, router]);
    return (
        <ScrollView style={{ maxHeight: 640 }} contentContainerStyle={{ paddingBottom: 12 }}>
            <View style={{ gap: 4 }}>
                <SourceControlPublishRepositorySection
                    theme={theme}
                    snapshot={snapshot}
                    writeEnabled
                    disabled={busy}
                    publishTargets={null}
                    onDescribePublishTargets={() => sessionScmHostingRepositoryDescribePublishTargets(props.sessionId, {
                        ...(providerKind ? { providerKind } : {}),
                    }, props.serverId)}
                    onPublishRepository={(request) => sessionScmHostingRepositoryPublish(props.sessionId, request, props.serverId)}
                    onRefresh={mutations.refresh}
                    onConnectGitHub={openGitHub}
                    onInstallGh={machineId ? openMachineInstallables : undefined}
                    onUseManagedGh={machineId ? openMachineInstallables : undefined}
                    onAuthenticateGh={machineId ? openMachineInstallables : undefined}
                />
                <SourceControlRemotesSection
                    theme={theme}
                    snapshot={snapshot}
                    writeEnabled
                    disabled={busy}
                    onAddRemote={mutations.addRemote}
                    onSetRemoteUrl={mutations.setRemoteUrl}
                    onRemoveRemote={mutations.removeRemote}
                />
                <SourceControlBranchIntegrationSection
                    theme={theme}
                    snapshot={snapshot}
                    rootPath={sessionPath}
                    writeEnabled
                    disabled={busy}
                    onMerge={mutations.mergeBranch}
                    onRebase={mutations.rebaseBranch}
                    onContinue={mutations.continueBranchOperation}
                    onAbort={mutations.abortBranchOperation}
                    onSkip={mutations.skipBranchOperation}
                />
            </View>
        </ScrollView>
    );
}

export function showGitRemotesAndMergesSheet(input: Readonly<{ sessionId: string; serverId?: string; navigation: Pick<Router, 'push'> }>): void {
    Modal.show({
        component: GitRemotesAndMergesSheetBody,
        props: { sessionId: input.sessionId, serverId: input.serverId, navigation: input.navigation },
        chrome: { kind: 'card', title: t('sessionGitPane.flow.tools.title'), testID: 'session-git-remotes-and-merges', dimensions: { size: 'lg' } },
    });
}
