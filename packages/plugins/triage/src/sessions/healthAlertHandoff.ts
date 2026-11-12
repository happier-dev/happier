import type { TriageSessionHandoffInputV1, TriageSessionHandoffResultV1 } from '@happier-dev/triage-protocol/v1';
import { readTriageProjectRegistryV1, type TriageProjectRegistryReadV1 } from './projectCandidates.js';
import type { TriageProjectCandidateV1 } from './launchPlacement.js';
import type { PluginActionInputById, PluginActionResultById, PluginClientActionUi } from '@happier-dev/plugin-sdk/actions';
import type { TriageActionResolutionHostV1 } from './actionResolution.js';
import type { SessionInputForgeEvidenceV1 } from '@happier-dev/plugin-sdk/sessions';
import { deploymentRevisionShortLabelV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { readDeploymentReceiptArtifactV1, type DeploymentContentV1 } from '@happier-dev/deployment-protocol/v1';
import { readDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import {
    ProtocolArtifactGetOutputV1Schema,
    ProtocolServiceHealthNoticeSourceV1Schema, ProtocolServiceHealthNoticePageV1Schema,
    readOwnedNoticeArtifactV1, pluginJsonValuesEqual,
} from '@happier-dev/plugin-sdk/protocol';

type Machine = { serverId: string; machineId: string };
type Workspace = NonNullable<Extract<TriageSessionHandoffInputV1['context'], { kind: 'failure' }>['workspace']>;
type PlacementChoice = Extract<TriageSessionHandoffResultV1, { kind: 'placement_choice_required' }>;
type UnresolvedPlacement = PlacementChoice & { machine?: Machine; registry?: TriageProjectRegistryReadV1 };
type InvestigationRead = null | (UnresolvedPlacement & { evidence: SessionInputForgeEvidenceV1['items'][number] }) | {
    kind: 'ready'; machine: Machine; workspace?: Workspace; registry?: TriageProjectRegistryReadV1;
    evidence: SessionInputForgeEvidenceV1['items'][number];
};

/** Re-read the exact private Artifact and derive placement from its owner.
 * Session creation owns launch admission; notice text grants no Machine access. */
export async function readTriageHealthAlertHandoffV1(
    host: TriageActionResolutionHostV1 & Readonly<{
        context(options?: Parameters<PluginClientActionUi['context']>[0]): Promise<
            Pick<Awaited<ReturnType<PluginClientActionUi['context']>>, 'accountScope'>>;
    }>,
    input: TriageSessionHandoffInputV1,
    signal: AbortSignal,
): Promise<InvestigationRead> {
    if (input.task !== 'investigate') return null;
    if (input.context.kind === 'failure') return readFailureSubject(host, input.context, input.evidence, signal);
    if (input.context.kind !== 'healthAlert') return null;
    const context = input.context;
    if (input.evidence.some(evidence => evidence.kind !== 'alert' || !pluginJsonValuesEqual(evidence.notice, context.notice))) return null;
    const options = { signal };
    const scope = (await host.context(options)).accountScope;
    const targetServerId = context.target.kind === 'machine' || context.target.page === 'machine_service'
        ? context.target.machine.serverId : context.target.environment.serverId;
    if (signal.aborted || !scope || scope.serverId !== targetServerId) return null;
    const read = ProtocolArtifactGetOutputV1Schema.safeParse(await host.executeAction('artifact.get', { artifactId: context.notice.artifactId }, options));
    if (signal.aborted || !read.success || !read.data.artifact || read.data.artifact.artifactId !== context.notice.artifactId) return null;
    const notice = readOwnedNoticeArtifactV1(read.data.artifact, scope.accountId);
    if (!notice) return null;
    // Keep capture time distinct from occurrence time. A notice may not retain
    // the latter; the investigator must not substitute current health for it.
    const evidence: SessionInputForgeEvidenceV1['items'][number] = {
        source: { kind: 'alert', label: 'Health notice reference' }, author: { kind: 'process' },
        text: JSON.stringify({ notice: context.notice, recordedAt: read.data.artifact.createdAt,
            artifactRevision: read.data.artifact.revision,
            ...('platformTransition' in notice && notice.platformTransition ? { platformTransition: notice.platformTransition } : {}),
            read: { actionId: 'artifact.get', input: { artifactId: context.notice.artifactId } } }),
    };
    const selected = context.machine ?? (context.workspace ? {
        serverId: context.workspace.serverId, machineId: context.workspace.machineId,
    } : undefined);
    if (selected && (selected.serverId !== scope.serverId || context.workspace
        && (context.workspace.serverId !== selected.serverId || context.workspace.machineId !== selected.machineId))) return null;
    if (context.notice.source.topic === 'resource_limit') {
        // readOwnedNoticeArtifactV1 already admitted the canonical vitals payload.
        // Its Machine is evidence identity, never a persisted service-health page.
        const payload = notice.notice;
        if (context.target.kind !== 'machine' || !payload || typeof payload !== 'object'
            || !('topic' in payload) || payload.topic !== 'resource_limit'
            || !('machineId' in payload) || payload.machineId !== context.target.machine.machineId) return null;
        const machine = selected ?? context.target.machine;
        if (signal.aborted) return null;
        return { kind: 'ready' as const, machine, workspace: context.workspace, evidence };
    }
    const source = ProtocolServiceHealthNoticeSourceV1Schema.safeParse(notice.source);
    const page = ProtocolServiceHealthNoticePageV1Schema.safeParse(notice.page);
    if (!source.success || !page.success || !pluginJsonValuesEqual(source.data, context.notice.source)
        || !pluginJsonValuesEqual(page.data, context.target)) return null;
    let machine = selected;
    let placement: Awaited<ReturnType<typeof resolveInvestigationPlacement>> | undefined;
    if (page.data.page === 'environment') {
        let sourceId: string | undefined;
        if (!selected) {
            const environment = await host.executeAction('deployments.environments.get', {
                serverId: scope.serverId, environmentId: page.data.environment.environmentId,
            }, options) as PluginActionResultById['deployments.environments.get'];
            if (!environment.ok || environment.environment.id !== page.data.environment.environmentId
                || environment.environment.projectSourceId !== page.data.environment.projectSourceId) return null;
            sourceId = environment.environment.projectSourceId;
            machine = environment.environment.controllerMachineId
                ? { serverId: scope.serverId, machineId: environment.environment.controllerMachineId } : undefined;
        }
        placement = await resolveInvestigationPlacement(host, scope.serverId, machine, context.workspace,
            sourceId, signal);
        if (!placement) return null;
        if (placement.kind !== 'ready') return { ...placement, evidence };
        machine = placement.machine;
    } else {
        machine ??= page.data.machine;
    }
    if (signal.aborted) return null;
    return { kind: 'ready' as const, machine: machine!, workspace: placement?.kind === 'ready' ? placement.workspace : context.workspace,
        ...(placement?.kind === 'ready' ? { registry: placement.registry } : {}), evidence };
}

/** The configured handoff owns placement for notices and native failure records alike. */
async function readFailureSubject(
    host: Parameters<typeof readTriageHealthAlertHandoffV1>[0],
    context: Extract<TriageSessionHandoffInputV1['context'], { kind: 'failure' }>,
    evidence: TriageSessionHandoffInputV1['evidence'],
    signal: AbortSignal,
): Promise<InvestigationRead> {
    const subject = context.subject;
    if (evidence.some(item => item.kind !== 'failure' || !pluginJsonValuesEqual(item.subject, subject))) return null;
    const scope = (await host.context({ signal })).accountScope;
    const serverId = subject.kind === 'managedMachineOperation' || subject.kind === 'backupRun' ? subject.operation.serverId
        : subject.kind === 'service' ? subject.target.page === 'machine_service' ? subject.target.machine.serverId
            : subject.target.environment.serverId : subject.serverId;
    if (signal.aborted || !scope || scope.serverId !== serverId) return null;
    const selected = context.machine ?? (context.workspace ? { serverId: context.workspace.serverId, machineId: context.workspace.machineId } : undefined);
    if (selected && (selected.serverId !== serverId || context.workspace
        && (context.workspace.serverId !== selected.serverId || context.workspace.machineId !== selected.machineId))) return null;
    // The host Action dispatcher admits and validates these DTOs. These are
    // authenticated read results, not caller-authored evidence or authority.
    const read = async <K extends 'artifact.get' | 'deployments.receipts.get' | 'deployments.environments.get' | 'deployments.domains.get' | 'action.operations.get' | 'workflow.run.get'>(
        id: K, value: PluginActionInputById[K],
    ) => await host.executeAction(id, value as JsonReadInput, { signal }) as PluginActionResultById[K];
    let affected: { serverId: string; machineId: string } | undefined;
    let workspace = context.workspace;
    let projectSourceId: string | undefined;
    const environmentPlacement = async (environmentId: string) => {
        const result = await read('deployments.environments.get', { serverId, environmentId });
        if (!result.ok || result.environment.id !== environmentId) return false;
        projectSourceId = result.environment.projectSourceId;
        if (!affected && result.environment.controllerMachineId) affected = { serverId, machineId: result.environment.controllerMachineId };
        return true;
    };
    let reference: { actionId: string; input: JsonReadInput; retained?: object };
    // The receipt's own title for the composer chip, as its page says it; unknown → the generic reference label.
    let receiptTitle: string | undefined;
    let receiptFailure: DeploymentContentV1['failure'];
    switch (subject.kind) {
        case 'workflowRun': {
            const address = { runId: subject.runId };
            const result = await read('workflow.run.get', address);
            if (result.run.id !== subject.runId) return null;
            affected = { serverId, machineId: result.run.machineId };
            const project = result.acceptedContext.workspaceTarget.project;
            if (!workspace && project.workspaceRefId && (!selected || selected.machineId === project.machineId)) {
                workspace = { serverId, machineId: project.machineId, workspaceId: project.workspaceRefId, rootPath: project.directory };
            }
            reference = { actionId: 'workflow.run.get', input: address, retained: {
                state: result.run.state, revision: result.run.revision,
                createdAt: result.run.createdAt, finishedAt: result.run.finishedAt,
            } };
            break;
        }
        case 'deploymentReceipt': {
            const { kind: _kind, ...address } = subject;
            const result = await read('deployments.receipts.get', address);
            if (!result.ok || result.deployment.id !== subject.deploymentId || result.deployment.environmentId !== subject.environmentId) return null;
            const controller = result.deployment.acceptedExecution?.controller;
            if (controller) affected = { serverId, machineId: controller.machineId };
            if (!selected && !await environmentPlacement(subject.environmentId)) return null;
            const receipt = result.deployment;
            const { artifact } = await read('artifact.get', {
                artifactId: receipt.contentArtifactId,
            });
            if (signal.aborted) return null;
            const opened = readDeploymentReceiptArtifactV1(receipt, artifact);
            const source = opened.ok ? opened.content.sourceIntent : undefined;
            receiptFailure = opened.ok ? opened.content.failure : undefined;
            receiptTitle = failedReceiptTitle(receipt.operation, receipt.state, source ? deploymentRevisionShortLabelV1(source) : undefined);
            reference = { actionId: 'deployments.receipts.get', input: address, retained: {
                state: receipt.state, receiptRevision: receipt.revision, actionOperationId: receipt.actionOperationId,
                requestedAtMs: receipt.requestedAtMs, startedAtMs: receipt.startedAtMs, settledAtMs: receipt.settledAtMs,
                predecessorDeploymentId: receipt.predecessorDeploymentId,
                ...(source ? { source: source.kind === 'repository'
                    ? { kind: source.kind, projectSourceId: source.projectSourceId, sourceRevision: source.sourceRevision, sha: source.sha }
                    : { kind: source.kind, contentRevision: source.contentRevision, composeDigest: source.composeDigest } } : {}),
            } };
            break;
        }
        case 'managedMachineOperation': case 'backupRun': {
            const result = await read('action.operations.get', subject.operation);
            if (result.kind !== 'found' || result.operation.operationId !== subject.operation.operationId
                || result.operation.scope.accountId !== scope.accountId || result.operation.scope.machineId !== subject.operation.machineId) return null;
            affected = { serverId, machineId: subject.operation.machineId };
            reference = { actionId: 'action.operations.get', input: subject.operation, retained: {
                createdAt: result.operation.createdAt, startedAt: result.operation.startedAt, settledAt: result.operation.settledAt,
            } };
            break;
        }
        case 'service': {
            const target = subject.target;
            if (target.page === 'machine_service') {
                affected = target.machine;
                reference = { actionId: 'machines.services.detail', input: { ...target.machine, serviceId: target.service.serviceId } };
            } else {
                const result = await read('deployments.environments.get', { serverId, environmentId: target.environment.environmentId });
                if (!result.ok || result.environment.id !== target.environment.environmentId
                    || result.environment.projectSourceId !== target.environment.projectSourceId
                    || result.environment.runtimeTargetLinkId !== target.targetLinkId) return null;
                projectSourceId = result.environment.projectSourceId;
                if (result.environment.controllerMachineId) affected = { serverId, machineId: result.environment.controllerMachineId };
                reference = { actionId: 'deployments.environments.get', input: { serverId, environmentId: target.environment.environmentId } };
            }
            break;
        }
        case 'domain': {
            const { kind: _kind, ...address } = subject;
            const result = await read('deployments.domains.get', address);
            if (!result.ok || result.domain.id !== subject.domainId || result.domain.environmentId !== subject.environmentId) return null;
            if (!selected && !await environmentPlacement(subject.environmentId)) return null;
            reference = { actionId: 'deployments.domains.get', input: address };
            break;
        }
        case 'deploymentEnvironment': {
            if (!await environmentPlacement(subject.environmentId)) return null;
            if (subject.readiness && subject.readiness.projectId !== projectSourceId) return null;
            reference = { actionId: 'deployments.environments.get', input: { serverId, environmentId: subject.environmentId } };
            break;
        }
    }
    if (signal.aborted) return null;
    const placement = await resolveInvestigationPlacement(host, serverId, selected ?? affected, workspace,
        selected ? undefined : projectSourceId, signal);
    if (!placement) return null;
    return { ...placement,
        evidence: { source: { kind: 'alert' as const, label: subject.kind === 'deploymentEnvironment' ? 'Environment reference'
            : subject.kind === 'deploymentReceipt' ? receiptTitle ?? 'Deployment reference'
                : subject.kind === 'workflowRun' ? 'Workflow Run reference' : 'Failure reference' }, author: { kind: 'process' as const },
            text: JSON.stringify({ subject, ...(receiptFailure ? {
                failureCause: receiptFailure.failureCause,
                recovery: readDeploymentFailureRecoveryV1(receiptFailure.code, receiptFailure),
            } : {}), read: reference }) } };
}

/**
 * A failed receipt's title in the receipt page's words ("Deploy of 302cf72 failed"). Investigation only starts from a
 * failed receipt, so only that state is named; anything else keeps the generic reference label.
 */
function failedReceiptTitle(operation: string | undefined, state: string, revision: string | undefined): string | undefined {
    if (state !== 'failed' || !revision) return undefined;
    return operation === 'rollback' ? `Rollback to ${revision} failed` : operation === 'deploy' ? `Deploy of ${revision} failed` : undefined;
}

/** Subject identity chooses the controller and its accepted Source folders once.
 * No folder is guessed from a label, a log, or a repository URL. */
async function resolveInvestigationPlacement(host: TriageActionResolutionHostV1, serverId: string,
    machine: Machine | undefined, workspace: Workspace | undefined, sourceId: string | undefined, signal: AbortSignal,
): Promise<null | UnresolvedPlacement | { kind: 'ready'; machine: Machine; workspace?: Workspace; registry?: TriageProjectRegistryReadV1 }> {
    const registry = !machine || sourceId ? await readTriageProjectRegistryV1(host, { signal }) : undefined;
    const projects = registry?.status === 'read' ? registry.projects.filter(project => project.serverId === serverId) : [];
    const candidate = projectInvestigationPlacementCandidate;
    if (!machine) return { kind: 'placement_choice_required', reason: 'controller_required', agents: [],
        candidates: projects.map(candidate), registry };
    if (!workspace && sourceId) {
        const matches = projects.filter(project => project.sourceId === sourceId && project.machineId === machine.machineId);
        if (matches.length > 1 || registry?.status !== 'read' || !registry.complete) return {
            kind: 'placement_choice_required', reason: 'ambiguous_workspace', candidates: matches.map(candidate), agents: [], machine, registry,
        };
        const match = matches[0];
        if (match) {
            const chosen = candidate(match);
            if (!match.reachable || !chosen.workspace) return { kind: 'placement_choice_required', reason: 'machine_unreachable',
                candidates: [chosen], agents: [], machine, registry };
            workspace = chosen.workspace;
        }
    }
    return { kind: 'ready', machine, workspace, registry };
}

type JsonReadInput = Parameters<TriageActionResolutionHostV1['executeAction']>[1];

function projectInvestigationPlacementCandidate(project: TriageProjectCandidateV1): PlacementChoice['candidates'][number] {
    return { machine: { serverId: project.serverId, machineId: project.machineId },
        ...('id' in project.projectKey ? { workspace: { serverId: project.serverId, machineId: project.machineId,
            workspaceId: project.projectKey.id, rootPath: project.rootPath } } : {}), reachable: project.reachable };
}
