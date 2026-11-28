import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { SessionSectionResultV1Schema } from '@happier-dev/protocol/actions/sessionSections';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ServerCredentialAccountScopeBindingProvider, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useSessionOrganizationProjection } from '@/sync/domains/state/storage';
import type { SessionOrganizationProjection } from '@/sync/domains/session/organization/types';
import { buildSessionOrganizationListViewState, type SessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { buildSessionOrganizationTagLabelById } from '@/sync/domains/session/organization/tagLabels';
import { useSessionSectionChoiceLabels } from '@/sync/domains/session/organization/useSessionSectionChoiceLabels';
import { requireSessionOrganizationMutationScope, writeSessionOrganizationTagLabels } from '@/sync/ops/sessionOrganization';
import { sessionTagKey } from '@/components/sessions/shell/sessionTagUtils';
import type { SessionActionTarget } from '@/components/sessions/actions/sessionActionTypes';
import { executeSessionAction } from '@/components/sessions/actions/sessionActionExecution';
import { SESSION_ACTION_EDIT_TAGS_ID } from '@/components/sessions/actions/sessionActionIds';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { SelectionList } from '@/components/ui/selectionList';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';
import { buildSessionTagsMenuContent } from './SessionTagsMenuContent';
import { openSessionFolderSelection } from './SessionFolderSelection';
import { requestSessionSectionName } from './sessionSectionEditing';

type EditorParams = Readonly<{
    target: SessionActionTarget;
    sourceLabel: string;
    projection: SessionOrganizationProjection | null;
    listView: SessionOrganizationListViewState;
    actions: Pick<ReturnType<typeof useMountedActionExecution>, 'execute' | 'executeValue'>;
}>;

/** The Info controls and header presenters share their selection, current values and scoped writes. */
export function useSessionOrganizationEditors({ target, sourceLabel, projection, listView, actions }: EditorParams) {
    const { theme } = useUnistyles();
    const serverId = target.serverId ?? '';
    const sessionId = target.sessionId;
    const settingsKey = sessionTagKey(serverId, sessionId);
    const foldersEnabled = useFeatureEnabled('sessions.folders', { scopeKind: 'spawn', serverId });
    const entries = React.useMemo(() => listView.sessionTagsV1[settingsKey] ?? [], [listView.sessionTagsV1, settingsKey]);
    const labels = React.useMemo(() => entries.flatMap(tag => tag.display.status === 'available' ? [tag.display.value] : []), [entries]);
    const selectedIds = React.useMemo(() => entries.map(tag => tag.tagId), [entries]);
    const labelById = React.useMemo(() => buildSessionOrganizationTagLabelById(projection?.tagsById ?? {}), [projection?.tagsById]);
    const tagsDetail = React.useMemo(() => entries.map(tag => tag.display.status === 'available' ? tag.display.value : t('common.unavailable')).join(', '), [entries]);
    const [tagMenuOpen, setTagMenuOpen] = React.useState(false);
    const [editingTags, setEditingTags] = React.useState(false);
    const applyLabels = React.useCallback(async (tags: readonly string[]) => {
        await executeSessionAction({ actionId: SESSION_ACTION_EDIT_TAGS_ID, target, input: { tags }, context: { operations: {
            setTags: async (_sessionId, nextTags, options) => {
                const scope = await requireSessionOrganizationMutationScope(options?.serverId ?? serverId);
                await writeSessionOrganizationTagLabels({ scope, sessionId, tags: [...nextTags], executeAction: actions.execute });
            },
        } } });
    }, [actions.execute, serverId, sessionId, target]);
    const updateTags = React.useCallback((next: readonly string[]) => {
        setEditingTags(true);
        void applyLabels(next).catch(error => {
            Modal.alert(t('common.error'), error instanceof HappyError ? error.message : t('errors.unknownError'));
        }).finally(() => setEditingTags(false));
    }, [applyLabels]);
    const tagMenuContent = React.useMemo(() => buildSessionTagsMenuContent({
        tags: Object.entries(labelById).map(([id, label]) => ({ id, label })),
        selectedTagIds: selectedIds, iconColor: theme.colors.text.secondary,
        onToggle: id => {
            const nextIds = selectedIds.includes(id) ? selectedIds.filter(candidate => candidate !== id) : [...selectedIds, id];
            updateTags(nextIds.flatMap(id => labelById[id] ?? []));
        },
        onCreate: label => updateTags([...labels, label]),
    }), [labelById, labels, selectedIds, theme.colors.text.secondary, updateTags]);
    const currentFolderId = listView.sessionFolderAssignmentsBySessionKey[settingsKey] ?? null;
    const sectionLabels = useSessionSectionChoiceLabels(listView.sections, serverId, t('common.unavailable'));
    const currentSectionTitle = currentFolderId ? sectionLabels.get(currentFolderId) ?? t('common.unavailable') : null;
    const moveToFolder = React.useCallback(async () => {
        if (!foldersEnabled) return;
        const selected = await openSessionFolderSelection({
            sourceLabel, serverId, sections: listView.sections,
            value: currentFolderId ? { serverId, sectionId: currentFolderId } : null,
            onCreate: async () => {
                const name = await requestSessionSectionName(null);
                if (!name) return null;
                const created = SessionSectionResultV1Schema.parse(await actions.executeValue('session.sections.create', { name }));
                return { serverId, sectionId: created.section.sectionId };
            },
        });
        if (selected === undefined) return;
        await actions.executeValue('session.section.set', { sessionId, sectionId: selected?.sectionId ?? null });
    }, [actions.executeValue, currentFolderId, foldersEnabled, listView.sections, serverId, sessionId, sourceLabel]);
    const [movingToFolder, performMoveToFolder] = useHappyAction(moveToFolder);
    return { tagsAvailable: Boolean(serverId), foldersAvailable: Boolean(serverId) && foldersEnabled, tagMenuOpen, setTagMenuOpen, editingTags, tagMenuContent, tagsDetail,
        currentSectionTitle, foldersEnabled, movingToFolder, performMoveToFolder };
}

type TagsPresenterParams = Readonly<{ target: SessionActionTarget; sourceLabel: string; binding: ServerCredentialAccountScopeBinding | null }>;
type TagsEditorProps = TagsPresenterParams & Readonly<{ onRequestClose(): void }>;
function SessionTagsEditorContent(props: TagsEditorProps) {
    const serverId = props.target.serverId ?? '';
    const actions = useMountedActionExecution(props.binding?.scope);
    const projection = useSessionOrganizationProjection(actions.ready ? serverId : null);
    const listView = React.useMemo(() => buildSessionOrganizationListViewState({ serverId, projection }), [projection, serverId]);
    const editor = useSessionOrganizationEditors({ ...props, projection, listView, actions });
    return actions.ready ? <SelectionList rootStep={editor.tagMenuContent.selectionListStep} onRequestClose={props.onRequestClose}
        keyboardHintsEnabled={false} disableTransitions testID="session-tags-editor" /> : null;
}

function SessionTagsEditor(props: TagsEditorProps) {
    const { binding, onRequestClose } = props;
    React.useEffect(() => {
        if (!binding?.isCurrent()) { onRequestClose(); return; }
        const retirement = binding.onRetire(onRequestClose);
        return () => retirement.dispose();
    }, [binding, onRequestClose]);
    if (!binding) return null;
    return <ServerCredentialAccountScopeBindingProvider serverId={binding.scope.serverId}
        state={{ resolution: { kind: 'bound', scope: binding.scope }, binding }}>
        <SessionTagsEditorContent {...props} />
    </ServerCredentialAccountScopeBindingProvider>;
}

export function openSessionTagsEditor(params: TagsPresenterParams): void {
    let modalId = '';
    modalId = Modal.show({ component: SessionTagsEditor,
        chrome: { kind: 'card', title: t('sessionTags.editTagsLabel') }, closeOnBackdrop: true,
        props: { ...params, onRequestClose: () => Modal.hide(modalId) } });
}
