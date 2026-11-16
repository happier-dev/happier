import * as React from 'react';

import type { SessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { findWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type { WorkflowDraftValidation, WorkflowExistingSessionOption } from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';

import type { WorkflowRunAsTarget, WorkflowRunAsTargetKind } from '../run/workflowRunAsTargets';
import type { WorkflowContinuityControls } from './WorkflowContinuityControls';
import { WorkflowBlockOptions } from './WorkflowBlockOptions';
import type { WorkflowSessionDrop } from './useWorkflowSessionBinding';
import type { WorkflowStepWorkspaceField } from './WorkflowProjectTargetControl';

/** The workflow's place, as a step's Workspace field reads it. */
export type WorkflowStepPlace = Pick<React.ComponentProps<typeof WorkflowStepWorkspaceField>, 'target' | 'machineName' | 'machines' | 'accountLifetime'>;

/**
 * Step options (04 §5.2): a block's settings, anchored beside the step's control, or the shared sheet
 * on a phone. The workflow's own settings live in How and where it runs (WF-REDESIGN-1116 change e).
 *
 * Settings groups are quiet by default: each is one disclosure whose closed
 * line is its effective values. A group is open when it holds a value set for
 * this subject, an issue, or a required-but-missing field, or when the person
 * opened it — the person's choice lives in the editor view state, never in the
 * definition. A closed disclosure never hides an error or a required field.
 *
 * Triggers and definition-local roles extend the same draft/history owner.
 */
export type WorkflowInspectorSubject = Readonly<{ kind: 'block'; blockId: string }>;

export type WorkflowInspectorPresentation = 'pane' | 'popover';

export type WorkflowInspectorProps = Readonly<{
    /** Saved source only; an unsaved draft has no run history. */
    workflowDefinitionId?: string;
    subject: WorkflowInspectorSubject;
    presentation: WorkflowInspectorPresentation;
    draft: WorkflowEditorDraft;
    onChange: (next: WorkflowEditorDraft) => void;
    /** Definition access is independent of the active Account's personal triggers. */
    documentEditable?: boolean;
    /** The page's validation: an issue inside a group keeps that group open. */
    validation?: WorkflowDraftValidation;
    /** The person's own open/closed choices, from the editor view state. */
    groupDisclosure?: ReadonlyMap<string, boolean>;
    onChangeGroupDisclosure?: (groupId: string, expanded: boolean) => void;
    /** Closes the popover presentation ("Done"). */
    onDone?: () => void;
    authoringFacts?: SessionAuthoringControlFacts;
    existingSessions?: readonly WorkflowExistingSessionOption[];
    sessionOptionsStatus?: React.ComponentProps<typeof WorkflowContinuityControls>['sessionOptionsStatus'];
    onRetrySessionOptions?: () => void;
    onSessionOptionsDemandChange?: (demanded: boolean) => void;
    bindExistingSession?: WorkflowSessionDrop['bind'];
    /** Where the workflow runs: a step's Workspace picks a checkout of this place (WF-REDESIGN-1116 change a). */
    place?: WorkflowStepPlace;
    /** "Each step runs in": a step's Runs in reads the workflow's default from here. */
    executionTarget?: WorkflowRunAsTargetKind;
    runAsTargets?: readonly WorkflowRunAsTarget[];
    /** The workflow's description (Artifact metadata the host owns); absent change handler: read-only. */
    description?: string;
    onChangeDescription?: (next: string) => void;
    testIDPrefix: string;
}>;


export function WorkflowInspector(props: WorkflowInspectorProps): React.ReactElement | null {
    const block = findWorkflowBlock(props.draft, props.subject.blockId);
    // A subject that no longer resolves renders nothing and the host closes its presentation.
    if (block === null) return null;
    // Keyed by block so a pushed page (Result, Only run when) never carries over to another block.
    return <WorkflowBlockOptions key={block.id} {...props} block={block} />;
}
