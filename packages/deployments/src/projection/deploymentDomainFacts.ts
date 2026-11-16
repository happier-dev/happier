import type { ActionOperationGetV1Response, ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { DeploymentDomainHeaderV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import type { DeploymentDomainContentV1 } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';
import { isDeploymentDomainAddActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { DeploymentCurrentDomainObservationV1, DeploymentDomainHealthFactsV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import type { DeploymentEnvironmentHeaderV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/v1';

export type DeploymentDomainFactsV1 = Readonly<{
    state: DeploymentDomainHeaderV1['state'] | 'cancelled' | 'outcome_unknown';
    retryRemoval: boolean;
    failure: NonNullable<ActionOperationSnapshotV1['error']> | null;
}>;

/** Retained predecessor Domains remain records, but only the Environment's selected runtime link is attached. */
export function isDeploymentDomainAttachedV1(domain: Pick<DeploymentDomainHeaderV1, 'targetLinkId'>,
    environment: Pick<DeploymentEnvironmentHeaderV1, 'runtimeTargetLinkId'>): boolean {
    return domain.targetLinkId === environment.runtimeTargetLinkId;
}

/** Desired placements remain persisted until native absence is observed. Only an
 * exact controller read's typed not_found establishes a lost operation; a pending
 * or unavailable read supplies no observation and cannot unlock removal. */
export function projectDeploymentDomainFactsV1(domain: DeploymentDomainHeaderV1, accountId: string,
    observation: ActionOperationGetV1Response | null): DeploymentDomainFactsV1 {
    const address = domain.operationAddress;
    if (address && domain.state === 'removing' && observation?.kind === 'not_found') {
        return { state: 'outcome_unknown', retryRemoval: true, failure: { errorCode: 'not_found', error: 'not_found' } };
    }
    const found = observation?.kind === 'found' ? observation.operation : null;
    const operation = address && found?.operationId === address.operationId && found.scope.accountId === accountId
        && found.scope.machineId === address.machineId ? found : null;
    // Placement custody retains Add's operation after a later signed observation settles the Domain.
    if (domain.observedAtMs !== undefined && (domain.state === 'active' || domain.state === 'warning')
        && operation && isDeploymentDomainAddActionIdV1(operation.actionId)) {
        return { state: domain.state, retryRemoval: false, failure: null };
    }
    const retryRemoval = domain.state === 'removing' && (operation?.state === 'failed' || operation?.state === 'cancelled');
    const failure = operation?.state === 'failed' ? operation.error ?? null : null;
    const state = operation?.state === 'failed' ? failure?.errorCode === 'outcome_unknown' ? 'outcome_unknown' : 'failed'
        : retryRemoval && operation?.state === 'cancelled' ? 'cancelled' : domain.state;
    return { state, retryRemoval, failure };
}

/** Ingress placement, rather than controller role, establishes the observer's vantage. */
export function deploymentDomainProbeVantageV1(environment: DeploymentEnvironmentHeaderV1,
    targetLink: DeploymentTargetLinkHeaderV1, observerMachineId: string): 'sameMachine' | 'outside' {
    return (environment.ingress?.kind === 'edgeCaddy'
        ? environment.ingress.edgeMachineId === observerMachineId
        : targetLink.members.some(member => member.state === 'active' && member.machineId === observerMachineId))
        ? 'sameMachine' : 'outside';
}

function finiteCause(result: Pick<NonNullable<DeploymentDomainHeaderV1['dnsHealth']>, 'cause' | 'evidence'>): Record<string, unknown> {
    if (result.cause) return result.cause;
    // The finite producer before 0df892b192a persisted this envelope as JSON evidence.
    for (const item of result.evidence.items) {
        if (item.source.kind !== 'alert' || item.author.kind !== 'process') continue;
        try {
            const value: unknown = JSON.parse(item.text);
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            const facts = value as Record<string, unknown>;
            if (facts.kind === item.source.label && typeof facts.observerMachineId === 'string'
                && (facts.vantage === 'sameMachine' || facts.vantage === 'outside')) return facts;
        } catch { /* Other evidence kinds do not carry finite-check facts. */ }
    }
    return {};
}

export type DeploymentDomainDnsReadinessV1 = Readonly<{
    state: 'missing' | 'not_this_machine' | 'ready' | 'unavailable' | 'not_checked';
    reason: string | null;
}>;

/** Consume the native check's verdict; DNS existence alone never proves this Machine serves the hostname. */
export function projectDeploymentDomainDnsReadinessV1(
    health: DeploymentDomainHeaderV1['dnsHealth'],
): DeploymentDomainDnsReadinessV1 {
    if (!health) return { state: 'not_checked', reason: null };
    const facts = finiteCause(health);
    const reason = typeof facts.reason === 'string' ? facts.reason : null;
    if (reason === 'dns_missing') return { state: 'missing', reason };
    if (reason === 'dns_not_this_machine') return { state: 'not_this_machine', reason };
    if (reason === 'dns_ready') return { state: 'ready', reason };
    return { state: health.status === 'unknown' && reason !== 'not_checked' ? 'unavailable' : 'not_checked', reason };
}

/** One semantic projection serves both Action readers and the Domain row. No clock or probe is started here. */
export function projectDeploymentDomainHealthFactsV1(domain: DeploymentDomainHeaderV1,
    content: Pick<DeploymentDomainContentV1, 'tls'>,
    observations: readonly DeploymentCurrentDomainObservationV1[], unavailableReason: string | null,
    readAt: number): DeploymentDomainHealthFactsV1 {
    const current = observations.filter(item => item.domainId === domain.id && item.domainRevision === domain.revision
        && finiteCause(item.result).reason !== 'not_checked');
    const latest = (kind: 'http' | 'certificate') => {
        const candidates = current.filter(item => item.kind === kind);
        const outside = candidates.filter(item => item.vantage === 'outside');
        return (outside.length ? outside : candidates).reduce<DeploymentCurrentDomainObservationV1 | null>(
            (before, item) => !before || item.result.observedAt > before.result.observedAt ? item : before, null);
    };
    const http = latest('http');
    const tls = latest('certificate');
    const observed = !http ? tls : !tls || http.result.observedAt >= tls.result.observedAt ? http : tls;
    const incomplete = [http, tls].find(item => item?.result.status === 'unknown');
    const unavailableDns = projectDeploymentDomainDnsReadinessV1(domain.dnsHealth);
    const reason = incomplete ? finiteCause(incomplete.result).reason : unavailableDns.state === 'unavailable' ? unavailableDns.reason : null;
    const unavailable = unavailableReason ?? (incomplete || unavailableDns.state === 'unavailable'
        ? typeof reason === 'string' ? reason : 'coverage_unavailable' : null);
    const tlsEvidence = tls ? finiteCause(tls.result) : {};
    const notBefore = typeof tlsEvidence.notBefore === 'number' ? tlsEvidence.notBefore : null;
    const expiresAt = typeof tlsEvidence.notAfter === 'number' ? tlsEvidence.notAfter : null;
    const certificate: DeploymentDomainHealthFactsV1['certificate'] = { state: 'not_checked', expiresAt };
    if (tls && expiresAt !== null && notBefore !== null) {
        certificate.state = readAt >= expiresAt ? 'expired'
            : readAt < notBefore ? 'invalid'
            : content.tls?.kind === 'custom' && readAt >= notBefore + (expiresAt - notBefore) * 2 / 3
                ? 'expiresSoon' : 'valid';
    } else if (tls?.result.status === 'down') certificate.state = 'invalid';
    let needsYou: DeploymentDomainHealthFactsV1['needsYou'] = null;
    if (certificate.state === 'invalid' || certificate.state === 'expired') {
        needsYou = { cause: 'certificate', reason: certificate.state, vantage: tls?.vantage ?? null };
    } else if (http?.result.status === 'down') {
        const facts = finiteCause(http.result);
        const reason = typeof facts.reason === 'string' ? facts.reason : 'http_status';
        const cause = reason === 'dns' ? 'dns' : reason === 'tls' ? 'certificate' : reason === 'connection' ? 'network' : 'http';
        // A wrong answer keeps the status the check observed, so the row can say what came back.
        const observedStatus = facts.httpStatus;
        const httpStatus = cause === 'http' && typeof observedStatus === 'number' && observedStatus >= 100 && observedStatus <= 599
            ? observedStatus : undefined;
        needsYou = { cause, reason, vantage: http.vantage, ...(httpStatus === undefined ? {} : { httpStatus }) };
    } else if (domain.dnsHealth?.status === 'down' && http?.result.status !== 'up') {
        const facts = finiteCause(domain.dnsHealth);
        needsYou = { cause: 'dns', reason: typeof facts.reason === 'string' ? facts.reason : 'dns_missing',
            vantage: facts.vantage === 'outside' || facts.vantage === 'sameMachine' ? facts.vantage : null };
    } else if (certificate.state === 'expiresSoon') {
        needsYou = { cause: 'certificate', reason: certificate.state, vantage: tls?.vantage ?? null };
    }
    return { availability: unavailable ? 'unavailable' : observed ? 'observed' : 'not_checked',
        unavailableReason: unavailable, observedAt: observed?.result.observedAt ?? null, vantage: observed?.vantage ?? null,
        certificate, needsYou };
}
