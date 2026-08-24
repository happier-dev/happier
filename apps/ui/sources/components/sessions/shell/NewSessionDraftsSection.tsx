import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/catalog/catalog';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { useActiveServerAccountScope, useIsDataReady, useLaunchSelectionMachines } from '@/sync/domains/state/storage';
import { resolvePersistedNewSessionOperationIdentity } from '@/sync/domains/actionOperations/actionOperationReentry';
import { readAllActionOperations, useAllActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import {
    deleteSessionDraft,
    getSessionDraftSnapshot,
    listNewSessionDraftProjections,
    subscribeSessionDraftList,
    type NewSessionDraftProjection,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { restoreFocusToBestTarget, type FocusReturnTarget, useFocusReturnFallbackRef } from '@/keyboard/focusReturn';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import {
    getNewSessionAttachmentDraftsRevision,
    readNewSessionAttachmentDrafts,
    subscribeNewSessionAttachmentDrafts,
} from '@/components/sessions/new/attachments/newSessionAttachmentDraftStore';
import { resolveNewSessionDraftAttachmentFlowId } from '@/components/sessions/new/attachments/newSessionDraftAttachmentFlowId';
import {
    buildNewSessionDraftRowPresentation,
    resolveNewSessionDraftAgentId,
    type NewSessionDraftSummaryNames,
} from '@/components/sessions/drafts/newSessionDraftPresentation';
import type { SessionRowDensity } from '@/components/sessions/shell/row/resolveSessionRowPresentation';
import {
    SESSION_LIST_ROW_CORNER_RADIUS,
    resolveSessionListRowHeight,
    resolveSessionListRowIdentityMetrics,
    resolveSessionListRowTitleTextMetrics,
    SESSION_LIST_ROW_STATUS_TEXT_METRICS,
    shouldUseReadableNativePhoneMinimalSessionRow,
} from '@/components/sessions/shell/sessionListRowDensity';
import { useIsTablet } from '@/utils/platform/responsive';

export { buildNewSessionDraftRowPresentation } from '@/components/sessions/drafts/newSessionDraftPresentation';

const EMPTY_DRAFTS: readonly NewSessionDraftProjection[] = Object.freeze([]);

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

const stylesheet = StyleSheet.create(() => ({
    section: {
        width: '100%',
        paddingBottom: 8,
    },
    group: {
        borderRadius: SESSION_LIST_ROW_CORNER_RADIUS,
    },
    deleteButton: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    deleteIcon: {
        // RN Web gives a custom component child a 17px inline box. Move the 14px glyph itself,
        // leaving the button's geometry and native centering untouched.
        transform: Platform.select({ web: [{ translateY: 1.5 }], default: [] }),
    },
    deleteButtonDisabled: {
        opacity: 0.4,
    },
}));

const NewSessionDraftRow = React.memo(function NewSessionDraftRow(props: Readonly<{
    draft: NewSessionDraftProjection;
    names: NewSessionDraftSummaryNames;
    onContinue: (draftId: string) => void;
    onDelete: (draftId: string) => Promise<void>;
    deleteDisabled: boolean;
    focusRef?: React.Ref<React.ElementRef<typeof Pressable>>;
    density: SessionRowDensity;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const isTablet = useIsTablet();
    const presentation = buildNewSessionDraftRowPresentation(props.draft, props.names);
    const draftId = props.draft.draftId;
    const status = presentation.statusKey ? t(presentation.statusKey) : null;
    const minimal = props.density === 'minimal';
    const itemDensity = props.density === 'default'
        ? 'comfortable'
        : props.density === 'minimal'
            ? 'tight'
            : 'compact';
    const compact = props.density !== 'default';
    const compactMinimal = props.density === 'minimal';
    const readableNativePhoneMinimal = shouldUseReadableNativePhoneMinimalSessionRow({
        compact,
        compactMinimal,
        isTablet,
        platform: Platform.OS,
    });
    const rowHeight = resolveSessionListRowHeight({
        compact,
        compactMinimal,
        isTablet,
        platform: Platform.OS,
    });
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
        presentation.title,
        status,
        t('sessionDrafts.continueEditing'),
    ].filter(Boolean).join(', ');
    return (
        <Item
            focusRef={props.focusRef}
            testID={`session-draft-row:new-session:${draftId}`}
            title={presentation.title}
            subtitle={!minimal ? (status || undefined) : undefined}
            subtitleTestID={!minimal && status ? `session-draft-status:new-session:${draftId}` : undefined}
            titleLines={minimal ? 1 : 2}
            subtitleLines={1}
            density={itemDensity}
            style={{ height: rowHeight, minHeight: rowHeight, paddingVertical: 0 }}
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
            accessibilityHint={t('sessionDrafts.continueEditing')}
            rightElement={(
                <Pressable
                    testID={`session-draft-delete:new-session:${draftId}`}
                    style={[styles.deleteButton, props.deleteDisabled ? styles.deleteButtonDisabled : null]}
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
                        style={styles.deleteIcon}
                    />
                </Pressable>
            )}
        />
    );
});

export const NewSessionDraftsSectionView = React.memo(function NewSessionDraftsSectionView(props: Readonly<{
    drafts: readonly NewSessionDraftProjection[];
    unavailableMachineIds?: ReadonlySet<string>;
    attachmentNeedsAttentionDraftIds?: ReadonlySet<string>;
    onContinue: (draftId: string) => void;
    onDelete: (draftId: string) => Promise<boolean>;
    deleteDisabledDraftIds?: ReadonlySet<string>;
    density?: SessionRowDensity;
}>) {
    const rowFocusTargetsRef = React.useRef(new Map<string, FocusReturnTarget>());
    const listFocusFallbackRef = useFocusReturnFallbackRef<FocusReturnTarget>();
    const [pendingFocusRestore, setPendingFocusRestore] = React.useState<Readonly<{
        deletedDraftId: string;
        candidateDraftIds: readonly string[];
    }> | null>(null);
    const names: NewSessionDraftSummaryNames = {
        unavailableMachineIds: props.unavailableMachineIds,
        attachmentNeedsAttentionDraftIds: props.attachmentNeedsAttentionDraftIds,
    };
    const handleDelete = React.useCallback(async (draftId: string) => {
        const deletedIndex = props.drafts.findIndex((draft) => draft.draftId === draftId);
        const candidateDraftIds = props.drafts
            .map((draft, index) => ({ draftId: draft.draftId, distance: Math.abs(index - deletedIndex), index }))
            .filter((candidate) => candidate.draftId !== draftId)
            .sort((left, right) => left.distance - right.distance || right.index - left.index)
            .map((candidate) => candidate.draftId);
        const deleted = await props.onDelete(draftId);
        if (deleted) setPendingFocusRestore({ deletedDraftId: draftId, candidateDraftIds });
    }, [props.drafts, props.onDelete]);
    React.useEffect(() => {
        if (!pendingFocusRestore) return;
        if (props.drafts.some((draft) => draft.draftId === pendingFocusRestore.deletedDraftId)) return;
        const survivingDraftIds = new Set(props.drafts.map((draft) => draft.draftId));
        const nextDraftId = pendingFocusRestore.candidateDraftIds.find((draftId) => survivingDraftIds.has(draftId));
        const nextTarget = nextDraftId ? rowFocusTargetsRef.current.get(nextDraftId) : null;
        restoreFocusToBestTarget(
            { current: nextTarget ?? null },
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
                        names={names}
                        onContinue={props.onContinue}
                        onDelete={handleDelete}
                        deleteDisabled={props.deleteDisabledDraftIds?.has(draft.draftId) === true}
                        density={props.density ?? 'default'}
                        focusRef={(target) => {
                            if (target) rowFocusTargetsRef.current.set(draft.draftId, target);
                            else rowFocusTargetsRef.current.delete(draft.draftId);
                        }}
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
    const getSnapshot = React.useCallback(() => (
        scope ? listNewSessionDraftProjections(scope) : EMPTY_DRAFTS
    ), [scope]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export const NewSessionDraftsSection = React.memo(function NewSessionDraftsSection(props: Readonly<{
    density?: SessionRowDensity;
}>) {
    const router = useRouter();
    const scope = useActiveServerAccountScope();
    const isDataReady = useIsDataReady();
    const machines = useLaunchSelectionMachines();
    const drafts = useNewSessionDraftProjections();
    const actionOperations = useAllActionOperations(scope?.accountId ?? '');
    const attachmentDraftRevision = React.useSyncExternalStore(
        subscribeNewSessionAttachmentDrafts,
        getNewSessionAttachmentDraftsRevision,
        getNewSessionAttachmentDraftsRevision,
    );
    const deleteDisabledDraftIds = React.useMemo(() => new Set(drafts.flatMap((draft) => (
        resolvePersistedNewSessionOperationIdentity({
            draftScope: scope,
            draftId: draft.draftId,
            draft: draft.localSupplement,
            operations: actionOperations,
        }) ? [draft.draftId] : []
    ))), [actionOperations, drafts, scope]);
    const unavailableMachineIds = React.useMemo(() => {
        if (!isDataReady) return new Set<string>();
        const onlineMachineIds = new Set(machines.filter((machine) => isMachineOnline(machine)).map((machine) => machine.id));
        return new Set(drafts.flatMap((draft) => {
            if (draft.document.target.kind !== 'newSession') return [];
            const field = draft.document.target.authoring.machineId;
            return typeof field?.value === 'string' && field.value.trim() && !onlineMachineIds.has(field.value.trim())
                ? [field.value.trim()]
                : [];
        }));
    }, [drafts, isDataReady, machines]);
    const attachmentNeedsAttentionDraftIds = React.useMemo(() => new Set(drafts.flatMap((draft) => (
        readNewSessionAttachmentDrafts(resolveNewSessionDraftAttachmentFlowId(draft.draftId))
            .some((attachment) => attachment.status === 'error')
            ? [draft.draftId]
            : []
    ))), [attachmentDraftRevision, drafts]);
    const handleContinue = React.useCallback((draftId: string) => {
        router.push({ pathname: '/new', params: { draftId } });
    }, [router]);
    const handleDelete = React.useCallback(async (draftId: string) => {
        if (!scope) return false;
        return deleteNewSessionDraftAfterConfirmation({
            confirm: () => Modal.confirm(
                t('sessionDrafts.delete.confirmTitle'),
                t('sessionDrafts.delete.confirmDescription'),
                {
                    confirmText: t('common.delete'),
                    cancelText: t('common.cancel'),
                    destructive: true,
                },
            ),
            readCurrentDraftDeletionDisposition: () => {
                const currentDraft = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
                if (!currentDraft) return 'missing';
                return resolvePersistedNewSessionOperationIdentity({
                    draftScope: scope,
                    draftId,
                    draft: currentDraft.localSupplement,
                    operations: readAllActionOperations(scope.accountId),
                }) !== null ? 'launch-custody' : 'deletable';
            },
            deleteDraft: () => deleteSessionDraft({ scope, address: { kind: 'newSession', draftId } }),
        });
    }, [scope]);

    return (
        <NewSessionDraftsSectionView
            drafts={drafts}
            unavailableMachineIds={unavailableMachineIds}
            attachmentNeedsAttentionDraftIds={attachmentNeedsAttentionDraftIds}
            onContinue={handleContinue}
            onDelete={handleDelete}
            deleteDisabledDraftIds={deleteDisabledDraftIds}
            density={props.density}
        />
    );
});
