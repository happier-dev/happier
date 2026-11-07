import * as React from 'react';
import { Platform, Pressable, useWindowDimensions, View } from 'react-native';
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
import { isNewSessionDraftDeletionBlocked, resolveRunnerDraftActivation } from '@/components/sessions/drafts/newSessionDraftDeletion';
export { isNewSessionDraftDeletionBlocked } from '@/components/sessions/drafts/newSessionDraftDeletion';
import { readAllActionOperations, useAllActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import {
    useActiveServerAccountScope,
    useMachineListStatusByServerId,
} from '@/sync/domains/state/storage';
import {
    ensureSessionDraftRepositoryHydratedWithScopedRuntime,
    isNewSessionDraftListed,
    listNewSessionDraftProjections,
    subscribeSessionDraftList,
    type NewSessionDraftProjection,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { restoreFocusToBestTarget, type FocusReturnTarget, useFocusReturnFallbackRef } from '@/keyboard/focusReturn';
import { useMachinePresenceMembership } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import type { SessionRowDensity } from '@/components/sessions/shell/row/resolveSessionRowPresentation';
import {
    resolveSessionListRowIdentityMetrics,
    resolveSessionListRowStatusTextMetrics,
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
import { resolveSessionListGroupRowGeometry, SessionListGroup, SessionListGroupMoreRow } from './SessionListGroup';
import { runWithSessionDraftRepositoryScopedRuntime } from '@/sync/ops/sessionDrafts/runWithSessionDraftRepositoryScopedRuntime';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { deleteNewSessionDraft } from '@/components/sessions/drafts/deleteNewSessionDraft';
export { buildNewSessionDraftContinueRoute } from '@/components/sessions/drafts/newSessionDraftNavigation';

export { buildNewSessionDraftRowPresentation } from '@/components/sessions/drafts/newSessionDraftPresentation';

const EMPTY_DRAFTS: readonly NewSessionDraftProjection[] = Object.freeze([]);
type FocusableDraftTarget = React.ComponentRef<typeof Pressable>;

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
    // Memoized rows still follow the canonical ready UI locale.
    usePreferredLanguage();
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
    const { itemDensity, densityViewState, readableNativePhoneMinimal, titleTextMetrics } = resolveSessionListGroupRowGeometry(
        props.density, { isTablet, windowWidth },
    );
    const identityMetrics = resolveSessionListRowIdentityMetrics({
        density: props.density,
        readableNativePhoneMinimal,
    });
    const agentId = resolveNewSessionDraftAgentId(props.draft);
    const machineId = resolveNewSessionDraftMachineId(props.draft);
    const subtitleTextMetrics = resolveSessionListRowStatusTextMetrics(props.density);
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

/** How many drafts a long drafts group lists before its "Show all" row. */
const DRAFTS_GROUP_PREVIEW_COUNT = 3;

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
    const [showAll, setShowAll] = React.useState(false);
    if (props.drafts.length === 0) return null;
    const sectionTitle = props.sectionTitle ?? t('sessionDrafts.sectionTitle');
    // A long drafts group lists its newest few under the true count, then one row reveals the rest
    // in place: the group never pushes the sessions below it off the screen (lab xrail P1).
    const visibleDrafts = showAll || props.drafts.length <= DRAFTS_GROUP_PREVIEW_COUNT
        ? props.drafts
        : props.drafts.slice(0, DRAFTS_GROUP_PREVIEW_COUNT);
    const hiddenCount = props.drafts.length - visibleDrafts.length;
    return (
        // The drafts group reads like a project group: a sentence-case label, a quiet count, one sheet.
        <SessionListGroup
            testID={props.sectionTestID ?? 'session-drafts-section'}
            headerTestID="session-drafts-header"
            countTestID="session-drafts-header-count"
            title={sectionTitle}
            count={props.drafts.length}
            selectableItemCountOverride={props.drafts.length}
        >
                {visibleDrafts.map((draft) => (
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
                {hiddenCount > 0 ? (
                    <SessionListGroupMoreRow
                        testID="session-drafts-show-all"
                        title={t('sessionDrafts.showAll', { count: props.drafts.length })}
                        density={props.density ?? 'default'}
                        onPress={() => setShowAll(true)}
                    />
                ) : null}
        </SessionListGroup>
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
    const action = useMountedActionExecution(props.scope);
    const machineMembership = useMachinePresenceMembership(props.scope.serverId);
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
    const pluginInputs = useAppShellPluginUiProjection(value => drafts.length === 0 ? null : {
        phase: value.phase,
        attachments: value.pluginUiProjection?.composerAttachmentsById,
    });
    const installedIds = useAppShellPluginUiProjection(value => drafts.length === 0 ? []
        : Object.keys(value.pluginUiProjection?.installedPackagesById ?? {}).sort());
    const serverProfilesGeneration = useServerProfilesGeneration();
    const deleteDisabledDraftIds = React.useMemo(() => new Set(drafts.flatMap((draft) => (
            isNewSessionDraftDeletionBlocked({
                draft,
                accountId: props.scope.accountId,
                operations: actionOperations,
            }) ? [draft.draftId] : []
    ))), [actionOperations, drafts, props.scope.accountId]);
    const onlineMachineIds = React.useMemo(() => new Set(machineMembership.selectableMachineIds), [machineMembership.selectableMachineIds]);
    const availabilityByDraftId = React.useMemo(() => {
        const attachments = pluginInputs?.phase === 'current' ? pluginInputs.attachments : undefined;
        const installedPluginIds = new Set(installedIds);
        return Object.fromEntries(drafts.map((draft) => {
            const machineId = resolveNewSessionDraftMachineId(draft);
            const attachmentSummary = attachments && draft.readView
                ? summarizeComposerAttachmentDraftAvailability({
                    values: draft.readView.composer.attachments.value,
                    catalog: { entriesById: attachments },
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
        pluginInputs,
        installedIds,
        props.scope.serverId,
    ]);
    const handleContinue = React.useCallback((draftId: string, scope?: ServerAccountScope) => {
        if (!scope || scope.serverId !== props.scope.serverId || scope.accountId !== props.scope.accountId) return;
        fireAndForget(action.execute('session.draft.open', { draftId }), { tag: 'NewSessionDraftsSection.open' });
    }, [action.execute, props.scope]);
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
    const handleDelete = React.useCallback(async (draftId: string, scope?: ServerAccountScope) => {
        if (!scope || scope.serverId !== props.scope.serverId || scope.accountId !== props.scope.accountId) {
            return false;
        }
        // The Action owner rechecks launch custody after its configurable review,
        // then the canonical tombstone closes any pending Runner activation.
        return deleteNewSessionDraft({ execute: action.execute, draftId, isCurrent: action.isCurrent });
    }, [action.execute, action.isCurrent, props.scope]);

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
