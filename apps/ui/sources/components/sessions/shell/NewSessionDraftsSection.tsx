import * as React from 'react';
import { Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    buildNewSessionDraftRowPresentation,
    resolveNewSessionDraftAgentId,
    resolveNewSessionDraftMachineId,
    type NewSessionDraftAvailabilitySummary,
} from '@/components/sessions/drafts/newSessionDraftPresentation';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { summarizeComposerAttachmentDraftAvailability } from '@/components/sessions/composer/composerScopeAdapters';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { isNewSessionDraftDeletionBlocked, resolveRunnerDraftActivation } from '@/components/sessions/drafts/newSessionDraftDeletion';
export { isNewSessionDraftDeletionBlocked } from '@/components/sessions/drafts/newSessionDraftDeletion';
import { readAllActionOperations, useAllActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import {
    useActiveServerAccountScope,
    useLaunchSelectionMachines,
    useMachineListStatusByServerId,
} from '@/sync/domains/state/storage';
import {
    deleteSessionDraftWithScopedRuntime,
    deleteSessionDraft,
    ensureSessionDraftRepositoryHydratedWithScopedRuntime,
    isNewSessionDraftListed,
    listNewSessionDraftProjections,
    subscribeSessionDraftList,
    type NewSessionDraftProjection,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { restoreFocusToBestTarget, type FocusReturnTarget, useFocusReturnFallbackRef } from '@/keyboard/focusReturn';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import type { SessionRowDensity } from '@/components/sessions/shell/row/resolveSessionRowPresentation';
import {
    SESSION_LIST_ROW_CORNER_RADIUS,
    resolveSessionListDensityViewState,
    resolveSessionListRowIdentityMetrics,
    resolveSessionListRowTitleTextMetrics,
    SESSION_LIST_ROW_STATUS_TEXT_METRICS,
} from '@/components/sessions/shell/resolveSessionListDensityViewState';
import { useIsTablet } from '@/utils/platform/responsive';
import { useTemporaryComputerLaunchObservation, type TemporaryComputerLaunchStatus } from '@/components/sessions/new/hooks/useTemporaryComputerLaunch';
import { createRunnerActivationClient, type RunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { createServerRequestForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileById,
    listServerProfiles,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import {
    useServerCredentialAccountScopeBindings,
    type ServerCredentialAccountScopeBinding,
} from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { homeDisplayName } from '@/components/settings/home/governance/homeGovernanceLabels';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionListViewContext } from './search/sessionListViewFilters';
import { sessionListStyles } from './sessionListStyles';
import { deleteNewSessionDraftAfterConfirmation } from '@/components/sessions/drafts/deleteNewSessionDraftAfterConfirmation';
import { runWithSessionDraftRepositoryScopedRuntime } from '@/sync/ops/sessionDrafts/runWithSessionDraftRepositoryScopedRuntime';

export { buildNewSessionDraftRowPresentation } from '@/components/sessions/drafts/newSessionDraftPresentation';
export { deleteNewSessionDraftAfterConfirmation } from '@/components/sessions/drafts/deleteNewSessionDraftAfterConfirmation';

const EMPTY_DRAFTS: readonly NewSessionDraftProjection[] = Object.freeze([]);
type FocusableDraftTarget = React.ComponentRef<typeof Pressable>;

export function buildNewSessionDraftContinueRoute(
    draftId: string,
    scope: ServerAccountScope,
): Readonly<{
    pathname: '/new';
    params: Readonly<{
        draftId: string;
        spawnServerId: string;
        draftServerId: string;
        draftAccountId: string;
    }>;
}> {
    return {
        pathname: '/new',
        params: {
            draftId,
            spawnServerId: scope.serverId,
            draftServerId: scope.serverId,
            draftAccountId: scope.accountId,
        },
    };
}

export function resolveNewSessionDraftSectionTitle(input: Readonly<{
    serverId: string | null;
    homeName: string | null;
    viewContext: SessionListViewContext;
}>): string {
    if (
        !input.serverId
        || input.viewContext.kind !== 'team'
        || input.viewContext.team.serverId === input.serverId
    ) return t('sessionDrafts.sectionTitle');
    const home = input.homeName?.trim() || input.serverId;
    return t('sessionDrafts.sectionTitleForHome', { home });
}

export function resolveNewSessionDraftWaitingSectionTitle(input: Readonly<{
    serverId: string;
    homeName: string | null;
}>): string {
    const home = input.homeName?.trim() || input.serverId;
    return t('sessionDrafts.waitingSectionTitleForHome', { home });
}


function runnerDraftStatusKey(status: TemporaryComputerLaunchStatus): Parameters<typeof t>[0] | null {
    if (status === 'idle') return null;
    return `newSession.temporaryComputer.status.${status}` as Parameters<typeof t>[0];
}


export function resolveNewSessionDraftMachineUnavailable(input: Readonly<{
    machineId: unknown;
    inventoryCurrent: boolean;
    onlineMachineIds: ReadonlySet<string>;
}>): boolean {
    const machineId = typeof input.machineId === 'string' ? input.machineId.trim() : '';
    return input.inventoryCurrent
        && machineId.length > 0
        && !input.onlineMachineIds.has(machineId);
}

const stylesheet = StyleSheet.create(() => ({
    // The next group's label brings its own top padding (`SESSION_LIST_COLUMN_METRICS`).
    section: { width: '100%' },
    group: { borderRadius: SESSION_LIST_ROW_CORNER_RADIUS },
    headerTitleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
    actionSlot: { width: 24, alignItems: 'flex-end' },
    // Web shows the delete on row hover or keyboard focus only; it stays in the tab order.
    actionSlotHidden: { opacity: 0 },
    actionSlotShown: { opacity: 1 },
    deleteButton: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
    deleteIcon: {
        // RN Web gives a custom component child a 17px inline box. Move the 14px glyph itself,
        // leaving the button's geometry and native centering untouched.
        transform: Platform.select({ web: [{ translateY: 1.5 }], default: [] }),
    },
    deleteButtonDisabled: { opacity: 0.4 },
}));

const NewSessionDraftRow = React.memo(function NewSessionDraftRow(props: Readonly<{
    draft: NewSessionDraftProjection;
    machineUnavailable: boolean;
    pluginUnavailable: boolean;
    attachmentNeedsAttention: boolean;
    onContinue: (draftId: string, scope?: ServerAccountScope) => void;
    onDelete: (draftId: string, scope?: ServerAccountScope) => Promise<boolean>;
    registerRowTarget: (draftId: string, target: FocusableDraftTarget | null) => void;
    deleteDisabled: boolean;
    density: SessionRowDensity;
    serverId: string | null;
    runnerActivationClient: RunnerActivationClient | null;
    rowScope?: ServerAccountScope;
}>) {
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const { width: windowWidth } = useWindowDimensions();
    const isWeb = Platform.OS === 'web';
    const [rowHovered, setRowHovered] = React.useState(false);
    const [deleteHovered, setDeleteHovered] = React.useState(false);
    const [deletePressed, setDeletePressed] = React.useState(false);
    const [deleteFocused, setDeleteFocused] = React.useState(false);
    // The one draft action stays on the row, but quiet: secondary ink at rest, danger only while
    // the pointer or a press is on it (the confirmation carries the weight). Touch always shows it;
    // web shows it on row hover or keyboard focus.
    const deleteShown = !isWeb || rowHovered || deleteHovered || deleteFocused;
    const deleteGlyphColor = !props.deleteDisabled && (deleteHovered || deletePressed)
        ? theme.colors.state.danger.foreground
        : theme.colors.text.secondary;
    const presentation = buildNewSessionDraftRowPresentation(props.draft, {
        machineUnavailable: props.machineUnavailable,
        pluginUnavailable: props.pluginUnavailable,
        attachmentNeedsAttention: props.attachmentNeedsAttention,
    });
    // Schema parsing returns a fresh public-reference object. Preserve it for
    // the draft revision so the observer effect does not refetch on each state
    // projection and create a render/request loop.
    const runnerActivation = React.useMemo(
        () => resolveRunnerDraftActivation(props.draft),
        [props.draft],
    );
    const runnerLaunch = useTemporaryComputerLaunchObservation({
        client: runnerActivation.isTemporaryComputer ? props.runnerActivationClient : null,
        // The wake that keeps this row truthful is published by the exact Home
        // that owns the activation — the same Home the transport above targets.
        serverId: props.serverId,
        draftId: props.draft.draftId,
        existingPublicRef: runnerActivation.publicRef,
    });
    const draftId = props.draft.draftId;
    const pressableRef = React.useCallback((target: FocusableDraftTarget | null) => {
        props.registerRowTarget(draftId, target);
    }, [draftId, props.registerRowTarget]);
    const activationStatusKey = runnerDraftStatusKey(runnerLaunch.status);
    const statusKey = props.draft.status === 'conflict'
        ? presentation.statusKey
        : activationStatusKey ?? presentation.statusKey;
    const status = statusKey ? t(statusKey) : null;
    const minimal = props.density === 'minimal';
    const itemDensity = props.density === 'default'
        ? 'comfortable'
        : props.density === 'minimal'
            ? 'tight'
            : 'compact';
    const densityViewState = resolveSessionListDensityViewState(
        props.density === 'minimal' ? 'narrow' : props.density === 'compact' ? 'cozy' : 'comfortable',
        { isTablet, platform: Platform.OS, windowWidth },
    );
    const readableNativePhoneMinimal = props.density === 'minimal'
        && densityViewState.rowHeight !== resolveSessionListDensityViewState('narrow').rowHeight;
    const titleTextMetrics = resolveSessionListRowTitleTextMetrics({
        density: props.density,
        readableNativePhoneMinimal,
    });
    const identityMetrics = resolveSessionListRowIdentityMetrics({
        density: props.density,
        readableNativePhoneMinimal,
    });
    const agentId = resolveNewSessionDraftAgentId(props.draft);
    const machineId = resolveNewSessionDraftMachineId(props.draft);
    const subtitleTextMetrics = SESSION_LIST_ROW_STATUS_TEXT_METRICS[props.density];
    const accessibleSummary = [
        presentation.title, status, t('sessionDrafts.continueEditing'),
    ].filter(Boolean).join(', ');
    return (
        <Item
            testID={`session-draft-row:new-session:${draftId}`}
            onHoverIn={isWeb ? () => setRowHovered(true) : undefined}
            onHoverOut={isWeb ? () => setRowHovered(false) : undefined}
            title={presentation.title}
            subtitle={!minimal ? (status || undefined) : undefined}
            subtitleTestID={!minimal && status ? `session-draft-status:new-session:${draftId}` : undefined}
            titleLines={minimal ? 1 : 2}
            subtitleLines={1}
            density={itemDensity}
            style={{
                height: densityViewState.rowHeight,
                minHeight: densityViewState.rowHeight,
                paddingVertical: 0,
            }}
            titleStyle={titleTextMetrics}
            subtitleStyle={subtitleTextMetrics}
            leftElement={minimal ? (
                <SessionAgentCatalogIdentityIcon
                    agentId={agentId}
                    machineId={machineId}
                    serverId={props.serverId}
                    size={identityMetrics.agentLogoSize}
                    color={theme.colors.text.primary}
                    testID={`session-draft-agent-logo:new-session:${draftId}`}
                />
            ) : undefined}
            iconBoxSize={minimal ? identityMetrics.slotSize : undefined}
            onPress={() => props.rowScope
                ? props.onContinue(draftId, props.rowScope)
                : props.onContinue(draftId)}
            accessibilityRole="button"
            accessibilityLabel={accessibleSummary}
            rightElement={(
                <View
                    testID={`session-draft-action-slot:new-session:${draftId}`}
                    style={[
                        stylesheet.actionSlot,
                        deleteShown ? stylesheet.actionSlotShown : stylesheet.actionSlotHidden,
                    ]}
                >
                    <Pressable
                        testID={`session-draft-delete:new-session:${draftId}`}
                        style={[
                            stylesheet.deleteButton,
                            props.deleteDisabled ? stylesheet.deleteButtonDisabled : null,
                        ]}
                        disabled={props.deleteDisabled}
                        accessibilityRole="button"
                        accessibilityLabel={t('sessionDrafts.delete.action')}
                        accessibilityState={{ disabled: props.deleteDisabled }}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        onHoverIn={() => setDeleteHovered(true)}
                        onHoverOut={() => setDeleteHovered(false)}
                        onPressIn={() => setDeletePressed(true)}
                        onPressOut={() => setDeletePressed(false)}
                        onFocus={() => setDeleteFocused(true)}
                        onBlur={() => setDeleteFocused(false)}
                        onPress={(event) => {
                            event.stopPropagation();
                            fireAndForget(
                                props.rowScope
                                    ? props.onDelete(draftId, props.rowScope)
                                    : props.onDelete(draftId),
                                { tag: 'NewSessionDraftRow.delete' },
                            );
                        }}
                    >
                        <Icon
                            name="trash"
                            size={ICON_SIZE.xs}
                            color={deleteGlyphColor}
                            style={stylesheet.deleteIcon}
                        />
                    </Pressable>
                </View>
            )}
            rightElementOutsidePressable
            pressableRef={pressableRef}
        />
    );
});

export const NewSessionDraftsSectionView = React.memo(function NewSessionDraftsSectionView(props: Readonly<{
    drafts: readonly NewSessionDraftProjection[];
    availabilityByDraftId?: Readonly<Record<string, NewSessionDraftAvailabilitySummary>>;
    onContinue: (draftId: string, scope?: ServerAccountScope) => void;
    onDelete: (draftId: string, scope?: ServerAccountScope) => Promise<boolean>;
    deleteDisabledDraftIds?: ReadonlySet<string>;
    density?: SessionRowDensity;
    serverId?: string | null;
    sectionTitle?: string;
    sectionTestID?: string;
    runnerActivationClient?: RunnerActivationClient | null;
    rowScope?: ServerAccountScope | null;
}>) {
    const rowTargetsRef = React.useRef(new Map<string, FocusableDraftTarget>());
    const listFocusFallbackRef = useFocusReturnFallbackRef<FocusReturnTarget>();
    const [pendingFocusRestore, setPendingFocusRestore] = React.useState<Readonly<{
        deletedDraftId: string;
        candidateDraftIds: readonly string[];
    }> | null>(null);
    const registerRowTarget = React.useCallback((draftId: string, target: FocusableDraftTarget | null) => {
        if (target) rowTargetsRef.current.set(draftId, target);
        else rowTargetsRef.current.delete(draftId);
    }, []);
    // Deletion reads the committed list at invocation time. Editing another
    // draft must not replace every row's delete handler.
    const deletionPropsRef = React.useRef(props);
    React.useLayoutEffect(() => {
        deletionPropsRef.current = props;
    }, [props]);
    const handleDelete = React.useCallback(async (draftId: string) => {
        const current = deletionPropsRef.current;
        const deletedIndex = current.drafts.findIndex((draft) => draft.draftId === draftId);
        const candidateDraftIds = current.drafts
            .map((draft, index) => ({ draftId: draft.draftId, distance: Math.abs(index - deletedIndex), index }))
            .filter((candidate) => candidate.draftId !== draftId)
            .sort((left, right) => left.distance - right.distance || right.index - left.index)
            .map((candidate) => candidate.draftId);
        const deleted = current.rowScope
            ? await current.onDelete(draftId, current.rowScope)
            : await current.onDelete(draftId);
        if (deleted) setPendingFocusRestore({ deletedDraftId: draftId, candidateDraftIds });
        return deleted;
    }, []);
    React.useEffect(() => {
        if (!pendingFocusRestore) return;
        if (props.drafts.some((draft) => draft.draftId === pendingFocusRestore.deletedDraftId)) return;
        const survivingDraftIds = new Set(props.drafts.map((draft) => draft.draftId));
        const nextDraftId = pendingFocusRestore.candidateDraftIds.find((draftId) => survivingDraftIds.has(draftId));
        const target = nextDraftId ? rowTargetsRef.current.get(nextDraftId) : null;
        restoreFocusToBestTarget(
            { current: target ?? null },
            listFocusFallbackRef,
        );
        setPendingFocusRestore(null);
    }, [listFocusFallbackRef, pendingFocusRestore, props.drafts]);
    if (props.drafts.length === 0) return null;
    const sectionTitle = props.sectionTitle ?? t('sessionDrafts.sectionTitle');
    const headerStyles = sessionListStyles;
    return (
        <View testID={props.sectionTestID ?? 'session-drafts-section'} style={stylesheet.section}>
            {/* The drafts group reads like a project group: a sentence-case label and a quiet count. */}
            <View
                testID="session-drafts-header"
                style={headerStyles.groupHeaderSection}
                accessibilityRole="header"
                accessibilityLabel={`${sectionTitle}, ${props.drafts.length}`}
            >
                <View style={stylesheet.headerTitleRow}>
                    <Eyebrow style={headerStyles.groupHeaderTitle} numberOfLines={1}>{sectionTitle}</Eyebrow>
                    <Text testID="session-drafts-header-count" style={headerStyles.groupHeaderCount}>
                        {props.drafts.length}
                    </Text>
                </View>
            </View>
            {/* One sheet, like each project group below it (S1 Grouped). */}
            <ItemGroup
                style={headerStyles.groupSheetUnderLabel}
                containerStyle={[stylesheet.group, headerStyles.groupSheetInset]}
                selectableItemCountOverride={props.drafts.length}
            >
                {props.drafts.map((draft) => (
                    <NewSessionDraftRow
                        key={draft.draftId}
                        draft={draft}
                        machineUnavailable={props.availabilityByDraftId?.[draft.draftId]?.machineUnavailable === true}
                        pluginUnavailable={props.availabilityByDraftId?.[draft.draftId]?.pluginUnavailable === true}
                        attachmentNeedsAttention={props.availabilityByDraftId?.[draft.draftId]?.attachmentNeedsAttention === true}
                        onContinue={props.onContinue}
                        onDelete={handleDelete}
                        registerRowTarget={registerRowTarget}
                        deleteDisabled={props.deleteDisabledDraftIds?.has(draft.draftId) === true}
                        density={props.density ?? 'default'}
                        serverId={props.serverId ?? null}
                        runnerActivationClient={props.runnerActivationClient ?? null}
                        rowScope={props.rowScope ?? undefined}
                    />
                ))}
            </ItemGroup>
        </View>
    );
});

export function useNewSessionDraftProjections(scope: ServerAccountScope | null): readonly NewSessionDraftProjection[] {
    const subscribe = React.useCallback((listener: () => void) => (
        scope ? subscribeSessionDraftList(scope, listener) : () => undefined
    ), [scope]);
    const getSnapshot = React.useCallback(() => (scope ? listNewSessionDraftProjections(scope) : EMPTY_DRAFTS), [scope]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const ServerScopedNewSessionDraftsSection = React.memo(function ServerScopedNewSessionDraftsSection(props: Readonly<{
    scope: ServerAccountScope;
    density?: SessionRowDensity;
    viewContext?: SessionListViewContext;
    temporaryComputerOnly?: boolean;
    inactiveScopeBinding?: ServerCredentialAccountScopeBinding;
}>) {
    const router = useRouter();
    const machines = useLaunchSelectionMachines();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const allDrafts = useNewSessionDraftProjections(props.scope);
    const drafts = React.useMemo(() => (
        props.temporaryComputerOnly
            // An inactive Home contributes recovery rows only after a package
            // activation exists. A merely selected Temporary-computer target is
            // still that Home's ordinary authoring draft.
            ? allDrafts.filter((draft) => resolveRunnerDraftActivation(draft).publicRef !== null)
            // A draft with only resolved configuration (Machine, folder, ...) is
            // not something the user wrote; the draft owner decides which are.
            : allDrafts.filter(isNewSessionDraftListed)
    ), [allDrafts, props.temporaryComputerOnly]);
    const actionOperations = useAllActionOperations();
    const pluginProjection = useAppShellPluginUiProjection();
    const serverProfilesGeneration = useServerProfilesGeneration();
    const deleteDisabledDraftIds = React.useMemo(() => new Set(drafts.flatMap((draft) => (
            isNewSessionDraftDeletionBlocked({
                draft,
                accountId: props.scope.accountId,
                operations: actionOperations,
            }) ? [draft.draftId] : []
    ))), [actionOperations, drafts, props.scope.accountId]);
    const onlineMachineIds = React.useMemo(() => new Set(
        machines.filter((machine) => isMachineOnline(machine)).map((machine) => machine.id),
    ), [machines]);
    const availabilityByDraftId = React.useMemo(() => {
        const currentPluginProjection = pluginProjection.phase === 'current'
            ? pluginProjection.pluginUiProjection
            : null;
        const installedPluginIds = new Set(Object.keys(currentPluginProjection?.installedPackagesById ?? {}));
        return Object.fromEntries(drafts.map((draft) => {
            const machineId = resolveNewSessionDraftMachineId(draft);
            const attachmentSummary = currentPluginProjection
                ? summarizeComposerAttachmentDraftAvailability({
                    values: draft.document.composer.attachments.value,
                    catalog: { entriesById: currentPluginProjection.composerAttachmentsById },
                    installedPluginIds,
                })
                : { pluginUnavailable: false, attachmentNeedsAttention: false };
            return [draft.draftId, {
                machineUnavailable: resolveNewSessionDraftMachineUnavailable({
                    machineId,
                    inventoryCurrent: machineListStatusByServerId[props.scope.serverId] === 'idle',
                    onlineMachineIds,
                }),
                ...attachmentSummary,
            } satisfies NewSessionDraftAvailabilitySummary];
        }));
    }, [
        drafts,
        machineListStatusByServerId,
        onlineMachineIds,
        pluginProjection.phase,
        pluginProjection.pluginUiProjection,
        props.scope.serverId,
    ]);
    const handleContinue = React.useCallback((draftId: string, scope?: ServerAccountScope) => {
        if (!scope) return;
        router.push(buildNewSessionDraftContinueRoute(draftId, scope));
    }, [router]);
    const homeProfile = React.useMemo(
        () => getServerProfileById(props.scope.serverId),
        [props.scope.serverId, serverProfilesGeneration],
    );
    const activeRequest = React.useMemo(() => homeProfile ? createServerFetchAtEndpoint({
        endpointUrl: homeProfile.serverUrl,
        serverId: props.scope.serverId,
    }) : null, [homeProfile, props.scope.serverId]);
    const mountedRef = React.useRef(true);
    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    React.useEffect(() => {
        if (!props.inactiveScopeBinding || !activeRequest) return;
        let active = true;
        fireAndForget(runWithSessionDraftRepositoryScopedRuntime({
            binding: props.inactiveScopeBinding,
            activeRequest,
            operation: ({ scope, runtime, isCurrent }) => ensureSessionDraftRepositoryHydratedWithScopedRuntime({
                scope,
                runtime,
                isCurrent: () => active
                    && mountedRef.current
                    && isCurrent(),
            }),
        }), { tag: 'NewSessionDraftsSection.hydrateInactiveScope' });
        return () => {
            active = false;
        };
    }, [activeRequest, props.inactiveScopeBinding]);
    const sectionTitle = resolveNewSessionDraftSectionTitle({
        serverId: props.scope.serverId,
        homeName: homeDisplayName(props.scope.serverId),
        viewContext: props.viewContext ?? { kind: 'global' },
    });
    const displayedSectionTitle = props.temporaryComputerOnly
        ? resolveNewSessionDraftWaitingSectionTitle({
            serverId: props.scope.serverId,
            homeName: homeDisplayName(props.scope.serverId),
        })
        : sectionTitle;
    const runnerActivationClient = React.useMemo(() => {
        if (!activeRequest) return null;
        return createRunnerActivationClient(createServerRequestForServerAccountScope({
            scope: props.scope,
            activeRequest,
        }));
    }, [activeRequest, props.scope]);
    const handleDelete = React.useCallback((draftId: string, scope?: ServerAccountScope) => {
        if (!scope || scope.serverId !== props.scope.serverId || scope.accountId !== props.scope.accountId) {
            return Promise.resolve(false);
        }
        return deleteNewSessionDraftAfterConfirmation({
            confirm: () => Modal.confirm(
                t('sessionDrafts.delete.confirmTitle'),
                t('sessionDrafts.delete.confirmDescription'),
                { confirmText: t('common.delete'), cancelText: t('common.cancel'), destructive: true },
            ),
            readCurrentDraftDeletionDisposition: () => {
                const currentDraft = listNewSessionDraftProjections(scope)
                    .find((draft) => draft.draftId === draftId);
                if (!currentDraft) return 'missing';
                return isNewSessionDraftDeletionBlocked({
                    draft: currentDraft,
                    accountId: scope.accountId,
                    operations: readAllActionOperations(),
                }) ? 'launch-custody' : 'deletable';
            },
            // The canonical server tombstone atomically closes any pending Runner
            // activation for this draft. A separate cancel call here would create
            // a competing lifecycle and an offline race.
            deleteDraft: () => {
                if (!props.inactiveScopeBinding) {
                    return deleteSessionDraft({ scope, address: { kind: 'newSession', draftId } });
                }
                if (!activeRequest) return Promise.resolve(false);
                return runWithSessionDraftRepositoryScopedRuntime({
                    binding: props.inactiveScopeBinding,
                    activeRequest,
                    operation: ({ runtime, isCurrent }) => deleteSessionDraftWithScopedRuntime({
                        scope,
                        address: { kind: 'newSession', draftId },
                        runtime,
                        isCurrent: () => mountedRef.current && isCurrent(),
                    }),
                }).then((deleted) => deleted === true);
            },
        });
    }, [activeRequest, props.inactiveScopeBinding, props.scope]);

    return (
        <NewSessionDraftsSectionView
            drafts={drafts}
            availabilityByDraftId={availabilityByDraftId}
            onContinue={handleContinue}
            onDelete={handleDelete}
            deleteDisabledDraftIds={deleteDisabledDraftIds}
            density={props.density}
            serverId={props.scope.serverId}
            sectionTitle={displayedSectionTitle}
            sectionTestID={props.temporaryComputerOnly
                ? `session-drafts-waiting-section:${props.scope.serverId}:${props.scope.accountId}`
                : undefined}
            runnerActivationClient={runnerActivationClient}
            rowScope={props.scope}
        />
    );
});

// Waiting drafts stay outside the Session corpus. The focused Home keeps its
// ordinary Drafts section, while authenticated inactive Homes project only
// Temporary-computer drafts from their existing qualified repositories. This
// preserves cross-Home recovery without creating a second draft corpus or
// allowing the active Home to supply another row's Account scope.
export const NewSessionDraftsSection = React.memo(function NewSessionDraftsSection(props: Readonly<{
    density?: SessionRowDensity;
    viewContext?: SessionListViewContext;
}>) {
    const activeScope = useActiveServerAccountScope();
    const serverProfilesGeneration = useServerProfilesGeneration();
    const serverIds = React.useMemo(
        () => [...new Set(listServerProfiles().map(resolveServerProfileScopeId))].sort(),
        [serverProfilesGeneration],
    );
    const credentialBindings = useServerCredentialAccountScopeBindings(serverIds);
    const inactiveBindings = React.useMemo(() => {
        if (!activeScope) return [];
        return [...credentialBindings.values()].flatMap((binding) => (
            binding.isCurrent()
            && !areServerProfileIdentifiersEquivalent(binding.scope.serverId, activeScope.serverId)
                ? [binding]
                : []
        ));
    }, [activeScope, credentialBindings]);
    if (!activeScope) return null;
    return (
        <>
            <ServerScopedNewSessionDraftsSection
                key={serverAccountScopeKeySuffix(activeScope)}
                scope={activeScope}
                density={props.density}
                viewContext={props.viewContext}
            />
            {inactiveBindings.map((binding) => (
                <ServerScopedNewSessionDraftsSection
                    key={serverAccountScopeKeySuffix(binding.scope)}
                    scope={binding.scope}
                    density={props.density}
                    viewContext={props.viewContext}
                    temporaryComputerOnly
                    inactiveScopeBinding={binding}
                />
            ))}
        </>
    );
});
