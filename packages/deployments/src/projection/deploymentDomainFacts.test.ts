import { describe, expect, it } from 'vitest';
import { ActionOperationGetV1ResponseSchema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { DeploymentDomainHeaderV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { projectDeploymentDomainFactsV1, projectDeploymentDomainHealthFactsV1 } from './deploymentDomainFacts';

const domain: DeploymentDomainHeaderV1 = { v: 1, id: 'domain', environmentId: 'environment', targetLinkId: 'link',
    state: 'removing', revision: 2, createdByAccountId: 'account', createdAtMs: 1, updatedAtMs: 2,
    contentArtifactId: 'artifact', contentHeaderVersion: 1, contentBodyVersion: 1,
    operationAddress: { serverId: 'home', machineId: 'controller', operationId: 'removal' } };
const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'removal', revision: 1,
    actionId: 'deployments.domains.remove', state: 'running', scope: { accountId: 'account', machineId: 'controller' },
    title: 'Remove Domain', createdAt: 1, startedAt: 2, cancellation: 'supported' };

describe('Domain lifecycle projection', () => {
    it('makes typed not_found recoverable without claiming native removal or changing persisted intent', () => {
        const result = projectDeploymentDomainFactsV1(domain, 'account', ActionOperationGetV1ResponseSchema.parse({ kind: 'not_found' }));
        expect(result).toMatchObject({ state: 'outcome_unknown', retryRemoval: true, failure: { errorCode: 'not_found' } });
        expect(domain.state).toBe('removing');
    });

    it('keeps pending/unavailable reads and a running or succeeded operation unresolved', () => {
        for (const read of [null, { kind: 'found' as const, operation },
            { kind: 'found' as const, operation: { ...operation, state: 'succeeded' as const, settledAt: 3 } }]) {
            expect(projectDeploymentDomainFactsV1(domain, 'account', read))
                .toEqual({ state: 'removing', retryRemoval: false, failure: null });
        }
    });

    it('uses only the exact operation and Account/controller scope for failure recovery', () => {
        const failed = { ...operation, state: 'failed' as const, settledAt: 3,
            error: { errorCode: 'outcome_unknown', error: 'outcome_unknown' } };
        expect(projectDeploymentDomainFactsV1(domain, 'account', { kind: 'found', operation: failed }))
            .toMatchObject({ state: 'outcome_unknown', retryRemoval: true, failure: failed.error });
        for (const other of [{ ...failed, operationId: 'other' },
            { ...failed, scope: { ...failed.scope, accountId: 'other' } },
            { ...failed, scope: { ...failed.scope, machineId: 'other' } }]) {
            expect(projectDeploymentDomainFactsV1(domain, 'account', { kind: 'found', operation: other }))
                .toEqual({ state: 'removing', retryRemoval: false, failure: null });
        }
    });

    it('does not reinterpret a missing Add or a legacy Domain without a recorded operation as failed removal', () => {
        for (const header of [{ ...domain, state: 'active' as const }, { ...domain, operationAddress: undefined }]) {
            expect(projectDeploymentDomainFactsV1(header, 'account', { kind: 'not_found' }))
                .toEqual({ state: header.state, retryRemoval: false, failure: null });
        }
    });
});

describe('Domain saved health facts', () => {
    const evidence = (kind: string, facts: Record<string, string | number>) => ({ v: 1 as const,
        items: [{ source: { kind: 'alert' as const, label: kind }, author: { kind: 'process' as const },
            text: JSON.stringify({ kind, ...facts }) }] });
    const certificate = { domainId: domain.id, domainRevision: domain.revision, targetLinkRevision: 1,
        kind: 'certificate' as const, observerMachineId: 'controller', vantage: 'outside' as const,
        result: { status: 'up' as const, observedAt: 2000, evidence: evidence('certificate', { notBefore: 0, notAfter: 3000 }) } };
    const content = { hostname: 'app.test', target: { service: 'app', containerPort: 80 }, tls: { kind: 'custom' as const } };
    it('projects the custom certificate replacement point and expiry without a managed renewal window', () => {
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [certificate], null, 2000))
            .toMatchObject({ certificate: { state: 'expiresSoon', expiresAt: 3000 }, needsYou: { cause: 'certificate' } });
        expect(projectDeploymentDomainHealthFactsV1(domain, { ...content, tls: { kind: 'managed' } }, [certificate], null, 2000))
            .toMatchObject({ certificate: { state: 'valid', expiresAt: 3000 }, needsYou: null });
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [{ ...certificate,
            result: { ...certificate.result, status: 'down', observedAt: 3000 } }], null, 3000))
            .toMatchObject({ certificate: { state: 'expired' }, needsYou: { cause: 'certificate' } });
    });
    it('distinguishes DNS, outside network access, TLS and unavailable observations', () => {
        const http = { ...certificate, kind: 'http' as const, result: { status: 'down' as const,
            observedAt: 2000, evidence: evidence('http', { reason: 'connection' }) } };
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [http], null, 2000))
            .toMatchObject({ needsYou: { cause: 'network', vantage: 'outside' } });
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [{ ...http, vantage: 'sameMachine' }], null, 2000))
            .toMatchObject({ needsYou: { cause: 'network', vantage: 'sameMachine' } });
        expect(projectDeploymentDomainHealthFactsV1({ ...domain, dnsHealth: { status: 'down',
            evidence: evidence('dns', { reason: 'dns_missing' }) } }, content, [], null, 2000))
            .toMatchObject({ needsYou: { cause: 'dns' } });
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [{ ...http,
            result: { ...http.result, evidence: evidence('http', { reason: 'tls' }) } }], null, 2000))
            .toMatchObject({ needsYou: { cause: 'certificate' } });
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [], 'machine_unavailable', 2000))
            .toMatchObject({ availability: 'unavailable', unavailableReason: 'machine_unavailable', needsYou: null });
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [{ ...http, domainRevision: 999 }], null, 2000))
            .toMatchObject({ certificate: { state: 'not_checked' }, needsYou: null });
    });
    it('keeps an outside failure distinct from a newer local success and advances known expiry only at read', () => {
        const outside = { ...certificate, kind: 'http' as const, result: { status: 'down' as const,
            observedAt: 1000, evidence: evidence('http', { reason: 'connection' }) } };
        const local = { ...outside, vantage: 'sameMachine' as const, result: { ...outside.result,
            status: 'up' as const, observedAt: 2000 } };
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [outside, local], null, 2000))
            .toMatchObject({ needsYou: { cause: 'network', vantage: 'outside' } });
        const early = { ...certificate, result: { ...certificate.result, observedAt: 1000 } };
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [early], null, 2000))
            .toMatchObject({ observedAt: 1000, certificate: { state: 'expiresSoon' } });
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [early], null, 3000))
            .toMatchObject({ observedAt: 1000, certificate: { state: 'expired' } });
    });
    it('keeps an absent configured check distinct from an unavailable finite observation', () => {
        const unknown = { ...certificate, kind: 'http' as const, result: { status: 'unknown' as const,
            observedAt: 2000, evidence: evidence('http', { reason: 'not_checked' }) } };
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [unknown], null, 2000))
            .toMatchObject({ availability: 'not_checked', observedAt: null, needsYou: null });
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [{ ...unknown,
            result: { ...unknown.result, evidence: evidence('http', { reason: 'transport_incomplete' }) } }], null, 2000))
            .toMatchObject({ availability: 'unavailable', unavailableReason: 'transport_incomplete', needsYou: null });
    });
    it('keeps an outside DNS failure primary while the custom certificate replacement is advisory', () => {
        const http = { ...certificate, kind: 'http' as const, result: { status: 'down' as const,
            observedAt: 2000, evidence: evidence('http', { reason: 'dns' }) } };
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [http, certificate], null, 2000))
            .toMatchObject({ certificate: { state: 'expiresSoon' }, needsYou: { cause: 'dns', vantage: 'outside' } });
    });
});
