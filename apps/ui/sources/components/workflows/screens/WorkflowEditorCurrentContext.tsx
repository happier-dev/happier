import * as React from 'react';
import type { EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';
import { useWorkflowEditorSelector, type WorkflowEditorDraftStore } from '../editor/workflowEditorDraftStore';

const readName = (draft: WorkflowEditorDraft) => draft.name;
const readDraftId = (draft: WorkflowEditorDraft) => draft.draftId;

/** The mounted editor lends its address; reads and edits retain the existing draft Action owner. */
export function WorkflowEditorCurrentContext(props: Readonly<{
    draftStore: WorkflowEditorDraftStore;
    scope: EntityDragScopeV1 | null;
    workflowId?: string;
}>): null {
    const name = useWorkflowEditorSelector(props.draftStore, readName);
    const draftId = useWorkflowEditorSelector(props.draftStore, readDraftId);
    const serverId = props.scope?.serverId;
    const accountId = props.scope?.accountId;
    const workflowId = props.workflowId;
    const enrichment = React.useMemo(() => serverId && accountId ? {
        entity: {
            kind: 'workflow',
            label: name.trim() || t('workflows.page.untitled'),
            reference: { scope: { serverId, accountId }, draftId,
                ...(workflowId === undefined ? {} : { workflowId }) },
        },
    } : null, [serverId, accountId, draftId, name, workflowId]);
    usePublishCurrentUiContext(enrichment);
    return null;
}
