import * as React from 'react';
import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import type { WorkflowTriggerListRequestV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
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
import { useSessionWorkflowContext, type SessionWorkflowContextRead } from './useSessionWorkflowContext';
import { createSessionWorkflowSentenceIntent, type SessionWorkflowSentenceOptions, type WorkflowSentenceEditorIntent } from '../authoring/workflowSentenceAuthoring';
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

export type SelectedAutomationsSectionRead = Readonly<{
    accountLifetime: ServerAccountScopeLifetime | null | undefined;
    read: ReturnType<typeof useWorkflowTriggerSets>;
    editor: ReturnType<typeof useAccountWorkflowEditor>;
    rows: readonly AccountTriggerRow[];
    also: readonly AccountTriggerRow[];
    skippedNotSharedCount: number;
}>;

export type ResourceAutomationsSectionRead = SelectedAutomationsSectionRead & Readonly<{
    project: Pick<WorkflowProjectTargetV1, 'machineId' | 'directory'> | undefined;
    audience: readonly PrincipalRefV1[] | undefined;
    /** Session lifetime and Channels context stay separate from the selected subject's attachments. */
    session: (SessionWorkflowContextRead & Readonly<{
        createSentenceIntent(options?: SessionWorkflowSentenceOptions): WorkflowSentenceEditorIntent | null;
    }>) | null;
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

/** The selected read owns membership; every section consumes the same admitted rows and editor. */
type SessionEditorContext = Readonly<{ sessionId: string; sets: readonly WorkflowTriggerSetV1[] }>;

function useSelectedAutomationsSection(request: WorkflowTriggerListRequestV1 | null,
    accountLifetime: ServerAccountScopeLifetime | null | undefined, demanded: boolean,
    session?: SessionEditorContext): SelectedAutomationsSectionRead {
    return useSelectedAutomationsProjection(useWorkflowTriggerSets(request, accountLifetime, { demanded }), accountLifetime, session);
}

function useSelectedAutomationsProjection(read: ReturnType<typeof useWorkflowTriggerSets>,
    accountLifetime: ServerAccountScopeLifetime | null | undefined, session?: SessionEditorContext): SelectedAutomationsSectionRead {
    const editor = useAccountWorkflowEditor({ read: session ? { ...read, sets: session.sets } : read, accountLifetime,
        ...(session ? { lifetimeSessionId: session.sessionId } : {}) });
    const projected = React.useMemo(() => read.attachedPage ? projectAccountTriggerRows({
        sets: read.sets, attachedPage: read.attachedPage, accountId: accountLifetime?.scope.accountId,
        resolveWorkflowTitle: editor.resolveWorkflowTitle,
    }) : EMPTY_ROWS, [read.sets, read.attachedPage, accountLifetime?.scope.accountId, editor.resolveWorkflowTitle]);
    const rows = React.useMemo(() => projected.filter(row => row.attachment?.relation === 'direct'), [projected]);
    const also = React.useMemo(() => projected.filter(row => row.attachment?.relation === 'context'), [projected]);
    return { accountLifetime, read, editor, rows, also, skippedNotSharedCount: read.attachedPage?.skippedNotSharedCount ?? 0 };
}

type ActionTriggerPhase = Extract<WorkflowTriggerListRequestV1, { actionId: string }>['phase'];
const BOTH_PHASES: readonly ActionTriggerPhase[] = ['before', 'after'];

/**
 * Action detail selects an Action's before and after attachments (one selected read per phase the Action
 * offers), without inventing a resource or audience. One section reads both: the editor and rows see one read.
 */
export function useActionAutomationsSection(props: Readonly<{ actionId: Extract<WorkflowTriggerListRequestV1, { actionId: string }>['actionId'];
    phases?: readonly ActionTriggerPhase[]; accountLifetime: ServerAccountScopeLifetime | null }>): SelectedAutomationsSectionRead {
    const { accountLifetime, actionId } = props;
    const phases = props.phases ?? BOTH_PHASES;
    const demanded = useLayoutPresentationActive();
    const beforeRequest = React.useMemo(() => phases.includes('before') ? { actionId, phase: 'before' as const } : null, [actionId, phases]);
    const afterRequest = React.useMemo(() => phases.includes('after') ? { actionId, phase: 'after' as const } : null, [actionId, phases]);
    const before = useWorkflowTriggerSets(beforeRequest, accountLifetime, { demanded });
    const after = useWorkflowTriggerSets(afterRequest, accountLifetime, { demanded });
    const both = beforeRequest !== null && afterRequest !== null;
    const sets = React.useMemo(() => both
        ? [...before.sets, ...after.sets.filter(set => !before.sets.some(held => held.automationId === set.automationId))]
        : beforeRequest === null ? after.sets : before.sets, [both, beforeRequest, before.sets, after.sets]);
    const beforePage = before.attachedPage;
    const afterPage = after.attachedPage;
    const attachedPage = React.useMemo(() => !both ? (beforeRequest === null ? afterPage : beforePage)
        : beforePage && afterPage ? { attached: [...beforePage.attached, ...afterPage.attached],
            nextCursor: beforePage.nextCursor ?? afterPage.nextCursor,
            skippedNotSharedCount: beforePage.skippedNotSharedCount + afterPage.skippedNotSharedCount } : undefined,
    [both, beforeRequest, beforePage, afterPage]);
    const status = before.status === 'failed' || after.status === 'failed' ? 'failed' as const
        : before.status === 'loading' || after.status === 'loading' ? 'loading' as const : 'ready' as const;
    const handles = React.useRef({ before, after });
    handles.current = { before, after };
    const loadMore = React.useCallback(() => {
        const { before: b, after: a } = handles.current;
        if (b.attachedPage?.nextCursor) b.loadMore(); else a.loadMore();
    }, []);
    const retry = React.useCallback(() => { handles.current.before.retry(); handles.current.after.retry(); }, []);
    const acknowledge = React.useCallback((set: WorkflowTriggerSetV1) => {
        handles.current.before.acknowledge(set); handles.current.after.acknowledge(set);
    }, []);
    return useSelectedAutomationsProjection({ sets, attachedPage, status, loadMore, retry, acknowledge }, accountLifetime);
}

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
    const sessionContext = useSessionWorkflowContext(subject?.kind === 'session' ? subject.sessionId : null,
        { demanded, accountLifetime });
    const { read, editor, rows, also, skippedNotSharedCount } = useSelectedAutomationsSection(
        subject ? { subject, ...(props.contextSubjects ? { contextSubjects: [...props.contextSubjects] } : {}) } : null,
        accountLifetime, demanded, subject?.kind === 'session' ? { sessionId: subject.sessionId, sets: sessionContext.sets } : undefined);
    const legacyMachineId = legacySubject?.machineId;
    const project = React.useMemo(() => props.executionContext ?? (legacyMachineId ? { machineId: legacyMachineId, directory: '~' } : undefined),
        [props.executionContext, legacyMachineId]);
    const createSentenceIntent = React.useCallback((options?: SessionWorkflowSentenceOptions) => subject?.kind === 'session'
        ? createSessionWorkflowSentenceIntent({ name: props.subjectName ?? '', project,
            session: { subject, ...(Array.isArray(sessionContext.pullRequestLinks)
                ? { pullRequestLinks: sessionContext.pullRequestLinks } : {}) } }, options) : null,
    [subject, props.subjectName, project, sessionContext.pullRequestLinks]);
    const session = subject?.kind === 'session' ? { ...sessionContext, createSentenceIntent } : null;
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
    const profileSubject = subject?.kind === 'approvalProfile';
    const profileSharing = useDocumentShareController(demanded && linkDraft !== null && profileSubject && binding
        ? { scope: binding.scope, artifactId: subject.profileId, kind: 'approval-profile.v1' } : null);
    const audience = machineSubject ? machineSharing.audience : profileSubject ? profileSharing.audience : props.sourceAudience;
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
    const sourceSharing = machineSubject ? machineSharing : profileSubject ? profileSharing : null;
    const reviewIssue = sourceSharing?.issue ?? review.issue;
    const reviewLoading = review.loading || (linkDraft !== null && Boolean(sourceSharing?.loading));
    const retryReview = sourceSharing?.issue ? sourceSharing.retryContent : review.retryContent;
    const link = React.useMemo<ResourceAutomationsSectionRead['link']>(() => ({ whenOptions, whenStatus, draft: linkDraft, setDraft,
        missingAudience, issue: reviewIssue, loading: reviewLoading,
        retryReview, submit: submitLink }),
    [whenOptions, whenStatus, linkDraft, setDraft, missingAudience, reviewIssue, reviewLoading, retryReview, submitLink]);
    return { accountLifetime, read, editor, rows, also, skippedNotSharedCount, project, audience, session, link };
}
