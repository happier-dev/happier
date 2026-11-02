import type {
    DeploymentReceiptDetailV1, DeploymentReceiptFailureV1, DeploymentReviewRevisionV1, DeploymentStepV1,
} from '@happier-dev/deployment-protocol/v1';
import { projectDeploymentDowntimeClassV1, projectDeploymentReviewRevisionV1 } from '@happier-dev/deployment-protocol/v1';

/** Exact operands for the existing deployments.logs.read stage-log owner. */
export type DeploymentReceiptLogFactV1 = Readonly<{
    scope: 'operation';
    reference: Readonly<{ kind: 'build'; environmentId: string; deploymentId: string; targetLinkId: string;
        machineId: string; installationId: string }>;
    excerpt: Readonly<{ text: string; truncated: boolean }> | null;
}>;
export type DeploymentReceiptStepLogFactV1 = Readonly<{
    ref: string; range: Readonly<{ start: number; end: number | null }>;
    reference: DeploymentReceiptLogFactV1['reference'] & Readonly<{ ref: string }>;
}>;
export type DeploymentReceiptFactsV1 = Readonly<{
    failure: DeploymentReceiptFailureV1 | null;
    commitSubject: string | null;
    source: DeploymentReviewRevisionV1 | null;
    /** undefined = not captured; null = admitted first deploy without an incumbent. Display only. */
    rollbackTarget: Readonly<{ deploymentId: string; revision: DeploymentReviewRevisionV1 }> | null | undefined;
    logs: readonly DeploymentReceiptLogFactV1[];
    steps: readonly (DeploymentStepV1 & Readonly<{ machineId?: string; logs: readonly DeploymentReceiptLogFactV1[];
        stageLogs: readonly DeploymentReceiptStepLogFactV1[] }>)[];
    stageLogs: readonly DeploymentReceiptStepLogFactV1[];
    /** null = not captured; [] = provider explicitly observed no URLs. Native Domains have their own owner. */
    urls: readonly string[] | null;
    urlsObservedAtMs: number | null;
    /** Historical receipt evidence, never a claim about current service health. */
    health: Readonly<{ source: 'receipt'; members: DeploymentReceiptDetailV1['content']['machineResults'] }>;
    downtime: 'stopThenStart' | null;
}>;

/** The admitted receipt is sufficient: no Environment/history/log request and no second lifecycle decision. */
export function projectDeploymentReceiptFactsV1({ deployment, content }: DeploymentReceiptDetailV1): DeploymentReceiptFactsV1 {
    const logs: DeploymentReceiptLogFactV1[] = (content.ownServer?.stageLogs ?? []).map(log => ({
        scope: 'operation', reference: { kind: 'build', environmentId: deployment.environmentId, deploymentId: deployment.id,
            targetLinkId: deployment.targetLinkId, machineId: log.machineId, installationId: log.installationId },
        excerpt: log.excerpt ?? null,
    }));
    const memberLogs = new Map(logs.map(log => [JSON.stringify([
        log.reference.machineId, log.reference.installationId,
    ]), [log]]));
    const stageLogs = (content.ownServer?.stageLogs ?? []).flatMap((log, index) => (log.steps ?? []).map(step => ({
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
    return {
        failure: content.failure ?? null,
        commitSubject: content.commitSubject ?? null,
        source: content.sourceIntent ? projectDeploymentReviewRevisionV1(content.sourceIntent, content.commitSubject) : null, rollbackTarget: content.ownServer?.rollbackTarget,
        logs, stageLogs, steps: [
            ...content.steps.map(step => ({ ...step, logs, stageLogs: forStep(step) })),
            ...content.machineResults.flatMap(member => {
                const logs = memberLogs.get(JSON.stringify([member.machineId, member.installationId])) ?? [];
                return member.steps.map(step => ({ ...step, machineId: member.machineId, logs, stageLogs: forStep(step, member.machineId) }));
            }),
        ],
        urls: content.platform?.observation.urls ?? null, urlsObservedAtMs: content.platform?.observation.observedAtMs ?? null,
        health: { source: 'receipt', members: content.machineResults },
        downtime: projectDeploymentDowntimeClassV1(rollout, content.ownServer?.rollbackTarget != null) ?? null,
    };
}
