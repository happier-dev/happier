import * as React from 'react';
import {
    useReportSessionInfoSectionSummary,
    useSessionInfoSectionSummarySessionId,
} from '@/components/sessions/info/sessionInfoSectionSummaries';
import { useProjectAccountRows } from '@/sync/domains/workspaces/projectAccountRows';
import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import {
    disableWorkspaceSyncRelationshipAction,
    enableWorkspaceSyncRelationshipAction,
    flushWorkspaceSyncRelationshipAction,
    terminateWorkspaceSyncRelationship,
} from '@/sync/ops/actions/workspaceSyncRelationshipActions';
import {
    presentWorkspaceSyncFailure,
    formatWorkspaceSyncRelationshipTitle,
    resolveWorkspaceSyncModeTranslationKey,
} from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import {
    resolveWorkspaceSyncStatusScope,
    resolveWorkspaceSyncSummaryStateLabel,
    useWorkspaceSyncRelationshipSummaries,
} from '@/sync/domains/sessionHandoff/useWorkspaceSyncRelationshipSummaries';
import {
    getWorkspaceSyncStatusSnapshot,
    refreshWorkspaceSyncStatus,
    setWorkspaceSyncStatus,
    setWorkspaceSyncStatusError,
} from '@/sync/domains/sessionHandoff/workspaceSyncStatusStore';
import type { WorkspaceSyncRelationshipSummary } from '@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { Modal } from '@/modal';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { openWorkspaceSyncRelationshipDetails } from './openWorkspaceSyncRelationshipDetails';
import { presentWorkspaceSyncStatusLine, WorkspaceSyncStatusLine } from './WorkspaceSyncStatusLine';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

export type WorkspaceSyncRelationshipListProps = Readonly<{
    /** The section heading; "Workspace sync" unless the host names this list by what it answers (Project availability). */
    title?: string;
    serverId?: string;
    workspaceRefId?: string | null;
    onAddMachine?: () => void;
    onOpenDetails?: (summary: WorkspaceSyncRelationshipSummary) => void;
    onOpenConflicts?: (summary: WorkspaceSyncRelationshipSummary) => void;
}>;

export const WorkspaceSyncRelationshipRow = React.memo(function WorkspaceSyncRelationshipRow(props: Readonly<{
    summary: WorkspaceSyncRelationshipSummary;
    localWorkspaceRefId?: string | null;
    /** This computer's machine id, so a row can offer to reveal only its own endpoint. */
    localMachineId?: string | null;
    onOpenDetails?: (summary: WorkspaceSyncRelationshipSummary) => void;
    onOpenConflicts?: (summary: WorkspaceSyncRelationshipSummary) => void;
}>) {
    const router = useRouter();
    const scope = resolveWorkspaceSyncStatusScope(props.summary);
    const actionInput = React.useMemo(() => ({
        controllerMachineId: scope.controllerMachineId,
        relationshipId: scope.relationshipId,
    }), [scope.controllerMachineId, scope.relationshipId]);
    const actionExecution = useMountedActionExecution(scope.serverId);
    const status = props.summary.status;
    const modeKey = resolveWorkspaceSyncModeTranslationKey(props.summary.relationship.mode);
    const stateKey = resolveWorkspaceSyncSummaryStateLabel(props.summary);
    const [pendingAction, setPendingAction] = React.useState<'sync' | 'disable' | 'enable' | 'terminate' | null>(null);
    const [menuOpen, setMenuOpen] = React.useState(false);
    // Revealing a folder is a local OS action: only an endpoint rooted on the computer
    // running this desktop shell has a path this host can open. The list owns the one
    // daemon-status subscription; a row must not start one per relationship.
    const localDaemonMachineId = props.localMachineId ?? null;
    const revealableEndpoint = React.useCallback((endpoint: WorkspaceSyncRelationshipSummary['alpha']): string | null => {
        if (!isDesktopHost() || !localDaemonMachineId) return null;
        const ref = endpoint.workspaceRef;
        if (!ref || ref.machineId !== localDaemonMachineId) return null;
        return ref.rootPath?.trim() || null;
    }, [localDaemonMachineId]);

    const runAction = React.useCallback(async (action: 'sync' | 'disable' | 'enable' | 'terminate') => {
        setPendingAction(action);
        setMenuOpen(false);
        const settled = <T extends Readonly<{ ok: boolean }>>(result: T): Extract<T, { ok: true }> => {
            if (result.ok) return result as Extract<T, { ok: true }>;
            const failure = result as unknown as Readonly<{ errorCode?: string; error?: string }>;
            throw Object.assign(new Error(failure.error), { code: failure.errorCode });
        };
        try {
            if (action === 'sync') {
                const result = settled(await flushWorkspaceSyncRelationshipAction(actionInput, null, actionExecution.execute));
                if ('status' in result) setWorkspaceSyncStatus(scope, result.status);
                return;
            }
            if (action === 'terminate') {
                settled(await terminateWorkspaceSyncRelationship(actionInput, null, actionExecution.execute));
                return;
            }
            if (action === 'disable') {
                settled(await disableWorkspaceSyncRelationshipAction(actionInput, null, actionExecution.execute));
            } else {
                settled(await enableWorkspaceSyncRelationshipAction(actionInput, null, actionExecution.execute));
            }
        } catch (caught) {
            // A Stop removes the relationship before it settles, so the list can drop this row and retire its
            // mounted Action interest mid-flight; that cancelled settle is not a failed Action.
            if (!actionExecution.isCurrent()) return;
            setWorkspaceSyncStatusError(scope, caught);
            Modal.alert(t('common.error'), presentWorkspaceSyncFailure(caught) ?? t('errors.operationFailed'));
        } finally {
            setPendingAction(null);
        }
    }, [actionExecution.execute, actionExecution.isCurrent, actionInput, scope]);

    // Both folders can live on one machine; the machine alone would then name each action identically.
    const sameMachine = (props.summary.alpha.machineName ?? props.summary.alpha.name) === (props.summary.beta.machineName ?? props.summary.beta.name);
    const endpointLabel = React.useCallback((endpoint: typeof props.summary.alpha) => {
        const machine = endpoint.machineName ?? endpoint.name;
        return sameMachine ? `${machine} · ${endpoint.name}` : machine;
    }, [sameMachine]);

    const actionItems = React.useMemo<readonly DropdownMenuItem[]>(() => {
        const toggleAction = !props.summary.relationship.enabled
            ? {
                id: 'enable',
                title: t('workspaceSync.actions.resume'),
                icon: undefined,
            }
            : { id: 'disable', title: t('workspaceSync.actions.pause'), icon: undefined };
        // The routine actions form one group; stopping the link is set apart below them in the danger tone.
        const routine: DropdownMenuItem[] = [
            ...(!props.summary.relationship.enabled
                ? []
                : [{ id: 'sync', title: t('workspaceSync.actions.syncNow') }]),
            toggleAction,
            ...(props.summary.alpha.workspaceRef && props.summary.beta.workspaceRef
                ? [{ id: 'replace', title: t('workspaceSync.replace.action') }] : []),
            ...(props.summary.alpha.workspaceRef ? [{ id: 'open-alpha', title: t('workspaceSync.actions.openOnMachine', { machine: endpointLabel(props.summary.alpha) }) }] : []),
            ...(props.summary.beta.workspaceRef ? [{ id: 'open-beta', title: t('workspaceSync.actions.openOnMachine', { machine: endpointLabel(props.summary.beta) }) }] : []),
            ...(revealableEndpoint(props.summary.alpha) ? [{ id: 'reveal-alpha', title: t('workspaceSync.actions.openFolder', { label: endpointLabel(props.summary.alpha) }) }] : []),
            ...(revealableEndpoint(props.summary.beta) ? [{ id: 'reveal-beta', title: t('workspaceSync.actions.openFolder', { label: endpointLabel(props.summary.beta) }) }] : []),
        ];
        return [
            ...routine.map((item) => ({ ...item, category: 'link' })),
            { id: 'terminate', title: t('workspaceSync.actions.terminate'), destructive: true, category: 'stop' },
        ];
    }, [endpointLabel, props.summary.alpha, props.summary.beta, props.summary.relationship.enabled, revealableEndpoint]);

    const handleActionSelect = React.useCallback((action: string) => {
        if (action === 'replace') {
            setMenuOpen(false);
            void import('./openWorkspaceSyncAddMachine').then(({ openWorkspaceSyncReplaceRelationship }) => {
                openWorkspaceSyncReplaceRelationship(props.summary, props.onOpenDetails ?? (summary => openWorkspaceSyncRelationshipDetails(summary, props.localWorkspaceRefId)));
            });
            return;
        }
        if (action === 'open-alpha' || action === 'open-beta') {
            const endpoint = action === 'open-alpha' ? props.summary.alpha : props.summary.beta;
            setMenuOpen(false);
            router.push(resolveProjectRoutePathForSurface({
                workspaceRefId: endpoint.workspaceRefId,
                surface: 'browse',
            }) as Href);
            return;
        }
        if (action === 'reveal-alpha' || action === 'reveal-beta') {
            const path = revealableEndpoint(action === 'reveal-alpha' ? props.summary.alpha : props.summary.beta);
            setMenuOpen(false);
            if (path) return actionExecution.execute('relay.runtime.open_path', { path });
            return;
        }
        if (action === 'sync' || action === 'disable' || action === 'enable' || action === 'terminate') {
            void runAction(action);
        }
    }, [actionExecution.execute, props.summary, props.onOpenDetails, props.localWorkspaceRefId, revealableEndpoint, router, runAction]);

    // One unbreakable unit: a wrapped subtitle moves the whole "Last checked <time>" to the next
    // line instead of stranding "Last checked" or "PM" alone.
    const lastCheckedLabel = status?.lastCycleObservedAtMs == null
        ? null
        : t('workspaceSync.lastChecked', {
            at: formatWithCachedDateTimeFormatter(status.lastCycleObservedAtMs, undefined, { dateStyle: 'medium', timeStyle: 'short' }),
        }).replace(/\s/g, '\u00A0');
    // Two folders on one machine: the title already tells them apart, so the machine is named once.
    const alphaMachineId = props.summary.alpha.workspaceRef?.machineId;
    const bothOnOneMachine = alphaMachineId !== undefined && alphaMachineId === props.summary.beta.workspaceRef?.machineId;
    const machineDirectionLabel = props.summary.alpha.machineName || props.summary.beta.machineName
        ? bothOnOneMachine
            ? props.summary.alpha.machineName ?? props.summary.alpha.name
            : formatWorkspaceSyncRelationshipTitle({
                alphaLabel: props.summary.alpha.machineName ?? props.summary.alpha.name,
                betaLabel: props.summary.beta.machineName ?? props.summary.beta.name,
                mode: props.summary.relationship.mode,
            })
        : null;

    const openDetails = React.useCallback(() => {
        if (props.onOpenDetails) {
            props.onOpenDetails(props.summary);
            return;
        }
        openWorkspaceSyncRelationshipDetails(props.summary, props.localWorkspaceRefId);
    }, [props.localWorkspaceRefId, props.onOpenDetails, props.summary]);
    const openConflicts = React.useCallback(() => {
        if (props.onOpenConflicts) {
            props.onOpenConflicts(props.summary);
            return;
        }
        openDetails();
    }, [openDetails, props.onOpenConflicts, props.summary]);
    const retryStatus = React.useCallback(() => {
        void refreshWorkspaceSyncStatus(scope).catch(() => undefined);
    }, [scope]);
    const statusLine = presentWorkspaceSyncStatusLine({
        stateKey,
        status,
        readError: getWorkspaceSyncStatusSnapshot(scope).error,
        pending: pendingAction !== null,
        lastCheckedLabel,
    });
    // Plan 02 §5.2: the machines lead; the folders and the mode are the secondary line, the state its own line.
    const folderTitle = formatWorkspaceSyncRelationshipTitle({
        alphaLabel: props.summary.alpha.name,
        betaLabel: props.summary.beta.name,
        mode: props.summary.relationship.mode,
    });
    const metaLine = [
        machineDirectionLabel ? folderTitle : null,
        modeKey ? t(modeKey) : t('workspaceSync.unknownMode'),
    ].filter(Boolean).join(' · ');

    return (
        <Item
            testID={`workspace-sync-relationship-${props.summary.relationshipId}`}
            title={machineDirectionLabel ?? folderTitle}
            subtitle={metaLine}
            // The status line can end with its own link (Review, Retry), so it sits outside the row's press.
            bottomElement={(
                <WorkspaceSyncStatusLine
                    testID={`workspace-sync-relationship-${props.summary.relationshipId}-status`}
                    model={statusLine}
                    onReview={openConflicts}
                    onRetry={retryStatus}
                />
            )}
            bottomElementInset="text"
            bottomElementOutsidePressable
            onPress={openDetails}
            showChevron={true}
            rightElementOutsidePressable={true}
            rightElement={(
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <DropdownMenu
                        open={menuOpen}
                        onOpenChange={setMenuOpen}
                        items={actionItems}
                        onSelect={handleActionSelect}
                        search={false}
                        separateCategories
                        variant="default"
                        rowKind="item"
                        matchTriggerWidth={false}
                        placement="bottom"
                        popoverAnchorAlign="end"
                        trigger={({ toggle }) => (
                            <IconButton
                                testID={`workspace-sync-relationship-${props.summary.relationshipId}-actions`}
                                iconName="dots-three"
                                accessibilityLabel={t('workspaceSync.actions.more')}
                                tooltip={t('workspaceSync.actions.more')}
                                variant="plain"
                                disabled={pendingAction !== null}
                                onPress={toggle}
                            />
                        )}
                    />
                </View>
            )}
        />
    );
});

export const WorkspaceSyncRelationshipList = React.memo(function WorkspaceSyncRelationshipList(
    props: WorkspaceSyncRelationshipListProps,
) {
    const summaries = useWorkspaceSyncRelationshipSummaries(props.workspaceRefId, props.serverId);
    const localMachineId = useLocalDaemonControl().status?.machineId ?? null;
    // Hosted by Session Info, the list tells it whether this folder is known to sync nowhere yet, from the
    // Account rows it already reads; no folder means no answer.
    const infoSessionId = useSessionInfoSectionSummarySessionId();
    const rowsScope = useProjectAccountRows((current) => current?.scope ?? null);
    const rowsStatus = useProjectAccountRows((current) => current?.status ?? null);
    const rowsCoverage = useProjectAccountRows((current) => current?.coverage ?? null);
    useReportSessionInfoSectionSummary('anotherMachine', infoSessionId && rowsScope && rowsStatus && props.workspaceRefId ? {
        scope: rowsScope,
        sessionId: infoSessionId,
        status: rowsStatus === 'ready' ? 'ready' : rowsStatus === 'error' ? 'error'
            : rowsStatus === 'locked' || rowsStatus === 'refused' ? 'denied' : 'loading',
        coverage: rowsCoverage === 'complete' ? 'complete' : 'partial',
        count: summaries.length,
    } : null);
    return (
        <ItemGroup
            title={props.title ?? t('workspaceSync.title')}
            description={t(summaries.length === 0 ? 'workspaceSync.emptyDescription' : 'workspaceSync.footer')}
        >
            {summaries.length === 0 ? (
                // The action is the empty state; a host that cannot offer it keeps one quiet line.
                props.onAddMachine ? null : <Item testID="workspace-sync-none" title={t('workspaceSync.none')} mode="info" />
            ) : summaries.map((summary) => (
                <WorkspaceSyncRelationshipRow
                    key={summary.relationshipId}
                    summary={summary}
                    localWorkspaceRefId={props.workspaceRefId}
                    localMachineId={localMachineId}
                    onOpenDetails={props.onOpenDetails}
                    onOpenConflicts={props.onOpenConflicts}
                />
            ))}
            {props.onAddMachine ? (
                <Item
                    testID="workspace-sync-add-machine"
                    title={t('settings.addMachine')}
                    onPress={props.onAddMachine}
                    showChevron={true}
                />
            ) : null}
        </ItemGroup>
    );
});
