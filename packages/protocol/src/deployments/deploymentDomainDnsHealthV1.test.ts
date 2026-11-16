import { expect, it } from 'vitest';
import { HealthCheckResultV1Schema } from './healthCheckV1.js';
import { DeploymentDomainHeaderV1Schema, DeploymentDomainObservationBodyV1Schema,
    deploymentDomainObservationProofPayloadV1 } from './deploymentDomainV1.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';

it('retains finite DNS causes in the signed Domain body and its public header', () => {
    const health = HealthCheckResultV1Schema.parse({ status: 'unknown', observedAt: 1,
        cause: { kind: 'dns', observerMachineId: 'machine', vantage: 'sameMachine',
            reason: 'resolver_unavailable', remedy: 'Restore DNS resolver access, then verify again.' },
        evidence: { v: 1, items: [{ source: { kind: 'alert', label: 'dns' }, author: { kind: 'process' },
            text: 'dns health check: unknown (resolver_unavailable).' }] } });
    const dnsHealth = { status: health.status, cause: health.cause, evidence: health.evidence };
    const capture = { placement: { serverId: 'home', accountId: 'account', environmentId: 'environment', targetLinkId: 'link',
        domainId: 'domain', machineId: 'machine', installationId: 'installation', nativeServer: 'public',
        actionOperationId: 'operation', requestId: 'request' }, listener: 'public', desired: true,
        content: { contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1 } };
    const observation = DeploymentDomainObservationBodyV1Schema.parse({ capture, state: 'warning', dnsHealth });
    expect(observation.dnsHealth).toEqual(dnsHealth);
    const signingInput = (value: typeof observation) => createCanonicalJsonSigningInput(
        deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: 1, observation: value }));
    expect(signingInput(observation)).not.toEqual(signingInput({ ...observation,
        dnsHealth: { ...dnsHealth, cause: { ...health.cause!, reason: 'dns_missing' } } }));
    const header = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: 'environment',
        targetLinkId: 'link', revision: 1, state: 'warning', createdByAccountId: 'account', createdAtMs: 1, updatedAtMs: 1,
        ...capture.content, dnsHealth });
    expect(header.dnsHealth).toEqual(dnsHealth);
});
