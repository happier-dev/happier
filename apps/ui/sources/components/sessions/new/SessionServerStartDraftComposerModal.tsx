import * as React from 'react';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';
import { ScrollView, View } from 'react-native';

import type { SessionServerStartSpawnDraftV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { useAllMachines, useMachineListByServerId, useMachineListStatusByServerId, useSettingsSelector } from '@/sync/domains/state/storage';
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
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type {
    SessionServerStartDraftSeed,
    SessionServerStartDraftTarget,
} from './serverStartDraftComposer';
import {
    presentSessionServerStartCandidate,
    resolveSessionServerStartCandidateSelection,
} from './serverStartDraftCandidateSelection';

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
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const activeServer = useActiveServerSnapshot();
    const settings = useSettingsSelector((settings) => ({
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
    }));
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
        machineListStatusByServerId,
    }), [activeServer.serverId, machineListByServerId, machineListStatusByServerId, machines, props.target, selectedPlacementCandidate]);
    const selectedTarget = selectedPlacement.target;
    const { snapshot: acpCatalog } = useAcpCatalogForServer(selectedTarget.serverId);
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
            acpCatalogSnapshot: acpCatalog?.catalog,
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
        acpCatalog,
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
        if (!acpCatalog || acpCatalog.stale || acpCatalog.catalog.status !== 'ready' || daemonMergedProjection.phase !== 'ready') return;
        if (!selectedAgent) {
            setSelectedAgentKey(resolveInitialAgentKey({ candidates, seedAgentId: props.seed.agentId }));
        }
    }, [acpCatalog, candidates, daemonMergedProjection.phase, props.seed.agentId, selectedAgent]);

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
                executionTarget: { kind: 'machine', target: selectedTarget },
                directory: directory.trim(),
                checkoutCreationDraft: null,
                prompt: '',
                displayText: '',
                agentTarget: selectedAgent.agentTarget,
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
                permissionMode,
                configurationUpdatedAtMs: now,
            }));
            props.onClose();
        } catch {
            setError(true);
        }
    }, [canSubmit, directory, props, selectedAgent, selectedTarget]);
    const footer = React.useMemo(() => (
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
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
                {props.seed.candidates?.map((candidate, index) => {
                    const presentation = presentSessionServerStartCandidate({
                        candidate,
                        activeServerId: String(activeServer.serverId ?? ''),
                        activeMachines: machines,
                        machineListByServerId,
                        machineListStatusByServerId,
                    });
                    return <Item
                        key={'id' in candidate.projectKey
                            ? candidate.projectKey.id
                            : `${candidate.serverId}:${candidate.machineId}:${candidate.rootPath}`}
                        title={presentation.title}
                        subtitle={presentation.subtitle}
                        selected={index === selectedCandidateIndex}
                        onPress={() => {
                            setError(false);
                            setSelectedCandidateIndex(index);
                            setDirectory(candidate.rootPath);
                        }}
                        showChevron={false}
                        showDivider={true}
                    />;
                })}
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
                {daemonMergedProjection.phase === 'idle' || daemonMergedProjection.phase === 'loading' ? (
                    <ItemLoadStateRows state={{ kind: 'loading' }} rows={2} lines={1} accessibilityLabel={t('common.loading')} />
                ) : daemonMergedProjection.phase !== 'ready' ? (
                    // The machine answered that it cannot list its agents (`unsupported`), or it did not answer.
                    <ItemLoadStateRows state={{
                        kind: 'failed',
                        reason: daemonMergedProjection.phase === 'unsupported'
                            ? t('newSession.actionMethodUnavailable')
                            : t('errors.daemonUnavailableBody'),
                    }} />
                ) : candidates.length === 0 ? (
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
