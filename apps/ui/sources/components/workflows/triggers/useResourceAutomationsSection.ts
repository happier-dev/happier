import * as React from 'react';
import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { parseWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';

import { useDocumentShareController } from '@/components/sharing/documents/useDocumentShareController';
import type { DocumentAudienceShareResult } from '@/components/sharing/documents/useDocumentShareController';
import { useMachineShareController } from '@/components/sharing/machines/useMachineShareController';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { addWorkflowTrigger, WorkflowTriggerWriteResult } from '@/sync/domains/workflows/workflowTriggerActions';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import { useAccountWorkflowEditor } from './AccountTriggersSection';
import { projectAccountTriggerRows, type AccountTriggerRow, type TriggerSubject } from './accountTriggerRows';
import { useWorkflowTriggerSets } from './useWorkflowTriggerSets';
import { useWorkflowActionCatalog } from '../presentation/useWorkflowActionCatalog';
import { useWorkflowTriggerEventOptions } from './useWorkflowTriggerEventOptions';
import { buildResourceWorkflowTriggerStartOptions, type ResourceWorkflowTriggerStartOption } from './workflowTriggerStarts';

const NO_SHARED_AUDIENCE: readonly PrincipalRefV1[] = [];
const EMPTY_ROWS: readonly AccountTriggerRow[] = [];
const EMPTY_WHEN_OPTIONS: readonly ResourceWorkflowTriggerStartOption[] = Object.freeze([]);

type ResourceAutomationLinkInput = Exclude<Parameters<typeof addWorkflowTrigger>[0], Readonly<{ observationOnly: unknown }>>;
export type ResourceAutomationLinkDraft = Readonly<Omit<ResourceAutomationLinkInput,
    'project' | 'target' | 'workflow' | 'trigger'> & { workflow: string;
        /** Link authors a new definition; saved revision-bound envelopes are not authoring starts. */
        trigger: Exclude<ResourceAutomationLinkInput['trigger'], Readonly<{ triggerDefinitionEnvelope: unknown }>> }>;
export type ResourceAutomationLinkResult =
    | Readonly<{ ok: true; shared: readonly PrincipalRefV1[]; write: WorkflowTriggerWriteResult }>
    | Readonly<{ ok: false; phase: 'declined'; shared: readonly [] }>
    | (Extract<DocumentAudienceShareResult, { ok: false }> & Readonly<{ phase: 'sharing' }>)
    | Readonly<{ ok: false; phase: 'link'; shared: readonly PrincipalRefV1[]; error: unknown }>;

export type ResourceAutomationsSectionInput = Readonly<{
    subject: AutomationSubjectV1;
    /** A mounted resource borrows its physical host's Account; explicit null never captures focus. */
    accountLifetime?: ServerAccountScopeLifetime | null;
    contextSubjects?: readonly AutomationSubjectV1[];
    /** Execution placement is independent of the selected resource's identity. */
    executionContext?: Pick<WorkflowProjectTargetV1, 'machineId' | 'directory'>;
    serverId?: string;
    subjectName?: string;
    deploymentEnvironment?: DeploymentEnvironmentRefV1;
    /** Recipient intent admitted by the accepted Source's grant owner. */
    sourceAudience?: readonly PrincipalRefV1[];
}>;
type LegacyResourceAutomationsSectionInput = Omit<ResourceAutomationsSectionInput, 'subject'> & Readonly<{ subject: TriggerSubject }>;

export type ResourceAutomationsSectionRead = Readonly<{
    accountLifetime: ServerAccountScopeLifetime | null | undefined;
    read: ReturnType<typeof useWorkflowTriggerSets>;
    editor: ReturnType<typeof useAccountWorkflowEditor>;
    rows: readonly AccountTriggerRow[];
    also: readonly AccountTriggerRow[];
    skippedNotSharedCount: number;
    project: Pick<WorkflowProjectTargetV1, 'machineId' | 'directory'> | undefined;
    audience: readonly PrincipalRefV1[] | undefined;
    link: Readonly<{
        whenOptions: readonly ResourceWorkflowTriggerStartOption[];
        whenStatus: 'idle' | 'loading' | 'ready' | 'unavailable';
        draft: ResourceAutomationLinkDraft | null;
        setDraft(draft: ResourceAutomationLinkDraft | null): void;
        missingAudience: ReturnType<typeof useDocumentShareController>['missingAudience'];
        issue: ReturnType<typeof useDocumentShareController>['issue'];
        loading: boolean;
        retryReview(): void;
        submit(decision: 'accept' | 'decline'): Promise<ResourceAutomationLinkResult>;
    }>;
}>;

/** Resource section data and mutations, consuming the incumbent read and presentation lifetimes. */
export function useResourceAutomationsSection(props: LegacyResourceAutomationsSectionInput): ResourceAutomationsSectionRead & { project: Pick<WorkflowProjectTargetV1, 'machineId' | 'directory'> };
export function useResourceAutomationsSection(props: ResourceAutomationsSectionInput): ResourceAutomationsSectionRead;
export function useResourceAutomationsSection(props: ResourceAutomationsSectionInput | LegacyResourceAutomationsSectionInput): ResourceAutomationsSectionRead;
export function useResourceAutomationsSection(props: ResourceAutomationsSectionInput | LegacyResourceAutomationsSectionInput): ResourceAutomationsSectionRead {
    const activeScope = useActiveServerAccountScope();
    const legacySubject = 'serverId' in props.subject ? null : props.subject;
    const serverId = 'serverId' in props.subject ? props.subject.serverId
        : props.serverId ?? props.deploymentEnvironment?.serverId ?? activeScope?.serverId;
    const { binding: capturedBinding } = useServerCredentialAccountScopeBinding(props.accountLifetime === undefined ? serverId : '');
    const binding = props.accountLifetime === undefined ? capturedBinding : props.accountLifetime;
    const accountLifetime = props.accountLifetime !== undefined ? props.accountLifetime : serverId ? binding : undefined;
    const demanded = useLayoutPresentationActive();
    // The retained service page is explicitly its Machine's view; service is not a canonical subject.
    const subject: AutomationSubjectV1 | null = 'serverId' in props.subject ? props.subject : !serverId ? null
        : props.subject.kind === 'environment' ? { kind: 'environment', serverId, environmentId: props.subject.environmentId }
            : { kind: 'machine', serverId, machineId: props.subject.machineId };
    const read = useWorkflowTriggerSets(subject ? { subject, ...(props.contextSubjects ? { contextSubjects: [...props.contextSubjects] } : {}) } : null,
        accountLifetime, { demanded });
    const editor = useAccountWorkflowEditor({ read, accountLifetime });
    const projected = React.useMemo(() => read.attachedPage ? projectAccountTriggerRows({
        sets: read.sets, attachedPage: read.attachedPage, accountId: accountLifetime?.scope.accountId,
        resolveWorkflowTitle: editor.resolveWorkflowTitle,
    }) : EMPTY_ROWS, [read.sets, read.attachedPage, accountLifetime?.scope.accountId, editor.resolveWorkflowTitle]);
    const rows = React.useMemo(() => projected.filter(row => row.attachment?.relation === 'direct'), [projected]);
    const also = React.useMemo(() => projected.filter(row => row.attachment?.relation === 'context'), [projected]);
    const legacyMachineId = legacySubject?.machineId;
    const project = React.useMemo(() => props.executionContext ?? (legacyMachineId ? { machineId: legacyMachineId, directory: '~' } : undefined),
        [props.executionContext, legacyMachineId]);
    const actionScope = React.useMemo(() => subject?.kind === 'session'
        ? { kind: 'session' as const, sessionId: subject.sessionId, serverId }
        : { kind: 'machine' as const, machineId: project?.machineId ?? (subject?.kind === 'machine' ? subject.machineId : null), serverId },
    [subject?.kind, subject?.kind === 'session' ? subject.sessionId : null,
        subject?.kind === 'machine' ? subject.machineId : null, project?.machineId, serverId]);
    const actionCatalog = useWorkflowActionCatalog(actionScope, 'automation', {
        enabled: demanded && subject !== null, accountLifetime });
    const eventCatalog = useWorkflowTriggerEventOptions({ machineId: actionCatalog.machineId, serverId: serverId ?? null,
        enabled: demanded && subject !== null && accountLifetime !== null, accountLifetime });
    const eventsReady = eventCatalog.status === 'ready'
        || (eventCatalog.status === 'idle' && actionCatalog.machineId === null);
    const whenStatus = !demanded || !subject || accountLifetime === null ? 'idle'
        : actionCatalog.phase === 'error' || actionCatalog.phase === 'unsupported' || eventCatalog.status === 'unavailable' ? 'unavailable'
            : eventCatalog.status === 'idle' && !eventsReady ? 'idle'
                : actionCatalog.phase === 'ready' && eventsReady ? 'ready' : 'loading';
    const whenOptions = React.useMemo(() => whenStatus === 'ready' && subject
        ? buildResourceWorkflowTriggerStartOptions({ subject, actions: actionCatalog.specs,
            events: eventCatalog.events, machineId: actionCatalog.machineId }) : EMPTY_WHEN_OPTIONS,
    [whenStatus, subject, actionCatalog.specs, eventCatalog.events, actionCatalog.machineId]);
    const [linkDraft, setLinkDraft] = React.useState<ResourceAutomationLinkDraft | null>(null);
    const setDraft = React.useCallback((draft: ResourceAutomationLinkDraft | null) => {
        // This flow links an Automation to the selected resource. Source setup supplies
        // its configuration; the resource section supplies the authored subject once.
        setLinkDraft(draft && subject && (draft.trigger.kind === 'pluginEvent'
            || (draft.trigger.kind === 'action' && !('consentFor' in draft.trigger)))
            ? { ...draft, trigger: { ...draft.trigger, subject } } : draft);
    }, [subject]);

    const machineId = subject?.kind === 'machine' ? subject.machineId : '';
    const machineSubject = subject?.kind === 'machine';
    const machineSharing = useMachineShareController({ machineId,
        machineName: props.subjectName ?? machineId,
        scope: demanded && linkDraft !== null && machineSubject && binding ? binding.scope : null });
    const audience = machineSubject ? machineSharing.audience : props.sourceAudience;
    const workflow = linkDraft ? parseWorkflowDefinitionRefV1(linkDraft.workflow) : null;
    const review = useDocumentShareController(demanded && binding && workflow?.kind === 'artifact'
        && audience !== undefined ? { scope: binding.scope, artifactId: workflow.artifactId,
            requestedAudience: audience } : null);
    const submitLink = React.useCallback(async (decision: 'accept' | 'decline'): Promise<ResourceAutomationLinkResult> => {
        if (decision === 'decline') return { ok: false, phase: 'declined', shared: [] };
        // Catalog Workflows have no Artifact grant roster; their ordinary trigger admission
        // owns availability. Only a saved Artifact can require audience sharing here.
        const sharing: DocumentAudienceShareResult = workflow?.kind === 'artifact'
            ? await review.shareMissingAudience() : { ok: true, shared: NO_SHARED_AUDIENCE };
        if (!sharing.ok) return { ...sharing, phase: 'sharing' };
        try {
            if (!linkDraft) throw new WorkflowActionError({ message: 'source_unavailable', rawCode: 'source_unavailable' });
            const write = await editor.add({ ...linkDraft, ...(project ? { project } : {}) }, binding);
            return { ok: true, shared: sharing.shared, write };
        } catch (error) {
            return { ok: false, phase: 'link', shared: sharing.shared, error };
        }
    }, [linkDraft, workflow?.kind, review.shareMissingAudience, editor.add, project, binding]);
    const missingAudience = workflow && workflow.kind !== 'artifact' ? NO_SHARED_AUDIENCE : review.missingAudience;
    const reviewIssue = machineSubject ? machineSharing.issue ?? review.issue : review.issue;
    const reviewLoading = review.loading || (machineSubject && linkDraft !== null && machineSharing.loading);
    const retryReview = machineSubject && machineSharing.issue ? machineSharing.retryContent : review.retryContent;
    const link = React.useMemo(() => ({ whenOptions, whenStatus, draft: linkDraft, setDraft,
        missingAudience, issue: reviewIssue, loading: reviewLoading,
        retryReview, submit: submitLink }),
    [whenOptions, whenStatus, linkDraft, setDraft, missingAudience, reviewIssue, reviewLoading, retryReview, submitLink]);
    return { accountLifetime, read, editor, rows, also, skippedNotSharedCount: read.attachedPage?.skippedNotSharedCount ?? 0, project, audience, link };
}
