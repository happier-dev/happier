import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    buildNewSessionDraftRowPresentation,
    resolveNewSessionDraftAgentId,
    type NewSessionDraftAvailabilitySummary,
} from '@/components/sessions/drafts/newSessionDraftPresentation';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/catalog/catalog';
import { summarizeComposerAttachmentDraftAvailability } from '@/components/sessions/composer/composerScopeAdapters';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { isNewSessionDraftLaunchInCustody } from '@/components/sessions/new/modules/newSessionDraftLaunchCustody';
import { readAllActionOperations, useAllActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import {
    useActiveServerAccountScope,
    useLaunchSelectionMachines,
    useMachineListStatusByServerId,
} from '@/sync/domains/state/storage';
import {
    deleteSessionDraft,
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

export { buildNewSessionDraftRowPresentation } from '@/components/sessions/drafts/newSessionDraftPresentation';

const EMPTY_DRAFTS: readonly NewSessionDraftProjection[] = Object.freeze([]);
type FocusableDraftTarget = React.ComponentRef<typeof Pressable>;

export async function deleteNewSessionDraftAfterConfirmation(params: Readonly<{
    confirm: () => Promise<boolean>;
    readCurrentDraftDeletionDisposition: () => 'deletable' | 'missing' | 'launch-custody';
    deleteDraft: () => Promise<void>;
}>): Promise<boolean> {
    if (!await params.confirm()) return false;
    if (params.readCurrentDraftDeletionDisposition() !== 'deletable') return false;
    await params.deleteDraft();
    return true;
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
    section: { width: '100%', paddingBottom: 8 },
    group: { borderRadius: SESSION_LIST_ROW_CORNER_RADIUS },
    actionSlot: { width: 24, alignItems: 'flex-end' },
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
    availability?: NewSessionDraftAvailabilitySummary;
    onContinue: (draftId: string) => void;
    onDelete: (draftId: string) => Promise<boolean>;
    pressableRef: React.Ref<FocusableDraftTarget>;
    deleteDisabled: boolean;
    density: SessionRowDensity;
}>) {
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const presentation = buildNewSessionDraftRowPresentation(props.draft, props.availability);
    const draftId = props.draft.draftId;
    const status = presentation.statusKey ? t(presentation.statusKey) : null;
    const minimal = props.density === 'minimal';
    const itemDensity = props.density === 'default'
        ? 'comfortable'
        : props.density === 'minimal'
            ? 'tight'
            : 'compact';
    const densityViewState = resolveSessionListDensityViewState(
        props.density === 'minimal' ? 'narrow' : props.density === 'compact' ? 'cozy' : 'comfortable',
        { isTablet, platform: Platform.OS },
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
    const subtitleTextMetrics = SESSION_LIST_ROW_STATUS_TEXT_METRICS[props.density];
    const accessibleSummary = [
        presentation.title, status, t('sessionDrafts.continueEditing'),
    ].filter(Boolean).join(', ');
    return (
        <Item
            testID={`session-draft-row:new-session:${draftId}`}
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
                <AgentIcon
                    agentId={agentId}
                    size={identityMetrics.agentLogoSize}
                    color={theme.colors.text.primary}
                    style={{ transform: [{ scale: getAgentPickerIconScale(agentId) }] }}
                    testID={`session-draft-agent-logo:new-session:${draftId}`}
                />
            ) : undefined}
            iconBoxSize={minimal ? identityMetrics.slotSize : undefined}
            onPress={() => props.onContinue(draftId)}
            accessibilityRole="button"
            accessibilityLabel={accessibleSummary}
            rightElement={(
                <View
                    testID={`session-draft-action-slot:new-session:${draftId}`}
                    style={stylesheet.actionSlot}
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
                        onPress={(event) => {
                            event.stopPropagation();
                            fireAndForget(props.onDelete(draftId), { tag: 'NewSessionDraftRow.delete' });
                        }}
                    >
                        <Icon
                            name="trash"
                            size={ICON_SIZE.xs}
                            color={theme.colors.state.danger.foreground}
                            style={stylesheet.deleteIcon}
                        />
                    </Pressable>
                </View>
            )}
            rightElementOutsidePressable
            pressableRef={props.pressableRef}
        />
    );
});

export const NewSessionDraftsSectionView = React.memo(function NewSessionDraftsSectionView(props: Readonly<{
    drafts: readonly NewSessionDraftProjection[];
    availabilityByDraftId?: Readonly<Record<string, NewSessionDraftAvailabilitySummary>>;
    onContinue: (draftId: string) => void;
    onDelete: (draftId: string) => Promise<boolean>;
    deleteDisabledDraftIds?: ReadonlySet<string>;
    density?: SessionRowDensity;
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
    const handleDelete = React.useCallback(async (draftId: string) => {
        const deletedIndex = props.drafts.findIndex((draft) => draft.draftId === draftId);
        const candidateDraftIds = props.drafts
            .map((draft, index) => ({ draftId: draft.draftId, distance: Math.abs(index - deletedIndex), index }))
            .filter((candidate) => candidate.draftId !== draftId)
            .sort((left, right) => left.distance - right.distance || right.index - left.index)
            .map((candidate) => candidate.draftId);
        const deleted = await props.onDelete(draftId);
        if (deleted) setPendingFocusRestore({ deletedDraftId: draftId, candidateDraftIds });
        return deleted;
    }, [props.drafts, props.onDelete]);
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
    return (
        <View testID="session-drafts-section" style={stylesheet.section}>
            <ItemGroup
                title={t('sessionDrafts.sectionTitle')}
                containerStyle={stylesheet.group}
                selectableItemCountOverride={props.drafts.length}
            >
                {props.drafts.map((draft) => (
                    <NewSessionDraftRow
                        key={draft.draftId}
                        draft={draft}
                        availability={props.availabilityByDraftId?.[draft.draftId]}
                        onContinue={props.onContinue}
                        onDelete={handleDelete}
                        pressableRef={(target) => registerRowTarget(draft.draftId, target)}
                        deleteDisabled={props.deleteDisabledDraftIds?.has(draft.draftId) === true}
                        density={props.density ?? 'default'}
                    />
                ))}
            </ItemGroup>
        </View>
    );
});

export function useNewSessionDraftProjections(): readonly NewSessionDraftProjection[] {
    const scope = useActiveServerAccountScope();
    const subscribe = React.useCallback((listener: () => void) => (
        scope ? subscribeSessionDraftList(scope, listener) : () => undefined
    ), [scope]);
    const getSnapshot = React.useCallback(() => (scope ? listNewSessionDraftProjections(scope) : EMPTY_DRAFTS), [scope]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export const NewSessionDraftsSection = React.memo(function NewSessionDraftsSection(props: Readonly<{
    density?: SessionRowDensity;
}>) {
    const router = useRouter();
    const scope = useActiveServerAccountScope();
    const machines = useLaunchSelectionMachines();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const drafts = useNewSessionDraftProjections();
    const actionOperations = useAllActionOperations();
    const pluginProjection = useAppShellPluginUiProjection();
    const deleteDisabledDraftIds = React.useMemo(() => new Set(drafts.flatMap((draft) => (
        scope && isNewSessionDraftLaunchInCustody({
            accountId: scope.accountId,
            launchUserAttemptId: draft.localSupplement.launchUserAttemptId,
            operations: actionOperations,
        }) ? [draft.draftId] : []
    ))), [actionOperations, drafts, scope]);
    const onlineMachineIds = React.useMemo(() => new Set(
        machines.filter((machine) => isMachineOnline(machine)).map((machine) => machine.id),
    ), [machines]);
    const availabilityByDraftId = React.useMemo(() => {
        const currentPluginProjection = pluginProjection.phase === 'current'
            ? pluginProjection.pluginUiProjection
            : null;
        const installedPluginIds = new Set(Object.keys(currentPluginProjection?.installedPackagesById ?? {}));
        return Object.fromEntries(drafts.map((draft) => {
            const machineId = draft.document.target.kind === 'newSession'
                ? draft.document.target.authoring.machineId?.value
                : null;
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
                    inventoryCurrent: scope !== null && machineListStatusByServerId[scope.serverId] === 'idle',
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
        scope,
    ]);
    const handleContinue = React.useCallback((draftId: string) => router.push({ pathname: '/new', params: { draftId } }), [router]);
    const handleDelete = React.useCallback((draftId: string) => {
        if (!scope) return Promise.resolve(false);
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
                return isNewSessionDraftLaunchInCustody({
                    accountId: scope.accountId,
                    launchUserAttemptId: currentDraft.localSupplement.launchUserAttemptId,
                    operations: readAllActionOperations(),
                }) ? 'launch-custody' : 'deletable';
            },
            deleteDraft: () => deleteSessionDraft({ scope, address: { kind: 'newSession', draftId } }),
        });
    }, [scope]);

    return (
        <NewSessionDraftsSectionView
            drafts={drafts}
            availabilityByDraftId={availabilityByDraftId}
            onContinue={handleContinue}
            onDelete={handleDelete}
            deleteDisabledDraftIds={deleteDisabledDraftIds}
            density={props.density}
        />
    );
});
