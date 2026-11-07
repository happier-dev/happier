import type { ActionOperationGetV1Response, ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { DeploymentDomainHeaderV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import type { DeploymentDomainContentV1 } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';
import type { DeploymentCurrentDomainObservationV1, DeploymentDomainHealthFactsV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import type { DeploymentEnvironmentHeaderV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/v1';

export type DeploymentDomainFactsV1 = Readonly<{
    state: DeploymentDomainHeaderV1['state'] | 'cancelled' | 'outcome_unknown';
    retryRemoval: boolean;
    failure: NonNullable<ActionOperationSnapshotV1['error']> | null;
}>;

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
    const retryRemoval = domain.state === 'removing' && (operation?.state === 'failed' || operation?.state === 'cancelled');
    const failure = operation?.state === 'failed' ? operation.error ?? null : null;
    const state = operation?.state === 'failed' ? failure?.errorCode === 'outcome_unknown' ? 'outcome_unknown' : 'failed'
        : retryRemoval && operation?.state === 'cancelled' ? 'cancelled' : domain.state;
    return { state, retryRemoval, failure };
}

/** Ingress placement, rather than controller role, establishes the observer's vantage. */
export function deploymentDomainProbeVantageV1(environment: DeploymentEnvironmentHeaderV1,
    targetLink: DeploymentTargetLinkHeaderV1, observerMachineId: string): 'sameMachine' | 'outside' {
    return (environment.ingress?.kind === 'edgeCaddy' && environment.ingress.edgeMachineId === observerMachineId
        || targetLink.members.some(member => member.state === 'active' && member.machineId === observerMachineId))
        ? 'sameMachine' : 'outside';
}

function finiteEvidence(evidence: NonNullable<DeploymentDomainHeaderV1['dnsHealth']>['evidence']): Record<string, unknown> {
    for (const item of evidence.items) {
        try {
            const value: unknown = JSON.parse(item.text);
            if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
        } catch { /* Other evidence kinds do not carry finite-check facts. */ }
    }
    return {};
}

/** One semantic projection serves both Action readers and the Domain row. No clock or probe is started here. */
export function projectDeploymentDomainHealthFactsV1(domain: DeploymentDomainHeaderV1,
    content: Pick<DeploymentDomainContentV1, 'tls'>,
    observations: readonly DeploymentCurrentDomainObservationV1[], unavailableReason: string | null,
    readAt: number): DeploymentDomainHealthFactsV1 {
    const current = observations.filter(item => item.domainId === domain.id && item.domainRevision === domain.revision
        && finiteEvidence(item.result.evidence).reason !== 'not_checked');
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
    const reason = incomplete ? finiteEvidence(incomplete.result.evidence).reason : null;
    const unavailable = unavailableReason ?? (incomplete ? typeof reason === 'string' ? reason : 'coverage_unavailable' : null);
    const tlsEvidence = tls ? finiteEvidence(tls.result.evidence) : {};
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
        const facts = finiteEvidence(http.result.evidence);
        const reason = typeof facts.reason === 'string' ? facts.reason : 'http_status';
        needsYou = { cause: reason === 'dns' ? 'dns' : reason === 'tls' ? 'certificate'
            : reason === 'connection' ? 'network' : 'http', reason, vantage: http.vantage };
    } else if (domain.dnsHealth?.status === 'down' && http?.result.status !== 'up') {
        const facts = finiteEvidence(domain.dnsHealth.evidence);
        needsYou = { cause: 'dns', reason: typeof facts.reason === 'string' ? facts.reason : 'dns_missing',
            vantage: facts.vantage === 'outside' || facts.vantage === 'sameMachine' ? facts.vantage : null };
    } else if (certificate.state === 'expiresSoon') {
        needsYou = { cause: 'certificate', reason: certificate.state, vantage: tls?.vantage ?? null };
    }
    return { availability: unavailable ? 'unavailable' : observed ? 'observed' : 'not_checked',
        unavailableReason: unavailable, observedAt: observed?.result.observedAt ?? null, vantage: observed?.vantage ?? null,
        certificate, needsYou };
}
