import type { DeploymentReceiptDetailV1, DeploymentReceiptFailureV1, DeploymentStepV1, DeploymentReceiptHeaderV1, DeploymentTargetLinkHeaderV1, DeploymentReceiptHistoryV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentReviewRevisionV1 } from '@happier-dev/protocol/deployments/deploymentReviewV1';
import type { DeploymentLogsReadInputV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { hasDeploymentReceiptContentV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { deploymentRevisionShortLabelV1, readDeploymentReceiptArtifactV1 } from '@happier-dev/deployment-protocol/v1';
import type { DeploymentArtifactDocumentV1 } from '@happier-dev/protocol/deployments/deploymentArtifactContentReferenceV1';
import { getDeploymentTargetLinkLineageV1, isDeploymentRollbackSourceEligibleV1 } from '@happier-dev/deployments/contracts/v1';
import { areDeploymentSourceLabelsEqualV1, projectDeploymentDowntimeClassV1, projectDeploymentReviewRevisionV1 } from '@happier-dev/protocol/deployments/deploymentReviewV1';

type Version = Readonly<{ deploymentId: string; revision: DeploymentReviewRevisionV1 }>;
export function deploymentRevisionLabelV1(revision: DeploymentReviewRevisionV1): string {
    return deploymentRevisionShortLabelV1(revision);
}
/** Shared with native release retention: eligible settled receipts, newest first, within the authored policy. */
export function selectDeploymentRetainedPreviousV1<T extends DeploymentReceiptHeaderV1>(receipts: readonly T[],
    activeDeploymentId: string | undefined, retainPreviousDeployments: number | undefined): readonly T[] {
    return receipts.filter(row => row.id !== activeDeploymentId && isDeploymentRollbackSourceEligibleV1(row.state))
        .sort((left, right) => right.requestedAtMs - left.requestedAtMs || right.id.localeCompare(left.id))
        .slice(0, retainPreviousDeployments);
}

export type DeploymentReceiptRetainedHistoryV1 = Readonly<{
    receipt: DeploymentReceiptHeaderV1;
    items: DeploymentReceiptHistoryV1['items'];
    complete: boolean;
    runtime: DeploymentTargetLinkHeaderV1;
    targetLinks: readonly DeploymentTargetLinkHeaderV1[];
    retainPreviousDeployments: number;
    placement: DeploymentReceiptFactsV1['placement'];
}>;

/** Every displayed retained-history fact comes from the same opened history page. */
export function selectDeploymentReceiptRetainedHistoryV1(input: DeploymentReceiptRetainedHistoryV1):
    Pick<DeploymentReceiptFactsV1, 'previousVersion' | 'servingVersion' | 'retainedPreviousCount' | 'retainedRollbackTarget' | 'retainedRollbackContentMissing'> {
    const lineage = getDeploymentTargetLinkLineageV1(input.runtime, input.targetLinks);
    const entries = input.items.filter(row => row.environmentId === input.receipt.environmentId && lineage.has(row.targetLinkId));
    const retained = selectDeploymentRetainedPreviousV1(entries, input.runtime.activeDeploymentId,
        input.placement === 'machine' ? input.retainPreviousDeployments : undefined);
    const predecessors = retained.filter(row => row.id !== input.receipt.id
        && (row.requestedAtMs < input.receipt.requestedAtMs
            || row.requestedAtMs === input.receipt.requestedAtMs && row.id.localeCompare(input.receipt.id) < 0));
    const previous = predecessors[0];
    const released = isDeploymentRollbackSourceEligibleV1(input.receipt.state);
    const previousVersion = !released ? undefined
        : previous ? previous.source ? { deploymentId: previous.id, revision: previous.source } : undefined
            : input.complete ? null : undefined;
    const active = entries.find(row => row.id === input.runtime.activeDeploymentId);
    const failed = input.receipt.state === 'failed' || input.receipt.state === 'outcome_unknown';
    // The target's serving settlement decides what is serving now. History only supplies its revision label.
    const servingVersion = failed && active?.source && active.id !== input.receipt.id
        ? { deploymentId: active.id, revision: active.source } : undefined;
    const candidate = input.receipt.id === input.runtime.activeDeploymentId || !released
        ? previous : retained.find(row => row.id === input.receipt.id);
    const source = candidate?.source;
    const servingSource = active?.source;
    const distinct = candidate && active && candidate.id !== active.id && source
        && areDeploymentSourceLabelsEqualV1(source, servingSource) === false ? { candidate, source } : null;
    const available = distinct && hasDeploymentReceiptContentV1(distinct.candidate);
    return { previousVersion, retainedPreviousCount: input.placement === 'machine' && input.complete ? predecessors.length : null,
        retainedRollbackTarget: distinct && available ? { deploymentId: distinct.candidate.id, revision: distinct.source } : null,
        ...(servingVersion ? { servingVersion } : {}),
        ...(distinct && !available ? { retainedRollbackContentMissing: distinct.candidate.id } : {}) };
}

/** Exact operands for the existing deployments.logs.read stage-log owner. */
export type DeploymentReceiptLogFactV1 = Readonly<{
    scope: 'operation';
    reference: Readonly<Omit<Extract<DeploymentLogsReadInputV1, { kind: 'build' }>, 'serverId' | 'cursor' | 'tail' | 'ref'>>;
    excerpt: Readonly<{ text: string; truncated: boolean }> | null;
}>;
export type DeploymentReceiptStepLogFactV1 = Readonly<{
    ref: string; range: Readonly<{ start: number; end: number | null }>;
    reference: DeploymentReceiptLogFactV1['reference'] & Readonly<{ ref: string }>;
}>;
export type DeploymentReceiptFactsV1 = Readonly<{
    /**
     * Where the release ran, from the target kind: a Machine (Docker images kept by its own retention) or a platform
     * that keeps its own releases. Machine wording ("Ran on", "Kept for rollback", "cleaned up") is for Machines only.
     */
    placement: 'machine' | 'platform';
    failure: DeploymentReceiptFailureV1 | null;
    /** Historical restoration evidence, including whether health was verified. */
    restoration: Readonly<{ kind: 'not_attempted' | 'failed' | 'outcome_unknown' }>
        | Readonly<{ kind: 'succeeded'; health: 'healthy' | 'unverified' }>;
    commitSubject: string | null;
    source: DeploymentReviewRevisionV1 | null;
    /** undefined = not captured; null = admitted first deploy without an incumbent. Display only. */
    rollbackTarget: Readonly<{ deploymentId: string; revision: DeploymentReviewRevisionV1 }> | null | undefined;
    previousVersion: Version | null | undefined;
    /** The target's currently serving release beside a failed attempt, when its revision is available. */
    servingVersion?: Version;
    retainedPreviousCount: number | null;
    retainedRollbackTarget: Version | null;
    /** Exact previous release that would be offered for rollback if it still had its definition. */
    retainedRollbackContentMissing?: string;
    logs: readonly DeploymentReceiptLogFactV1[];
    steps: readonly (DeploymentStepV1 & Readonly<{ machineId?: string; logs: readonly DeploymentReceiptLogFactV1[];
        stageLogs: readonly DeploymentReceiptStepLogFactV1[] }>)[];
    stageLogs: readonly DeploymentReceiptStepLogFactV1[];
    /** null = not captured; [] = provider explicitly observed no URLs. Native Domains have their own owner. */
    urls: readonly string[] | null;
    /** Provider-observed built-in routing addresses, separate from unique deployment/preview URLs. */
    builtInUrls: readonly string[] | null;
    urlsObservedAtMs: number | null;
    publicAddressFailure: NonNullable<NonNullable<DeploymentReceiptDetailV1['content']['platform']>['observation']['publicAddressFailure']> | null;
    /** Historical receipt evidence, never a claim about current service health. */
    health: Readonly<{ source: 'receipt'; members: DeploymentReceiptDetailV1['content']['machineResults'] }>;
    downtime: 'stopThenStart' | null;
}>;

/** The small history projection avoids preparing unconsumed step/log trees for every visible attempt.
 * The title names what was deployed; the recorded failure stays a typed fact for the client's own words. */
export function projectDeploymentReceiptHistoryEntryV1({ content, deployment }: DeploymentReceiptDetailV1):
    Readonly<{ source: DeploymentReceiptFactsV1['source']; historyTitle: string | null; failure: DeploymentReceiptFailureV1 | null;
        machineIds: readonly string[]; steps: readonly (DeploymentStepV1 & Readonly<{ machineId?: string }>)[] }> {
    const { source, commitSubject } = projectDeploymentReceiptSourceFactsV1(content);
    const historyTitle = [source ? deploymentRevisionLabelV1(source) : null, commitSubject]
        .filter(Boolean).join(' · ') || null;
    const execution = deployment.acceptedExecution;
    const machineIds = [...new Set([...content.machines,
        ...(content.buildMachineId ? [content.buildMachineId] : []),
        ...(execution ? [execution.controller.machineId, ...(execution.builder ? [execution.builder.machineId] : [])] : [])])];
    return { source, historyTitle, failure: content.failure ?? null, machineIds,
        steps: [...content.steps, ...content.machineResults.flatMap(member =>
            member.steps.map(step => ({ ...step, machineId: member.machineId })))] };
}

/** Project the opened rows once for Fleet Activity and Environment history. */
export function projectDeploymentReceiptHistoryPageV1(
    page: Readonly<{ items: readonly DeploymentReceiptHeaderV1[]; nextCursor: string | null }>,
    documents: readonly (DeploymentArtifactDocumentV1 | null | undefined)[],
): DeploymentReceiptHistoryV1 {
    const items: DeploymentReceiptHistoryV1['items'] = [];
    let coverage: DeploymentReceiptHistoryV1['coverage'];
    for (const [index, row] of page.items.entries()) {
        const { requiredFact: _requiredFact, remedy: _remedy, ...receipt }:
            typeof row & { requiredFact?: string; remedy?: string } = row;
        if (!hasDeploymentReceiptContentV1(receipt)) {
            items.push(receipt);
            continue;
        }
        const opened = readDeploymentReceiptArtifactV1(receipt, documents[index] ?? null);
        if (!opened.ok) { coverage = 'partial'; continue; }
        const facts = projectDeploymentReceiptHistoryEntryV1({ deployment: receipt, content: opened.content });
        items.push({ ...receipt, actor: opened.content.actor ?? null, title: facts.historyTitle ?? opened.title, source: facts.source, failure: facts.failure,
            machineIds: [...facts.machineIds], steps: [...facts.steps] });
    }
    return { ok: true, ...page, items, ...(coverage === undefined ? {} : { coverage }) };
}

/** Private source presentation from the opened receipt, without execution step/log trees. */
export function projectDeploymentReceiptSourceFactsV1(content: DeploymentReceiptDetailV1['content']):
    Pick<DeploymentReceiptFactsV1, 'commitSubject' | 'source'> {
    const source = projectDeploymentReviewRevisionV1(content);
    const commitSubject = content.sourceIntent?.kind === 'repository'
        ? (source?.kind === 'repository' ? source.subject : undefined) : content.commitSubject;
    return { commitSubject: commitSubject ?? null, source };
}

/** Observed address facts without preparing unconsumed execution step/log trees. */
export function projectDeploymentReceiptUrlFactsV1(content: DeploymentReceiptDetailV1['content']):
    Pick<DeploymentReceiptFactsV1, 'urls' | 'builtInUrls' | 'urlsObservedAtMs' | 'publicAddressFailure'> {
    return { urls: content.platform?.observation.urls ?? null, builtInUrls: content.platform?.observation.builtInUrls ?? null,
        urlsObservedAtMs: content.platform?.observation.observedAtMs ?? null,
        publicAddressFailure: content.platform?.observation.publicAddressFailure ?? null };
}

/** Historical evidence comes from the receipt; optional current retention facts share the opened history page. */
export function projectDeploymentReceiptFactsV1(receipt: DeploymentReceiptDetailV1,
    retainedHistory?: Omit<DeploymentReceiptRetainedHistoryV1, 'placement'>): DeploymentReceiptFactsV1 {
    const { deployment, content } = receipt;
    const retainedStageLogs = content.platform?.stageLogs ?? content.ownServer?.stageLogs ?? [];
    const logs: DeploymentReceiptLogFactV1[] = retainedStageLogs.map(log => ({
        scope: 'operation', reference: { kind: 'build', environmentId: deployment.environmentId, deploymentId: deployment.id,
            targetLinkId: deployment.targetLinkId, machineId: log.machineId, installationId: log.installationId },
        excerpt: log.excerpt ?? null,
    }));
    if (content.platform?.observation.providerDeploymentId) logs.push({
        scope: 'operation', reference: { kind: 'build', environmentId: deployment.environmentId, deploymentId: deployment.id,
            targetLinkId: deployment.targetLinkId },
        excerpt: null,
    });
    const memberLogs = new Map(logs.map(log => [JSON.stringify([
        log.reference.machineId, log.reference.installationId,
    ]), [log]]));
    const stageLogs = retainedStageLogs.flatMap((log, index) => (log.steps ?? []).map(step => ({
        ...step, reference: { ...logs[index]!.reference, ref: step.ref },
    })));
    const byStep = new Map<string, typeof stageLogs>();
    for (const log of stageLogs) for (const machineId of [undefined, log.reference.machineId]) {
        const key = JSON.stringify([log.ref, machineId]);
        const selected = byStep.get(key) ?? [];
        selected.push(log); byStep.set(key, selected);
    }
    const forStep = (step: DeploymentStepV1, machineId?: string) => byStep.get(JSON.stringify([step.streamRef ?? step.id, machineId])) ?? [];
    const rollout = content.ownServer?.approvedInputBasis.ownServer?.rollout;
    const placement = content.platform !== undefined ? 'platform' as const : 'machine' as const;
    return {
        ...(retainedHistory ? selectDeploymentReceiptRetainedHistoryV1({ ...retainedHistory, placement })
            : { previousVersion: undefined, retainedPreviousCount: null, retainedRollbackTarget: null }),
        placement,
        failure: content.failure ?? null,
        restoration: projectRestoration(content),
        ...projectDeploymentReceiptSourceFactsV1(content), rollbackTarget: content.ownServer?.rollbackTarget,
        logs, stageLogs, steps: [
            ...content.steps.map(step => ({ ...step, logs, stageLogs: forStep(step) })),
            ...content.machineResults.flatMap(member => {
                const logs = memberLogs.get(JSON.stringify([member.machineId, member.installationId])) ?? [];
                return member.steps.map(step => ({ ...step, machineId: member.machineId, logs, stageLogs: forStep(step, member.machineId) }));
            }),
        ],
        ...projectDeploymentReceiptUrlFactsV1(content),
        health: { source: 'receipt', members: content.machineResults },
        downtime: projectDeploymentDowntimeClassV1(rollout, content.ownServer?.rollbackTarget != null) ?? null,
    };
}

function projectRestoration(content: DeploymentReceiptDetailV1['content']): DeploymentReceiptFactsV1['restoration'] {
    const restored = content.machineResults.filter(member => member.restoration !== undefined);
    if (content.failure?.phase === 'restore' || restored.some(member => member.restoration === 'failed'
        || member.restoration === 'unreachable' || member.health === 'unhealthy')) return { kind: 'failed' };
    if (!restored.length) return { kind: 'not_attempted' };
    const restoredMachines = new Set(restored.map(member => member.machineId));
    if (restored.some(member => member.restoration !== 'succeeded' || member.health === 'unknown')
        || content.machines.some(machineId => !restoredMachines.has(machineId))) {
        return { kind: 'outcome_unknown' };
    }
    return { kind: 'succeeded', health: restored.some(member => member.health === 'unverified') ? 'unverified' : 'healthy' };
}
