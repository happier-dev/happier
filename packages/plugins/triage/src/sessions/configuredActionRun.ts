import { createTriageBulkEntrySessionsController, projectTriageConfiguredBulkResultV1, type TriageBulkSessionsRequestV1, type TriageBulkHostV1 } from './bulkEntrySessionsController.js';
import { createTriageEntrySessionStartController, type TriageStartHostV1, type TriagePendingPullRequestReviewV1 } from './entrySessionStartController.js';
import type { TriageRunConfiguredActionInputV1, TriageLegacyConfiguredStartRecoveryV1, TriageLegacyRunConfiguredActionResultV1 as TriageRunConfiguredActionResultV1, TriageSessionDeliveryFailureDetailV1 } from '../actions/configuredActionRunProtocol.js';
import { planTriageOfferedActionsV1 } from '../settings/actions.js';
import type { TriagePullRequestReviewChoiceV1, TriageStartEntrySessionResultV1 } from '../actions/entrySessionProtocol.js';
import { continueTriagePullRequestReviewV1 } from './pullRequestReviewContinuation.js';
import { openLinkedSession } from './entrySessionOpen.js';
import { triageEntryRowKey } from '../projection/listWindow.js';
import { resolveTriageConfiguredActionForExecutionV1 } from './actionResolution.js';
import { readTriageActionPlacementV1, resolveTriageActionReferencesV1, resolveTriageActionInstructionV1 } from './actionResolution.js';
import { triageFailureSubjectEntryV1, triageHealthAlertEntryV1, type TriageSessionHandoffInputV1, type TriageSessionHandoffResultV1 } from '@happier-dev/triage-protocol/v1';
import { SessionMessageSendResultV1ProtocolSchema, type ActionSessionAddressV1, type SessionInputForgeEvidenceV1, type SessionStatusActionResultV1 } from '@happier-dev/plugin-sdk/sessions';
import type { PluginUiHostApi, ComposerTransactionV1 } from '@happier-dev/plugin-sdk/ui';
import { PluginError, type JsonValue, type PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginActionInputById, PluginActionResultById, PluginClientActionUi } from '@happier-dev/plugin-sdk/actions';
import { ProtocolComposerAttachmentAuthorValueV1Schema, ActionOperationGetV1ResponseProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import { normalizeScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import { SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1, SessionPullRequestWatchReadResultV1Schema,
    SessionPullRequestConfiguredFixInputV1Schema, SessionPullRequestConfiguredFixResultV1Schema,
    parseGithubConversationUrlV1 } from '@happier-dev/channels-protocol/v1';
import { sameTriageEntryReference } from '../corpus/identity/components.js';
import { buildTriageForgeEvidenceAttachmentDraftV1 } from '../composer/mutationPlan.js';
import { readTriageActionExecutionPlacementV1, resolveTriageActionCheckoutV1, resolveTriageActionPlacementV1 } from './actionLaunch.js';
import { readTriageAgentExecutionTargetV1, readTriageInvestigationAgentV1 } from './agentTarget.js';
import { requestTriageNewSessionAuthoringV1 } from './newSessionAuthoring.js';
import { projectTriageActionPlacementCandidatesV1, projectTriageNewSessionDestinationV1 } from '../ui/header/newSessionDestination.js';
import { mintTriageOpaqueIdV1 } from '../opaqueId.js';
import { startEntrySession, resumeEntrySessionStart, type TriageEntrySessionStartResultV1, type TriageEntrySessionPendingPhaseV1 } from './entrySessionOrchestrator.js';
import { materializationWorkspaceFacts, type TriageEntrySessionWorkspaceFactsV1 } from './entrySessionWorkspace.js';
import type { TriageSessionActionInvokerV1, TriageSessionActionIdV1 } from './entrySessionOpen.js';
import { TriageLinkEntryToSessionActionResultV1Schema, TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1 } from '../actions/sessionLinksProtocol.js';
import { planTriageActionDeliveryV1 } from './actionDelivery.js';
import type { TriageHandoffRunConfiguredActionResultV1, TriageHandoffStartRecoveryV1, TriageConfiguredStartRecoveryV1 } from '../actions/configuredActionRunProtocol.js';
import { readTriageProjectRegistryV1 } from './projectCandidates.js';
import { TRIAGE_VERIFY_EXISTING_REVIEW_WORKSPACE_ACTION_LOCAL_ID_V1, TriageVerifyExistingReviewWorkspaceResultV1Schema } from '../actions/entrySessionProtocol.js';
import { readTriageHealthAlertHandoffV1, projectTriageUnavailableInvestigationPlacementV1 } from './healthAlertHandoff.js';

type HandoffHost = Omit<TriageConfiguredActionRunHostV1, 'context' | 'selectActionInput'>
    & Pick<PluginClientActionUi, 'context' | 'selectActionInput'>
    & Partial<Pick<PluginUiHostApi, 'readComposer' | 'applyComposer'>> & Readonly<{
        readSessionStatus?(address: ActionSessionAddressV1, options?: PluginCancellationOptions): Promise<SessionStatusActionResultV1 | null>;
    }>;
type HandoffEntries = TriageConfiguredActionRunRequestV1['entries'];

/** Convert evidence to data only. The attachment dispatch owner alone frames it. */
function handoffForgeEvidence(input: TriageSessionHandoffInputV1, health?: Extract<Awaited<ReturnType<typeof readTriageHealthAlertHandoffV1>>, { kind: 'ready' }>): SessionInputForgeEvidenceV1 | undefined {
    const items: SessionInputForgeEvidenceV1['items'][number][] = health ? [health.evidence] : [];
    for (const evidence of input.evidence) {
        switch (evidence.kind) {
            case 'failure': case 'alert': break; // The admitted subject contributes its single owner-read reference above.
            case 'entry': case 'alertEntry': break; // Fresh source-owned attachment resolution below.
            case 'hostedCi':
                items.push({ source: { kind: 'hostedCi', label: evidence.summary.repository.repository,
                    ...(evidence.summary.webUrl === undefined ? {} : { url: evidence.summary.webUrl }) },
                    author: { kind: 'process' }, text: JSON.stringify(evidence.summary) });
                break;
            case 'releaseNotes':
                items.push({ source: { kind: 'releaseNotes', label: evidence.repository.repository },
                    author: { kind: 'unknown' }, text: JSON.stringify(evidence) });
                break;
            case 'localTerminal':
                items.push({ source: { kind: 'localTerminal', label: 'Selected terminal output' },
                    author: { kind: 'process' }, text: JSON.stringify(evidence) });
                break;
        }
    }
    return items.length === 0 ? undefined : { v: 1, items };
}

/** New public operands adapt into the incumbent configured choice/start/delivery owners. */
export async function runTriageConfiguredHandoffV1(
    host: HandoffHost,
    input: TriageSessionHandoffInputV1,
    options: Readonly<{ entries: HandoffEntries; signal: AbortSignal; session?: ActionSessionAddressV1;
        resumeStart?: TriageConfiguredStartRecoveryV1; mintCreationKey?: () => string }>,
): Promise<TriageHandoffRunConfiguredActionResultV1> {
    const finish = (handoff: TriageSessionHandoffResultV1, recovery?: TriageConfiguredStartRecoveryV1): TriageHandoffRunConfiguredActionResultV1 => ({
        v: 1, handoff, ...(recovery === undefined ? {} : { recovery }),
    });
    const unavailable = (reason: Extract<TriageSessionHandoffResultV1, { kind: 'unavailable' }>['reason']) => finish({ kind: 'unavailable', reason }, options.resumeStart);
    const targetUnavailable = (reason: NonNullable<Extract<TriageSessionHandoffResultV1, { kind: 'unavailable' }>['detail']>['reason'], cause?: string) =>
        finish({ kind: 'unavailable', reason: 'targetUnavailable', detail: { reason, ...(cause === undefined ? {} : { cause }) } }, options.resumeStart);
    const cancellation = { signal: options.signal };
    if (options.signal.aborted) return finish({ kind: 'cancelled' }, options.resumeStart);
    const configured = await resolveTriageConfiguredActionForExecutionV1(host, input.configuredActionId, undefined, cancellation);
    if (configured.status !== 'resolved' || configured.action.target.kind !== 'agent') return unavailable('configuredActionUnavailable');
    const healthRead = input.context.kind === 'healthAlert' || input.context.kind === 'failure'
        ? await readTriageHealthAlertHandoffV1(host, input, options.signal) : undefined;
    if (options.signal.aborted) return finish({ kind: 'cancelled' }, options.resumeStart);
    if (healthRead === null || input.context.kind !== 'healthAlert' && input.context.kind !== 'failure' && input.evidence.some(evidence => evidence.kind === 'alert' || evidence.kind === 'failure')) return unavailable('evidenceInvalid');
    if (healthRead?.kind === 'placement_choice_required') {
        const agents = await readTriageInvestigationAgentV1(host, input.agentChoice.kind === 'target' ? input.agentChoice.targetKey : undefined, cancellation);
        return finish({ ...healthRead, agents: agents.candidates }, options.resumeStart);
    }
    const health = healthRead;
    const nativeSubject = health === undefined ? undefined : input.context.kind === 'failure'
        ? triageFailureSubjectEntryV1(input.context.subject) : input.context.kind === 'healthAlert'
            ? triageHealthAlertEntryV1(input.context) : undefined;
    const selected = input.context.kind === 'entry' ? input.context.entry : undefined;
    const primary = selected === undefined ? undefined : options.entries.find((entry) =>
        sameTriageEntryReference(entry.entryRef, selected.entryRef) && entry.sourceInstance.sourceInstanceId === selected.sourceInstanceId);
    if (selected !== undefined && primary === undefined) return unavailable('evidenceInvalid');
    if (primary !== undefined && input.sessionChoice.kind !== 'existing' && options.resumeStart !== undefined) {
        const recovery = options.resumeStart;
        const original = 'handoff' in recovery ? recovery.handoff : undefined;
        if (recovery.state.kind !== 'single' || recovery.state.actionId !== configured.action.actionId
            || original === undefined || JSON.stringify(original) !== JSON.stringify(input)
            || !sameTriageEntryReference(recovery.state.input.entryRef, primary.entryRef)
            || recovery.entries.length !== 1 || !sameTriageEntryReference(recovery.entries[0]!.entryRef, primary.entryRef)
            || recovery.entries[0]!.sourceInstanceId !== primary.sourceInstance.sourceInstanceId) return unavailable('scopeMismatch');
    }
    let repository = input.context.kind === 'repository' ? input.context.repository : primary?.repository;
    let registry: Awaited<ReturnType<typeof readTriageProjectRegistryV1>> | undefined = health?.registry;
    const readRegistry = async () => registry ??= await readTriageProjectRegistryV1(host, cancellation);
    const suppliedWorkspace = input.context.kind === 'repository' ? input.context.workspace : undefined;
    const sameWorkspace = (left: NonNullable<typeof suppliedWorkspace>, right: NonNullable<typeof suppliedWorkspace>) =>
        left.serverId === right.serverId && left.machineId === right.machineId && left.workspaceId === right.workspaceId && left.rootPath === right.rootPath;
    const matchesRepository = async (workspace: NonNullable<typeof suppliedWorkspace>) => {
        const current = await readRegistry();
        return current.status === 'read' && current.projects.some((project) => project.serverId === workspace.serverId
            && project.machineId === workspace.machineId && 'id' in project.projectKey
            && project.projectKey.id === workspace.workspaceId && project.rootPath === workspace.rootPath
            && project.forge !== undefined && repository !== undefined && sameScmHostingRepositoryIdentity(project.forge, repository));
    };
    if (health?.workspace) {
        const current = await readRegistry();
        const project = current.status === 'read' ? current.projects.find(project => project.reachable
            && 'id' in project.projectKey && project.projectKey.id === health.workspace!.workspaceId
            && project.serverId === health.machine.serverId && project.machineId === health.machine.machineId
            && project.rootPath === health.workspace!.rootPath) : undefined;
        if (!project) return unavailable('scopeMismatch');
        repository = project.forge;
    }
    if (suppliedWorkspace !== undefined && !await matchesRepository(suppliedWorkspace)) return unavailable('repositoryMismatch');
    for (const evidence of input.evidence) {
        if (evidence.kind === 'entry' || evidence.kind === 'alertEntry') {
            if (selected !== undefined && (!sameTriageEntryReference(selected.entryRef, evidence.entry.entryRef)
                || selected.sourceInstanceId !== evidence.entry.sourceInstanceId)) return unavailable('scopeMismatch');
            const facts = options.entries.find((entry) => sameTriageEntryReference(entry.entryRef, evidence.entry.entryRef)
                && entry.sourceInstance.sourceInstanceId === evidence.entry.sourceInstanceId);
            if (facts === undefined) return unavailable('evidenceInvalid');
            if (selected === undefined && (repository === undefined || facts.repository === undefined
                || !sameScmHostingRepositoryIdentity(repository, facts.repository))) return unavailable('repositoryMismatch');
        } else if (evidence.kind === 'hostedCi' || evidence.kind === 'releaseNotes') {
            const evidenceRepository = evidence.kind === 'hostedCi' ? evidence.summary.repository : evidence.repository;
            if (repository === undefined || !sameScmHostingRepositoryIdentity(repository, evidenceRepository)) return unavailable('repositoryMismatch');
        } else if (evidence.kind === 'alert' || evidence.kind === 'failure') {
            if (!health) return unavailable('evidenceInvalid');
        } else {
            // The operation address names observation custody, not the worker
            // or original checkout. Read only the existing authorized metadata.
            const read = ActionOperationGetV1ResponseProtocolSchema.safeParse(await host.executeAction(
                'action.operations.get', evidence.operationRef, cancellation).catch(() => null));
            if (!read.success || read.data.kind !== 'found' || read.data.operation.operationId !== evidence.operationRef.operationId
                || read.data.operation.domainRef?.kind !== 'projectCommand') return unavailable('evidenceInvalid');
            const workspace = read.data.operation.domainRef.sourceWorkspace;
            if (workspace === undefined) return unavailable('scopeMismatch');
            if (suppliedWorkspace !== undefined && !sameWorkspace(suppliedWorkspace, workspace)) return unavailable('scopeMismatch');
            if (!await matchesRepository(workspace)) return unavailable('repositoryMismatch');
        }
    }
    if (primary !== undefined && (primary.workflowSubject === null
        || planTriageOfferedActionsV1([configured.action], primary.workflowSubject).length === 0)) return unavailable('configuredActionUnavailable');
    const action = { ...configured.action,
        profileId: input.agentChoice.kind === 'profile' ? input.agentChoice.profileId : configured.action.profileId,
        target: { ...configured.action.target, delivery: input.delivery === 'configured' ? configured.action.target.delivery : input.delivery },
    };
    const references = await resolveTriageActionReferencesV1(host, action, cancellation);
    if (references.status !== 'resolved') return targetUnavailable('action_references_unresolved', references.status);
    const promptText = resolveTriageActionInstructionV1(action, references.prompt?.text ?? null,
        { task: input.task, context: input.context.kind });
    const forgeEvidence = handoffForgeEvidence(input, health);
    const attachment = forgeEvidence === undefined ? [] : [buildTriageForgeEvidenceAttachmentDraftV1(forgeEvidence)];
    if (attachment.some((item) => !ProtocolComposerAttachmentAuthorValueV1Schema.safeParse(item.value).success)) return unavailable('evidenceInvalid');
    const delivery = action.target.delivery;
    // Configured placement preferences choose a new Session; an existing one
    // keeps its Agent unless the caller supplied an explicit Agent/profile.
    const preferredKey = input.sessionChoice.kind === 'existing' && input.agentChoice.kind === 'configured' ? undefined
        : input.agentChoice.kind === 'target' ? input.agentChoice.targetKey : references.profile?.preferredAgentTargetKey;
    const investigationAgent = health && input.sessionChoice.kind !== 'existing' && (delivery === 'send' || preferredKey !== undefined)
        ? await readTriageInvestigationAgentV1(host, preferredKey, cancellation) : undefined;
    const agent = investigationAgent?.selection ?? (preferredKey === undefined ? undefined : await readTriageAgentExecutionTargetV1(host, preferredKey, cancellation));
    if (options.signal.aborted) return finish({ kind: 'cancelled' }, options.resumeStart);
    if (!investigationAgent && preferredKey !== undefined && agent?.status !== 'resolved') return finish({ kind: 'selectionRequired', fields: ['agentChoice'] }, options.resumeStart);
    // A subject whose folder or Agent is still open is not a complete start. The person settles it in the
    // prefilled composer (owner ruling 16:50Z); only a caller with no composer receives this typed choice.
    const unresolvedChoice: Extract<TriageSessionHandoffResultV1, { kind: 'placement_choice_required' }> | undefined = !health
        ? undefined
        : action.workspaceMode !== 'reference_only' && !health.workspace
            ? { kind: 'placement_choice_required', reason: 'ambiguous_workspace',
                candidates: [{ machine: health.machine, reachable: true }], agents: investigationAgent?.candidates ?? [] }
            : investigationAgent && agent?.status !== 'resolved'
                ? { kind: 'placement_choice_required', reason: 'agent_required',
                    candidates: [{ machine: health.machine, ...(health.workspace ? { workspace: health.workspace } : {}), reachable: true }],
                    agents: investigationAgent.candidates }
                : undefined;
    // An existing Session is not authored again; its handoff keeps the typed choice.
    if (unresolvedChoice !== undefined && input.sessionChoice.kind === 'existing') return finish(unresolvedChoice, options.resumeStart);

    if (primary !== undefined && input.sessionChoice.kind !== 'existing') {
        if (action.workspaceMode === 'pull_request' && primary.reviewWorkspace === undefined) return targetUnavailable('entry_review_workspace_missing');
        if (options.resumeStart !== undefined && options.resumeStart.state.kind !== 'single') return unavailable('scopeMismatch');
        const openNewSession = host.openNewSession;
        const executionHost: TriageConfiguredActionRunHostV1 = {
            ...host,
            executeAction: (id, value, executionOptions) => host.executeAction(id, value, { ...executionOptions, signal: options.signal }),
            selectActionInput: (request, selectionOptions) => host.selectActionInput(request, { ...selectionOptions, signal: options.signal }),
            ...(openNewSession ? { openNewSession: (request: Parameters<typeof openNewSession>[0],
                authoringOptions?: Parameters<typeof openNewSession>[1]) => openNewSession(request, { ...authoringOptions, signal: options.signal }) } : {}),
        };
        const owner = createTriageEntrySessionStartController(executionHost, { mintCreationKey: options.mintCreationKey });
        try {
            if (options.resumeStart?.state.kind === 'single') owner.restore(options.resumeStart.state);
            owner.getSnapshot().start({ ...primary, action, requestedTask: input.task, resolvedReferences: references,
                ...(forgeEvidence === undefined ? {} : { forgeEvidence }),
                ...(agent?.status === 'resolved' ? { resolvedAgentTarget: agent.agentTarget } : {}),
                ...(preferredKey === undefined ? {} : { preferredAgentTargetKey: preferredKey }) });
            const outcome = await owner.waitForSettled();
            const state = owner.getRecovery();
            const recovery = state === null ? undefined : { entries: [{ entryRef: primary.entryRef,
                sourceInstanceId: primary.sourceInstance.sourceInstanceId }], state, handoff: input };
            if (outcome.phase.kind !== 'settled') {
                if (outcome.authoringResult === 'seeded') return finish({ kind: 'composed', destination: { kind: 'newSessionDraft' } });
                if (outcome.authoringResult === 'cancelled') return finish({ kind: 'cancelled' });
                if (options.signal.aborted) return finish({ kind: 'cancelled' }, recovery);
                if (recovery === undefined && outcome.phase.kind === 'unavailable') {
                    if (delivery === 'compose' && (outcome.phase.reason === 'newSessionUnsupported' || outcome.phase.reason === 'newSessionUnavailable'))
                        return unavailable('composerUnavailable');
                    if (delivery === 'send' && outcome.phase.reason === 'newSessionUnsupported')
                        return finish({ kind: 'selectionRequired', fields: [preferredKey === undefined ? 'agentChoice' : 'sessionChoice'] });
                }
                return recovery === undefined ? targetUnavailable('entry_start_unavailable', outcome.phase.kind) : finish({ kind: 'uncertain', phase: 'create', session: null }, recovery);
            }
            const result = outcome.phase.result;
            if (result.type === 'creationPending') return finish({ kind: 'uncertain', phase: 'create', session: null }, recovery);
            if (result.type === 'creationFailed' || result.type === 'workspacePreparationFailed' || result.type === 'rejected') return targetUnavailable('entry_start_refused', result.type === 'creationFailed' ? result.type : result.reason);
            const session = result.sessionAddress;
            if (session === undefined) return unavailable('sessionUnavailable');
            if (result.type === 'linkPending' || result.delivery === 'outcomeUnknown') return finish({ kind: 'uncertain',
                phase: result.type === 'linkPending' ? 'link' : 'send', session }, recovery);
            return result.deliveryResult === undefined ? finish({ kind: 'uncertain', phase: 'send', session }, recovery)
                : finish({ kind: 'sendResult', session, result: result.deliveryResult });
        } finally { owner.dispose(); }
    }

    const existing = input.sessionChoice.kind === 'existing' ? options.session : undefined;
    let existingWorkspace: TriageEntrySessionWorkspaceFactsV1 | undefined;
    let verifiedReviewWorkspace: true | undefined;
    if (input.sessionChoice.kind === 'existing' && existing === undefined) return unavailable('sessionUnavailable');
    if (options.resumeStart !== undefined && options.resumeStart.state.kind !== 'handoff') return unavailable('scopeMismatch');
    const retained = options.resumeStart as TriageHandoffStartRecoveryV1 | undefined;
    if (health && retained?.state.input.destination.kind === 'new'
        && (retained.state.input.destination.spawn.executionTarget.serverId !== health.machine.serverId
            || retained.state.input.destination.spawn.executionTarget.machineId !== health.machine.machineId)) return unavailable('scopeMismatch');
    if (retained !== undefined && (retained.state.handoff.configuredActionId !== input.configuredActionId
        || JSON.stringify(retained.state.handoff) !== JSON.stringify(input)
        || retained.state.input.workspaceMode !== action.workspaceMode
        || (existing !== undefined && (retained.state.serverId !== existing.serverId
            || retained.state.input.destination.kind !== 'existing'
            || retained.state.input.destination.sessionId !== existing.sessionId)))) return unavailable('scopeMismatch');
    if (existing !== undefined) {
        const status = host.readSession ? null : await host.readSessionStatus?.(existing, cancellation).catch(() => null);
        const state = host.readSession ? await host.readSession(existing.sessionId, cancellation).catch(() => null)
            : status && 'session' in status ? { sessionId: status.session.id, serverId: existing.serverId,
                agentTarget: status.agentTarget, acceptedWorkspace: status.acceptedWorkspace,
                workspace: status.session.machineId ? { machineId: status.session.machineId } : undefined } : null;
        if (state == null || state.serverId !== existing.serverId || state.sessionId !== existing.sessionId) return unavailable('sessionUnavailable');
        if (health && (state.serverId !== health.machine.serverId || state.workspace?.machineId !== health.machine.machineId)) return unavailable('scopeMismatch');
        if (health?.workspace && (!state.acceptedWorkspace || !sameWorkspace(health.workspace, state.acceptedWorkspace.checkout))) return unavailable('scopeMismatch');
        if (action.workspaceMode !== 'reference_only') {
            const accepted = state.acceptedWorkspace;
            if (accepted === undefined) return targetUnavailable('existing_session_workspace_missing');
            if (repository === undefined || accepted.repository === undefined
                || !sameScmHostingRepositoryIdentity(repository, accepted.repository)) return unavailable('repositoryMismatch');
            if (suppliedWorkspace !== undefined && !sameWorkspace(suppliedWorkspace, accepted.checkout)) return unavailable('scopeMismatch');
            if (action.workspaceMode === 'pull_request') {
                const preparation = primary?.reviewWorkspace?.preparation;
                if (primary === undefined || preparation === undefined) return targetUnavailable('existing_session_review_preparation_missing');
                const verified = TriageVerifyExistingReviewWorkspaceResultV1Schema.safeParse(await host.executeAction(
                    { pluginId: 'happier.triage', localId: TRIAGE_VERIFY_EXISTING_REVIEW_WORKSPACE_ACTION_LOCAL_ID_V1 }, { v: 1, session: existing,
                        entryRef: primary.entryRef, sourceInstanceId: primary.sourceInstance.sourceInstanceId,
                        lastKnownLocator: preparation.lastKnownLocator, observed: preparation.observed }, cancellation).catch(() => null));
                if (!verified.success || verified.data.kind !== 'verified' || !sameWorkspace(verified.data.checkout, accepted.checkout)) return targetUnavailable('existing_session_review_verification_failed');
                verifiedReviewWorkspace = true;
            }
            existingWorkspace = { kind: 'selectedProject', directory: accepted.checkout.rootPath };
        }
        const currentAgent = state.agentTarget;
        if (preferredKey !== undefined && (agent?.status !== 'resolved' || currentAgent === undefined
            || currentAgent.identity.pluginId !== agent.agentTarget.identity.pluginId
            || currentAgent.identity.localId !== agent.agentTarget.identity.localId
            || currentAgent.definitionId !== agent.agentTarget.definitionId)) return unavailable('agentMismatch');
        if (delivery === 'compose') {
            if (host.readComposer === undefined || host.applyComposer === undefined) return unavailable('composerUnavailable');
            const ref = { kind: 'session' as const, sessionId: existing.sessionId };
            const read = await host.readComposer(ref, cancellation).catch(() => null);
            if (read?.status !== 'ready' || !read.snapshot.state.editable) return unavailable('composerUnavailable');
            const plan = planTriageActionDeliveryV1({ delivery: 'compose', promptText, entries: options.entries, attachments: attachment });
            if (plan.kind !== 'compose') return unavailable('evidenceInvalid');
            const operations: ComposerTransactionV1['operations'][number][] = [
                ...(plan.text === undefined ? [] : [{ kind: 'text.insert' as const,
                    position: { offset: read.snapshot.text.length }, text: `${read.snapshot.text.length === 0 ? '' : '\n\n'}${plan.text}` }]),
                ...plan.attachments.map((item) => ({ kind: 'attachment.add' as const, ...item })),
            ];
            const applied = await host.applyComposer(ref, { expectedRevision: read.snapshot.revision, operations }, cancellation).catch(() => null);
            return applied?.status === 'applied'
                ? finish({ kind: 'composed', destination: { kind: 'existing', session: existing } })
                : unavailable('composerUnavailable');
        }
    }

    let custody: TriageHandoffStartRecoveryV1;
    if (retained !== undefined) custody = retained;
    else {
        // An admitted existing Session already owns its placement. Do not read
        // an unrelated project census just to deliver reference-only input.
        const placement = health ? resolveTriageActionPlacementV1({ workspaceMode: action.workspaceMode,
            profile: { placement: { fixed: health.machine, ...(health.workspace ? { directory: health.workspace.rootPath } : {}) } },
            projects: [], registryComplete: true }) : existing === undefined
            ? registry === undefined
                ? await readTriageActionPlacementV1(host, action, references.profile?.preferences, repository, cancellation)
                : resolveTriageActionPlacementV1({ workspaceMode: action.workspaceMode, profile: references.profile?.preferences,
                    forge: repository, projects: registry.status === 'read' ? registry.projects : [],
                    registryComplete: registry.status === 'read' && registry.complete })
            : resolveTriageActionPlacementV1({ workspaceMode: action.workspaceMode, projects: [], registryComplete: true });
        const execution = readTriageActionExecutionPlacementV1(placement);
        const candidates = projectTriageActionPlacementCandidatesV1({ ...placement,
            ...(registry?.status === 'read' ? { availableCandidates: registry.projects } : {}),
        });
        const checkout = resolveTriageActionCheckoutV1(action.workspaceMode, references.profile?.preferences);
        const profile = action.profileId === null ? {} : { profileId: action.profileId };
        const directSettlement: unknown = existing !== undefined || delivery === 'compose' || unresolvedChoice !== undefined ? undefined
            : health && !health.workspace && action.workspaceMode === 'reference_only' && agent?.status === 'resolved'
                ? { executionTarget: health.machine, agentTarget: agent.agentTarget, directory: { kind: 'managed' }, ...profile }
                : execution?.directory !== undefined && agent?.status === 'resolved' && (checkout === 'none' || checkout === 'reuseWorkspace')
                    ? { executionTarget: execution.executionTarget, agentTarget: agent.agentTarget,
                        directory: { kind: 'path', path: execution.directory }, ...profile }
                    : undefined;
        // Compose is authoring, and so is a send whose start is not complete
        // (owner ruling "Agent actions: one shared flow", 2026-11-07): the
        // prefilled New Session composer owns every remaining choice.
        if (existing === undefined && (delivery === 'compose'
            || (directSettlement === undefined && action.workspaceMode !== 'pull_request'))) {
            const composed = await requestTriageNewSessionAuthoringV1(host, {
                entries: options.entries, attachments: attachment, promptText, profileId: action.profileId,
                ...(agent?.status === 'resolved' ? { agentTarget: agent.agentTarget } : {}),
                checkoutIntent: checkout, placement: execution, candidates, signal: options.signal,
                ...(health && !health.workspace && action.workspaceMode === 'reference_only'
                    ? { directoryIntent: { kind: 'managed' as const } } : {}),
            });
            return composed.status === 'seeded' ? finish({ kind: 'composed', destination: { kind: 'newSessionDraft' } })
                : composed.status === 'cancelled' ? finish({ kind: 'cancelled' })
                // A caller with no composer (agent, MCP, CLI) keeps its typed choice request.
                : composed.status === 'unsupported' && unresolvedChoice !== undefined ? finish(unresolvedChoice, options.resumeStart)
                : composed.status === 'unsupported' && delivery !== 'compose'
                    ? finish({ kind: 'selectionRequired', fields: [preferredKey === undefined ? 'agentChoice' : 'sessionChoice'] })
                    : unavailable('composerUnavailable');
        }
        if (existing === undefined && action.workspaceMode === 'pull_request') return targetUnavailable('subject_review_workspace_missing');
        let destination: TriageHandoffStartRecoveryV1['state']['input']['destination'];
        if (existing !== undefined) destination = { kind: 'existing', sessionId: existing.sessionId };
        else {
            const projected = projectTriageNewSessionDestinationV1({ workspaceMode: action.workspaceMode,
                creationKey: (options.mintCreationKey ?? mintTriageOpaqueIdV1)(), settlement: directSettlement,
                ...(action.profileId === null ? {} : { profileId: action.profileId }), placementCandidates: candidates });
            if (projected.status !== 'settled') return targetUnavailable('new_session_destination_refused', projected.reason);
            destination = projected.destination;
            if (health && (destination.kind !== 'new' || destination.spawn.executionTarget.serverId !== health.machine.serverId
                || destination.spawn.executionTarget.machineId !== health.machine.machineId)) return unavailable('scopeMismatch');
        }
        custody = { entries: options.entries.map((entry) => ({ entryRef: entry.entryRef, sourceInstanceId: entry.sourceInstance.sourceInstanceId })),
            state: { kind: 'handoff', handoff: input,
                serverId: destination.kind === 'new' ? destination.spawn.executionTarget.serverId : existing!.serverId,
                input: { workspaceMode: action.workspaceMode,
                    ...(primary === undefined ? nativeSubject ?? {} : { entryRef: primary.entryRef, display: primary.display }), destination,
                    delivery: { kind: 'send', text: promptText ?? undefined, returnResult: true,
                        idempotencyKey: (options.mintCreationKey ?? mintTriageOpaqueIdV1)(),
                        attachments: options.entries.map((entry) => ({ entryRef: entry.entryRef, display: entry.display,
                            sourceInstanceId: entry.sourceInstance.sourceInstanceId, title: entry.presentation.label })),
                        ...(forgeEvidence === undefined ? {} : { forgeEvidence }) } } } };
    }
    const invocation = custody.state.input;
    let deliveryFailure: TriageSessionDeliveryFailureDetailV1 | undefined;
    let effectPhase: 'create' | 'link' | 'send' = invocation.destination.kind === 'new' ? 'create' : 'link';
    let knownSession: ActionSessionAddressV1 | null = invocation.destination.kind === 'existing'
        ? { serverId: custody.state.serverId, sessionId: invocation.destination.sessionId }
        : custody.state.pending?.phase === 'linkPending' || custody.state.pending?.phase === 'openPending'
            ? { serverId: custody.state.serverId, sessionId: custody.state.pending.sessionId } : null;
    // The canonical host Action executor validates each generated Action result at this RPC boundary.
    const execute: TriageSessionActionInvokerV1 = async <TActionId extends TriageSessionActionIdV1>(
        id: TActionId, value: PluginActionInputById[TActionId], executionOptions?: Parameters<TriageSessionActionInvokerV1>[2],
    ): Promise<PluginActionResultById[TActionId]> => {
        if (id === 'session.message.send') effectPhase = 'send';
        const sendConfiguredFix = id === 'session.message.send' && input.task === 'fix' && primary?.workflowSubject === 'pullRequest';
        let result: unknown;
        if (sendConfiguredFix) {
            const unavailableFix = () => new PluginError({ code: 'triage_configured_fix_unavailable',
                message: 'Retain this Fix input and retry its current PR watch.', retryable: true });
            const preparation = primary.reviewWorkspace?.preparation;
            const pullRequest = parseGithubConversationUrlV1(primary.display.locator.webUrl ?? '');
            if (!knownSession || !preparation || pullRequest?.kind !== 'githubPullRequest'
                || !('message' in value) || !('idempotencyKey' in value) || typeof value.idempotencyKey !== 'string') throw unavailableFix();
            const watch = { pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1 };
            const watchOptions = { signal: options.signal, sessionAddress: knownSession };
            const watchState = SessionPullRequestWatchReadResultV1Schema.parse(await host.executeAction(watch,
                { kind: 'get', sessionId: knownSession.sessionId }, watchOptions));
            const bindings = watchState.kind === 'ready' && watchState.sessionId === knownSession.sessionId
                ? watchState.bindings.filter(binding => binding.link.number === pullRequest.number
                    && sameScmHostingRepositoryIdentity(
                        normalizeScmHostingRepositoryIdentity({ kind: 'github', deployment: 'https://github.com', repository: binding.link.repository }),
                        normalizeScmHostingRepositoryIdentity({ kind: 'github', deployment: 'https://github.com', repository: pullRequest.repository }))) : [];
            const binding = bindings.length === 1 ? bindings[0] : undefined;
            if (!binding || options.signal.aborted) throw unavailableFix();
            const request = SessionPullRequestConfiguredFixInputV1Schema.parse({ kind: 'deliverConfiguredFix', sessionId: knownSession.sessionId,
                bindingId: binding.bindingId, expectedRevision: binding.revision,
                pullRequest: { repository: binding.link.repository, number: binding.link.number }, expectedHeadSha: preparation.observed.headSha,
                delivery: { idempotencyKey: value.idempotencyKey, text: value.message,
                    ...('attachments' in value && value.attachments ? { attachments: value.attachments } : {}) } });
            const delivered = SessionPullRequestConfiguredFixResultV1Schema.parse(await host.executeAction(watch, request, watchOptions));
            if (delivered.kind !== 'configuredFixResult') throw unavailableFix();
            result = delivered.result;
        } else result = await host.executeAction(id, value as unknown as JsonValue, { ...executionOptions, signal: options.signal });
        if (id === 'session.spawn_new' && typeof result === 'object' && result !== null && 'type' in result && result.type === 'success'
            && 'sessionId' in result && typeof result.sessionId === 'string') knownSession = { serverId: custody.state.serverId, sessionId: result.sessionId };
        return result as PluginActionResultById[TActionId];
    };
    const deps = { execute, signal: options.signal,
        onDeliveryFailure: (detail: TriageSessionDeliveryFailureDetailV1) => { deliveryFailure = detail; },
        linkSession: async (value: Parameters<NonNullable<Parameters<typeof startEntrySession>[0]['linkSession']>>[0]) => {
            effectPhase = 'link';
            const result = TriageLinkEntryToSessionActionResultV1Schema.parse(await host.executeAction(
                { pluginId: 'happier.triage', localId: TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1 }, { v: 1, ...value }, cancellation));
            return result;
        } };
    let result: TriageEntrySessionStartResultV1;
    try {
        if (custody.state.pending !== undefined && invocation.destination.kind === 'new') {
            const pending = custody.state.pending;
            const materialization = invocation.destination.materialization;
            if (materialization.kind === 'reviewWorkspace') return targetUnavailable('retained_review_workspace_unsupported');
            const workspace = materializationWorkspaceFacts(materialization);
            const phase: TriageEntrySessionPendingPhaseV1 = pending.phase === 'creationPending'
                ? { type: 'creationPending', creationKey: invocation.destination.creationKey,
                    spawn: invocation.destination.spawn, directory: materialization.directory, workspace }
                : { type: pending.phase, sessionId: pending.sessionId, disposition: pending.disposition,
                    workspace, ...(pending.delivery === undefined ? {} : { settledDelivery: pending.delivery }) };
            result = await resumeEntrySessionStart(deps, { entryRef: invocation.entryRef, display: invocation.display,
                pending: phase, serverId: custody.state.serverId, delivery: invocation.delivery, finalOpen: 'suppressed' });
        } else result = await startEntrySession(deps, { ...invocation,
            destination: invocation.destination.kind === 'existing' ? { ...invocation.destination, serverId: custody.state.serverId,
                ...(existingWorkspace === undefined ? {} : { workspace: existingWorkspace }),
                ...(verifiedReviewWorkspace === undefined ? {} : { verifiedReviewWorkspace }) } : invocation.destination,
            finalOpen: 'suppressed' });
    } catch {
        return finish({ kind: 'uncertain', phase: effectPhase, session: knownSession }, { ...custody,
            state: { ...custody.state, uncertainPhase: effectPhase } });
    }
    if (result.type === 'creationPending') return finish({ kind: 'uncertain', phase: 'create', session: null }, {
        ...custody, state: { ...custody.state, pending: { phase: 'creationPending' }, uncertainPhase: 'create' } });
    if (health && result.type === 'creationFailed' && (result.failureCode === 'target_unavailable'
        || result.failureCode === 'machine_offline' || result.failureCode === 'incompatible_target'
        || result.failureCode === 'agent_cli_missing' || result.failureCode === 'agent_signed_out'
        || result.failureCause === 'agent_startup_transport_failed')) {
        const agentRequired = result.failureCode === 'agent_cli_missing' || result.failureCode === 'agent_signed_out'
            || result.failureCause === 'agent_startup_transport_failed';
        if (!agentRequired) return finish({ ...projectTriageUnavailableInvestigationPlacementV1(health),
            agents: investigationAgent?.candidates ?? [] });
        return finish({ kind: 'placement_choice_required', reason: 'agent_required',
            candidates: [{ machine: health.machine, ...(health.workspace ? { workspace: health.workspace } : {}), reachable: agentRequired }],
            agents: investigationAgent?.candidates ?? [] });
    }
    if (result.type === 'creationFailed' || result.type === 'rejected' || result.type === 'workspacePreparationFailed') return targetUnavailable('session_start_refused', result.type === 'creationFailed' ? result.failureCause ?? result.failureCode : result.reason);
    const session = { serverId: custody.state.serverId, sessionId: result.sessionId };
    if (result.type === 'linkPending' || result.delivery === 'outcomeUnknown') return finish({ kind: 'uncertain',
        phase: result.type === 'linkPending' ? 'link' : 'send', session }, { ...custody,
        state: { ...custody.state, pending: { phase: result.type === 'linkPending' ? 'linkPending' : 'openPending',
            sessionId: result.sessionId, disposition: result.disposition }, uncertainPhase: result.type === 'linkPending' ? 'link' : 'send',
            ...(deliveryFailure === undefined ? {} : { detail: deliveryFailure }) } });
    if (result.deliveryResult === undefined) return finish({ kind: 'uncertain', phase: 'send', session }, custody);
    return finish({ kind: 'sendResult', session, result: SessionMessageSendResultV1ProtocolSchema.parse(result.deliveryResult) });
}

export type TriageConfiguredActionRunHostV1 = TriageBulkHostV1 & TriageStartHostV1;
export type TriageConfiguredActionRunRequestV1 = Readonly<{
    actionId: string;
    entries: TriageBulkSessionsRequestV1['entries'];
    /** Original addressed identities, including unavailable/refused rows, on retained continuation. */
    selectedEntries?: TriageLegacyConfiguredStartRecoveryV1['entries'];
    unavailableKeys?: readonly string[];
    destination: 'single' | TriageBulkSessionsRequestV1['destination'];
    settlements?: readonly unknown[];
    reviewChoices?: TriagePullRequestReviewChoiceV1;
    resumeReview?: TriageRunConfiguredActionInputV1['resumeReview'];
    resumeStart?: TriageLegacyConfiguredStartRecoveryV1;
}>;

export async function runTriageConfiguredActionV1(
    host: TriageConfiguredActionRunHostV1,
    request: TriageConfiguredActionRunRequestV1,
    options?: Readonly<{ signal?: AbortSignal; mintCreationKey?: () => string }>,
): Promise<TriageRunConfiguredActionResultV1> {
    if (options?.signal?.aborted) return { v: 1, status: 'cancelled' };
    const refuse = (reason: string): TriageRunConfiguredActionResultV1 => ({
        v: 1, status: 'unavailable', reason,
        ...(request.resumeStart === undefined ? {} : {
            recovery: request.resumeStart,
            ...(request.resumeStart.state.kind === 'bulk' ? {
                results: request.resumeStart.state.units.map((unit) => unit.result),
                refusals: request.resumeStart.state.refusals,
                unavailableKeys: request.resumeStart.state.unavailableKeys,
            } : {}),
        }),
        ...(request.resumeReview === undefined ? {} : {
            result: request.resumeReview.result, reviewInstructions: request.resumeReview.instructions,
        }),
    });
    const resolved = await resolveTriageConfiguredActionForExecutionV1(host, request.actionId, undefined,
        options?.signal === undefined ? undefined : { signal: options.signal });
    if (options?.signal?.aborted) return { v: 1, status: 'cancelled' };
    if (resolved.status !== 'resolved') return refuse(resolved.reason);
    const action = resolved.action;
    const selectedEntries = request.selectedEntries ?? request.entries.map((entry) => ({ entryRef: entry.entryRef, sourceInstanceId: entry.sourceInstance.sourceInstanceId }));
    const recovery = request.resumeStart;
    if (recovery !== undefined) {
        const matchesEntries = recovery.entries.length === selectedEntries.length && recovery.entries.every((retained, index) => {
            const current = selectedEntries[index];
            return current !== undefined && triageEntryRowKey(retained.entryRef) === triageEntryRowKey(current.entryRef)
                && retained.sourceInstanceId === current.sourceInstanceId;
        });
        const state = recovery.state;
        const matchesStart = state.kind === 'single'
            ? request.destination === 'single' && state.actionId === action.actionId
                && selectedEntries.length === 1
                && triageEntryRowKey(state.input.entryRef) === triageEntryRowKey(selectedEntries[0]!.entryRef)
            : request.destination === state.destination && state.action.actionId === action.actionId;
        if (!matchesEntries || !matchesStart || request.resumeReview !== undefined) {
            return refuse('startContinuationMismatch');
        }
    }
    if (request.destination === 'single' && recovery === undefined && request.resumeReview === undefined) {
        const entry = request.entries.length === 1 ? request.entries[0] : undefined;
        if (entry === undefined) return refuse('singleEntryRequired');
        if (entry.workflowSubject === null || planTriageOfferedActionsV1([action], entry.workflowSubject).length === 0) {
            return refuse('actionInapplicable');
        }
    }
    const finishReview = async (pending: TriagePendingPullRequestReviewV1, result: TriageStartEntrySessionResultV1): Promise<TriageRunConfiguredActionResultV1> => {
        const basis = { v: 1 as const, result, reviewInstructions: pending.instructions };
        if (request.reviewChoices === undefined) return { ...basis, status: 'awaitingReview' };
        const continuation = await continueTriagePullRequestReviewV1(host, pending, request.reviewChoices, options);
        if (continuation.kind !== 'settled') return { ...basis, status: continuation.kind === 'unknown'
            ? 'reviewUnknown' : continuation.kind === 'cancelled' ? 'awaitingReview' : 'reviewRefused' };
        const reviewResult = continuation.result;
        if (reviewResult.status !== 'started') return { ...basis, status: 'reviewRefused', reviewResult };
        if (reviewResult.failedEngineIds.length > 0) return { ...basis, status: 'reviewPartial', reviewResult };
        const opened = await openLinkedSession({ execute: async (id, input, cancellation) => host.executeAction(id, input, cancellation),
            sessionId: pending.sessionId, signal: options?.signal });
        return { ...basis, status: 'reviewStarted', reviewResult, sessionOpen: opened.status };
    };
    if (request.resumeReview !== undefined) {
        const { result, instructions } = request.resumeReview;
        const entry = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
        if (request.destination !== 'single' || action.target.kind !== 'reviewStart'
            || action.workspaceMode !== 'pull_request' || entry === undefined
            || (result.type !== 'linked' && result.type !== 'opened') || result.review === undefined
            || triageEntryRowKey(result.review.entryRef) !== triageEntryRowKey(entry.entryRef)
            || result.review.instance.instance.sourceInstanceId !== entry.sourceInstanceId) {
            return refuse('reviewContinuationMismatch');
        }
        // Retained facts are input, not authority: the incumbent final Review Action
        // rereads the source/workspace and admits the canonical review.start request.
        return finishReview({ actionId: action.actionId, sessionId: result.sessionId, review: result.review, instructions }, result);
    }
    if (request.destination === 'single') {
        const entry = request.entries.length === 1 ? request.entries[0] : undefined;
        if (entry === undefined) return refuse('singleEntryRequired');
        const singleHost: TriageStartHostV1 = options?.signal === undefined ? host : {
            ...host,
            executeAction: (id, input, executionOptions) => host.executeAction(id, input, { ...executionOptions, signal: options.signal }),
            selectActionInput: (input, selectionOptions) => host.selectActionInput(input, { ...selectionOptions, signal: options.signal }),
        };
        const owner = createTriageEntrySessionStartController(singleHost, options);
        try {
            if (recovery?.state.kind === 'single') owner.restore(recovery.state);
            owner.getSnapshot().start({ ...entry, action, ...(request.settlements?.[0] === undefined ? {} : { settlement: request.settlements[0] }) });
            const outcome = await owner.waitForSettled();
            const state = owner.getRecovery();
            const retained = state === null ? {} : { recovery: { entries: selectedEntries, state } };
            if (outcome.phase.kind === 'settled' && outcome.review !== null) {
                return finishReview(outcome.review, outcome.phase.result);
            }
            if (outcome.phase.kind === 'settled') return {
                v: 1, status: 'single', result: outcome.phase.result,
                ...retained,
                ...(outcome.review === null ? {} : { reviewInstructions: outcome.review.instructions }),
            };
            if (options?.signal?.aborted) return { v: 1, status: 'cancelled', ...retained };
            if (outcome.phase.kind === 'unavailable') return { v: 1, status: 'unavailable', reason: outcome.phase.reason, ...retained };
            return { v: 1, status: 'seeded' };
        } finally { owner.dispose(); }
    }
    const owner = createTriageBulkEntrySessionsController(host, options);
    const cancel = () => owner.getSnapshot().cancel();
    options?.signal?.addEventListener('abort', cancel, { once: true });
    try {
        if (recovery?.state.kind === 'bulk') {
            if (!owner.restore(recovery.state, request.entries)) return refuse('startContinuationMismatch');
            owner.getSnapshot().retry();
        } else owner.getSnapshot().run({ action, entries: request.entries, destination: request.destination, unavailableKeys: request.unavailableKeys,
            settlementForEntries: (entries) => request.settlements?.[
                request.destination === 'oneSessionForAllEntries' ? 0
                    : request.entries.findIndex((candidate) => candidate.key === entries[0]?.key)
            ],
        });
        const { phase } = await owner.waitForSettled();
        const state = owner.getRecovery();
        if (phase.kind === 'settled') return {
            v: 1, status: 'bulk', unavailableKeys: [...phase.unavailableKeys],
            refusals: phase.refusals.map((refusal) => ({ entryRef: refusal.entry.entryRef, reason: refusal.reason })),
            results: phase.results.map(projectTriageConfiguredBulkResultV1),
            ...(state === null ? {} : { recovery: { entries: selectedEntries, state } }),
        };
        if (phase.kind === 'seeded') return { v: 1, status: 'seeded', entries: [...phase.outcomes],
            refusals: phase.refusals.map((refusal) => ({ entryRef: refusal.entry.entryRef, reason: refusal.reason })),
        };
        if (phase.kind === 'unavailable') return refuse(phase.reason);
        return { v: 1, status: 'cancelled' };
    } finally {
        options?.signal?.removeEventListener('abort', cancel);
        owner.dispose();
    }
}
