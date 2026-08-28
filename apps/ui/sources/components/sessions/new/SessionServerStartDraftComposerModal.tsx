import * as React from 'react';
import { ScrollView, View } from 'react-native';

import type { SessionServerStartSpawnDraftV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { useAllMachines, useMachineListByServerId, useSettings } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveAgentExecutionTargetForBackendTarget } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';
import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { machineMetadataPlatformToTarget } from '@/utils/path/machinePlatform';
import {
    buildNewSessionAuthoringDraftFromResolvedInputs,
    buildSessionServerStartSpawnDraftV1FromAuthoringDraft,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { PathSelectionList } from '@/components/sessions/new/components/PathSelectionList';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type {
    SessionServerStartDraftSeed,
    SessionServerStartDraftTarget,
} from './serverStartDraftComposer';
import { resolveSessionServerStartCandidateSelection } from './serverStartDraftCandidateSelection';

type Props = CustomModalInjectedProps & Readonly<{
    seed: SessionServerStartDraftSeed;
    target: SessionServerStartDraftTarget;
    onResolve: (draft: SessionServerStartSpawnDraftV1 | null) => void;
}>;

type ResolvedAgentCandidate = Readonly<{
    backendTargetKey: string;
    agentId: string;
    title: string;
    subtitle: string | null;
    backendTarget: ReturnType<typeof getResolvedBackendCatalogEntries>[number]['backendTarget'];
    agentTarget: NonNullable<ReturnType<typeof resolveAgentExecutionTargetForBackendTarget>>;
}>;

function resolveInitialAgentKey(params: Readonly<{
    candidates: readonly ResolvedAgentCandidate[];
    seedAgentId?: string;
}>): string | null {
    return params.candidates.find((candidate) => candidate.agentId === params.seedAgentId)?.backendTargetKey
        ?? params.candidates.find((candidate) => candidate.agentId === DEFAULT_AGENT_ID)?.backendTargetKey
        ?? params.candidates[0]?.backendTargetKey
        ?? null;
}

/**
 * Session-owned, transient authoring surface for the one literal host action.
 * It intentionally contains no persisted-draft, secret, Action, or Session
 * creation path: it merely projects current New Session fields into a strict
 * server-start draft for the caller that already owns the eventual effect.
 */
export function SessionServerStartDraftComposerModal(props: Props): React.ReactElement {
    const machines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const activeServer = useActiveServerSnapshot();
    const settings = useSettings() ?? settingsDefaults;
    const enabledAgentIds = useEnabledAgentIds();
    const initialCandidateIndex = props.seed.directory === undefined
        ? -1
        : props.seed.candidates?.findIndex((candidate) => (
            candidate.serverId === props.target.serverId
            && candidate.machineId === props.target.machineId
            && candidate.rootPath === props.seed.directory
        )) ?? -1;
    const [selectedCandidateIndex, setSelectedCandidateIndex] = React.useState(initialCandidateIndex);
    const selectedPlacementCandidate = selectedCandidateIndex < 0
        ? undefined
        : props.seed.candidates?.[selectedCandidateIndex];
    const selectedPlacement = React.useMemo(() => resolveSessionServerStartCandidateSelection({
        mountedTarget: props.target,
        selectedCandidate: selectedPlacementCandidate,
        activeServerId: String(activeServer.serverId ?? ''),
        activeMachines: machines,
        machineListByServerId,
    }), [activeServer.serverId, machineListByServerId, machines, props.target, selectedPlacementCandidate]);
    const selectedTarget = selectedPlacement.target;
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: selectedTarget.machineId,
        serverId: selectedTarget.serverId,
        enabled: true,
        staleMs: 0,
    });
    const machine = selectedPlacement.machine;
    const candidates = React.useMemo<readonly ResolvedAgentCandidate[]>(() => {
        if (daemonMergedProjection.phase !== 'ready') return [];
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            collapseConfiguredBackendProviderSentinels: true,
            mergedProviderProjectionById: daemonMergedProjection.inputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: daemonMergedProjection.inputs?.mergedBackendProjectionById ?? null,
            discoveredBackendIds: daemonMergedProjection.inputs?.discoveredBackendIds,
        }).flatMap((entry) => {
            const agentTarget = entry.backendTarget.kind === 'agent'
                ? entry.backendTarget
                : resolveAgentExecutionTargetForBackendTarget({
                    backendTarget: entry.backendTarget,
                    daemonMergedProjectionInputs: daemonMergedProjection.inputs,
                });
            return agentTarget ? [{
                backendTargetKey: entry.backendTargetKey,
                agentId: entry.agentId,
                title: entry.title,
                subtitle: entry.subtitle,
                backendTarget: entry.backendTarget,
                agentTarget,
            }] : [];
        });
    }, [
        daemonMergedProjection.inputs,
        daemonMergedProjection.phase,
        enabledAgentIds,
        settings.acpCatalogSettingsV1,
        settings.backendEnabledByTargetKey,
    ]);
    const [selectedAgentKey, setSelectedAgentKey] = React.useState<string | null>(() => (
        resolveInitialAgentKey({ candidates, seedAgentId: props.seed.agentId })
    ));
    const selectedAgent = candidates.find((candidate) => candidate.backendTargetKey === selectedAgentKey)
        ?? candidates.find((candidate) => candidate.backendTargetKey === resolveInitialAgentKey({
            candidates,
            seedAgentId: props.seed.agentId,
        }))
        ?? null;
    const [directory, setDirectory] = React.useState(() => (
        props.seed.directory ?? selectedPlacement.directory ?? machine?.metadata?.homeDir ?? ''
    ));
    const [error, setError] = React.useState(false);

    React.useEffect(() => {
        if (!selectedAgent) {
            setSelectedAgentKey(resolveInitialAgentKey({ candidates, seedAgentId: props.seed.agentId }));
        }
    }, [candidates, props.seed.agentId, selectedAgent]);

    React.useEffect(() => {
        if (!directory.trim() && (props.seed.directory ?? machine?.metadata?.homeDir)) {
            setDirectory(props.seed.directory ?? machine?.metadata?.homeDir ?? '');
        }
    }, [directory, machine?.metadata?.homeDir, props.seed.directory]);

    const canSubmit = selectedPlacement.machineReady
        && daemonMergedProjection.phase === 'ready'
        && selectedAgent !== null
        && directory.trim().length > 0;
    const dismiss = React.useCallback(() => {
        props.onResolve(null);
        props.onClose();
    }, [props]);
    const submit = React.useCallback(() => {
        if (!selectedAgent || !canSubmit) return;
        try {
            const now = Date.now();
            const permissionMode = props.seed.permissionMode ?? 'default';
            const authoringDraft = buildNewSessionAuthoringDraftFromResolvedInputs({
                directory: directory.trim(),
                checkoutCreationDraft: null,
                prompt: '',
                displayText: '',
                agentId: selectedAgent.agentId,
                backendTarget: selectedAgent.backendTarget,
                transcriptStorage: null,
                profileId: null,
                environmentVariables: null,
                resumeSessionId: null,
                permissionMode,
                permissionModeUpdatedAt: now,
                modelSelection: null,
                mcpSelection: null,
                connectedServices: null,
                terminal: null,
                windowsRemoteSessionLaunchMode: null,
                windowsRemoteSessionConsole: null,
                windowsTerminalWindowName: null,
                runtimeDescriptorV1: null,
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
                automation: null,
            });
            props.onResolve(buildSessionServerStartSpawnDraftV1FromAuthoringDraft({
                draft: authoringDraft,
                executionTarget: selectedTarget,
                agentTarget: selectedAgent.agentTarget,
                permissionMode,
                configurationUpdatedAtMs: now,
            }));
            props.onClose();
        } catch {
            setError(true);
        }
    }, [canSubmit, directory, props, selectedAgent, selectedTarget]);
    const footer = React.useMemo(() => (
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8, paddingHorizontal: 16, paddingVertical: 12 }}>
            <RoundButton title={t('common.cancel')} display="inverted" onPress={dismiss} />
            <RoundButton title={t('common.create')} onPress={submit} disabled={!canSubmit} />
        </View>
    ), [canSubmit, dismiss, submit]);
    useModalCardChrome(props.setChrome, {
        kind: 'card',
        title: t('newSession.title'),
        footer,
        dimensions: { size: 'md', maxHeightRatio: 0.88 },
        scrollHost: 'body',
    });

    return (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 16 }}>
            <ItemGroup title={t('newSession.selectWorkingDirectoryTitle')}>
                {props.seed.candidates?.map((candidate, index) => (
                    <Item
                        key={'id' in candidate.projectKey
                            ? candidate.projectKey.id
                            : `${candidate.serverId}:${candidate.machineId}:${candidate.rootPath}`}
                        title={candidate.label ?? candidate.rootPath}
                        subtitle={`${candidate.machineId} · ${candidate.serverId}`}
                        selected={index === selectedCandidateIndex}
                        onPress={() => {
                            setError(false);
                            setSelectedCandidateIndex(index);
                            setDirectory(candidate.rootPath);
                        }}
                        showChevron={false}
                        showDivider={true}
                    />
                ))}
                <PathSelectionList
                    initialValue={directory}
                    machineHomeDir={machine?.metadata?.homeDir ?? '/home'}
                    favorites={[]}
                    recents={[]}
                    machineId={machine?.id ?? null}
                    serverId={selectedTarget.serverId}
                    machinePlatform={machineMetadataPlatformToTarget(machine?.metadata?.platform)}
                    onCommit={(value) => {
                        setError(false);
                        setDirectory(value);
                    }}
                    onChangeDraftPath={(value) => {
                        setError(false);
                        setDirectory(value);
                    }}
                    onRequestClose={() => undefined}
                    maxHeight={300}
                />
            </ItemGroup>
            <ItemGroup title={t('newSession.selectAiBackendTitle')}>
                {candidates.map((candidate, index) => (
                    <Item
                        key={candidate.backendTargetKey}
                        title={candidate.title}
                        subtitle={candidate.subtitle ?? undefined}
                        selected={candidate.backendTargetKey === selectedAgent?.backendTargetKey}
                        onPress={() => {
                            setError(false);
                            setSelectedAgentKey(candidate.backendTargetKey);
                        }}
                        showChevron={false}
                        showDivider={index < candidates.length - 1}
                    />
                ))}
                {candidates.length === 0 ? (
                    <Item
                        title={t('newSession.failedToStart')}
                        mode="info"
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>
            {error ? (
                <Text accessibilityLiveRegion="polite" style={{ marginHorizontal: 24, marginTop: 12 }}>
                    {t('newSession.failedToStart')}
                </Text>
            ) : null}
        </ScrollView>
    );
}
