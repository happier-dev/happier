import { describe, expect, it } from 'vitest';
import { ActionOperationGetV1ResponseSchema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { DeploymentDomainHeaderV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { deploymentDomainProbeVantageV1, isDeploymentDomainAttachedV1, projectDeploymentDomainFactsV1, projectDeploymentDomainHealthFactsV1, projectDeploymentDomainDnsReadinessV1 } from './deploymentDomainFacts';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';

const domain: DeploymentDomainHeaderV1 = { v: 1, id: 'domain', environmentId: 'environment', targetLinkId: 'link',
    state: 'removing', revision: 2, createdByAccountId: 'account', createdAtMs: 1, updatedAtMs: 2,
    contentArtifactId: 'artifact', contentHeaderVersion: 1, contentBodyVersion: 1,
    operationAddress: { serverId: 'home', machineId: 'controller', operationId: 'removal' } };
const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'removal', revision: 1,
    actionId: 'deployments.domains.remove', state: 'running', scope: { accountId: 'account', machineId: 'controller' },
    title: 'Remove Domain', createdAt: 1, startedAt: 2, cancellation: 'supported' };

describe('Domain lifecycle projection', () => {
    it('attaches only the selected runtime link, without falling back to a retained predecessor or absent pointer', () => {
        const environment = createDeploymentEnvironmentHeaderV1({ runtimeTargetLinkId: domain.targetLinkId });
        expect(isDeploymentDomainAttachedV1(domain, environment)).toBe(true);
        expect(isDeploymentDomainAttachedV1({ ...domain, targetLinkId: 'previous-link' }, environment)).toBe(false);
        expect(isDeploymentDomainAttachedV1(domain, { ...environment, runtimeTargetLinkId: undefined })).toBe(false);
    });

    it('uses the serving edge for vantage even when the observer is an active runtime member', () => {
        const environment = createDeploymentEnvironmentHeaderV1({ ingress: { kind: 'edgeCaddy', edgeMachineId: 'edge' } });
        const targetLink = createDeploymentTargetLinkHeaderV1({ machines: ['runtime'], members: [
            { machineId: 'runtime', installationId: 'installation-runtime', state: 'active' },
        ] });
        expect(deploymentDomainProbeVantageV1(environment, targetLink, 'runtime')).toBe('outside');
        expect(deploymentDomainProbeVantageV1(environment, targetLink, 'edge')).toBe('sameMachine');
        expect(deploymentDomainProbeVantageV1({ ...environment, ingress: undefined }, targetLink, 'runtime')).toBe('sameMachine');
    });

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

    it('uses a settled Domain observation instead of the retained failed Add while preserving unresolved failures', () => {
        const failedAdd: ActionOperationSnapshotV1 = { ...operation, operationId: 'addition', actionId: 'deployments.domains.add',
            state: 'failed', settledAt: 3, error: { errorCode: 'provider_request_failed', error: 'provider_request_failed',
                failureCause: { phase: 'deployment.provider', errorClass: 'Error', errorCode: 'duplicate-team-registration', httpStatus: 409 } } };
        const retained = { ...domain, provider: true as const,
            operationAddress: { ...domain.operationAddress!, operationId: failedAdd.operationId } };
        const read = { kind: 'found' as const, operation: failedAdd };
        for (const state of ['pending', 'applying', 'removing'] as const) {
            expect(projectDeploymentDomainFactsV1({ ...retained, state, observedAtMs: 4 }, 'account', read))
                .toMatchObject({ state: 'failed', failure: failedAdd.error });
        }
        for (const state of ['active', 'warning'] as const) {
            expect(projectDeploymentDomainFactsV1({ ...retained, state }, 'account', read))
                .toMatchObject({ state: 'failed', failure: failedAdd.error });
            expect(projectDeploymentDomainFactsV1({ ...retained, state, observedAtMs: 4 }, 'account', read))
                .toEqual({ state, retryRemoval: false, failure: null });
            expect(projectDeploymentDomainFactsV1({ ...retained, state, observedAtMs: 4 }, 'account', {
                kind: 'found', operation: { ...failedAdd, actionId: 'deployments.domains.remove' },
            })).toMatchObject({ state: 'failed', failure: failedAdd.error });
        }
    });
});

describe('Domain saved health facts', () => {
    const diagnostics = (kind: 'http' | 'certificate' | 'dns', facts: Record<string, string | number>) => ({
        cause: { kind, observerMachineId: 'controller', vantage: 'outside' as const, ...facts },
        evidence: { v: 1 as const, items: [{ source: { kind: 'alert' as const, label: kind },
            author: { kind: 'process' as const }, text: `${kind} finite observation` }] },
    });
    const certificate = { domainId: domain.id, domainRevision: domain.revision, targetLinkRevision: 1,
        kind: 'certificate' as const, observerMachineId: 'controller', vantage: 'outside' as const,
        result: { status: 'up' as const, observedAt: 2000, ...diagnostics('certificate', { notBefore: 0, notAfter: 3000 }) } };
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
            observedAt: 2000, ...diagnostics('http', { reason: 'connection' }) } };
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [http], null, 2000))
            .toMatchObject({ needsYou: { cause: 'network', vantage: 'outside' } });
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [{ ...http, vantage: 'sameMachine' }], null, 2000))
            .toMatchObject({ needsYou: { cause: 'network', vantage: 'sameMachine' } });
        expect(projectDeploymentDomainHealthFactsV1({ ...domain, dnsHealth: { status: 'down',
            ...diagnostics('dns', { reason: 'dns_missing' }) } }, content, [], null, 2000))
            .toMatchObject({ needsYou: { cause: 'dns' } });
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [{ ...http,
            result: { ...http.result, ...diagnostics('http', { reason: 'tls' }) } }], null, 2000))
            .toMatchObject({ needsYou: { cause: 'certificate' } });
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [], 'machine_unavailable', 2000))
            .toMatchObject({ availability: 'unavailable', unavailableReason: 'machine_unavailable', needsYou: null });
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [{ ...http, domainRevision: 999 }], null, 2000))
            .toMatchObject({ certificate: { state: 'not_checked' }, needsYou: null });
    });
    it('carries the observed HTTP status of a wrong answer as the cause, and none for a network failure', () => {
        const http = { ...certificate, kind: 'http' as const, result: { status: 'down' as const,
            observedAt: 2000, ...diagnostics('http', {}), cause: { kind: 'http' as const, vantage: 'outside' as const,
                observerMachineId: 'controller', httpStatus: 502 } } };
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [http], null, 2000))
            .toMatchObject({ needsYou: { cause: 'http', httpStatus: 502, vantage: 'outside' } });
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [{ ...http, result: { ...http.result,
            ...diagnostics('http', { reason: 'connection' }) } }], null, 2000).needsYou).not.toHaveProperty('httpStatus');
    });
    it('keeps an outside failure distinct from a newer local success and advances known expiry only at read', () => {
        const outside = { ...certificate, kind: 'http' as const, result: { status: 'down' as const,
            observedAt: 1000, ...diagnostics('http', { reason: 'connection' }) } };
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
            observedAt: 2000, ...diagnostics('http', { reason: 'not_checked' }) } };
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [unknown], null, 2000))
            .toMatchObject({ availability: 'not_checked', observedAt: null, needsYou: null });
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [{ ...unknown,
            result: { ...unknown.result, ...diagnostics('http', { reason: 'transport_incomplete' }) } }], null, 2000))
            .toMatchObject({ availability: 'unavailable', unavailableReason: 'transport_incomplete', needsYou: null });
    });
    it('exposes unavailable DNS coverage without claiming that the address failed to answer', () => {
        const unavailable = { ...domain, dnsHealth: { status: 'unknown' as const,
            ...diagnostics('dns', { reason: 'resolver_unavailable' }) } };
        expect(projectDeploymentDomainHealthFactsV1(unavailable, content, [], null, 2000))
            .toMatchObject({ availability: 'unavailable', unavailableReason: 'resolver_unavailable', needsYou: null });
        expect(projectDeploymentDomainHealthFactsV1(unavailable, content, [], 'machine_unavailable', 2000))
            .toMatchObject({ availability: 'unavailable', unavailableReason: 'machine_unavailable', needsYou: null });
    });
    it('keeps an outside DNS failure primary while the custom certificate replacement is advisory', () => {
        const http = { ...certificate, kind: 'http' as const, result: { status: 'down' as const,
            observedAt: 2000, ...diagnostics('http', { reason: 'dns' }) } };
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [http, certificate], null, 2000))
            .toMatchObject({ certificate: { state: 'expiresSoon' }, needsYou: { cause: 'dns', vantage: 'outside' } });
    });
    it('preserves retained certificate facts from the historical finite producer', () => {
        // ce870ef1875 finiteHealthCheckResult persisted its facts in JSON evidence.
        const retained = { ...certificate, result: { status: 'up' as const, observedAt: 2000,
            evidence: { v: 1 as const, items: [{ source: { kind: 'alert' as const, label: 'certificate' },
                author: { kind: 'process' as const }, text: JSON.stringify({ kind: 'certificate',
                    vantage: 'outside', observerMachineId: 'controller', notBefore: 0, notAfter: 3000 }) }] } } };
        expect(projectDeploymentDomainHealthFactsV1(domain, content, [retained], null, 2000))
            .toMatchObject({ certificate: { state: 'expiresSoon', expiresAt: 3000 } });
    });
});


describe('Domain DNS readiness', () => {
    const health = (status: 'up' | 'down' | 'unknown', reason: string) => ({ status,
        cause: { kind: 'dns' as const, observerMachineId: 'controller', vantage: 'sameMachine' as const, reason },
        evidence: { v: 1 as const,
        items: [{ source: { kind: 'alert' as const, label: 'DNS' }, author: { kind: 'process' as const },
            text: `DNS finite observation` }] } });
    it.each([
        ['down', 'dns_missing', 'missing'],
        ['down', 'dns_not_this_machine', 'not_this_machine'],
        ['up', 'dns_ready', 'ready'],
        ['unknown', 'resolver_unavailable', 'unavailable'],
        ['unknown', 'dns_transport_unavailable', 'unavailable'],
        ['unknown', 'dns_private_listener_unavailable', 'unavailable'],
    ] as const)('projects %s/%s as %s without replacing the producer reason', (status, reason, state) => {
        expect(projectDeploymentDomainDnsReadinessV1(health(status, reason))).toEqual({ state, reason });
    });
    it('never treats legacy DNS existence alone or absent checks as proof of this Machine', () => {
        expect(projectDeploymentDomainDnsReadinessV1(undefined)).toEqual({ state: 'not_checked', reason: null });
        expect(projectDeploymentDomainDnsReadinessV1(health('up', 'dns_present')))
            .toEqual({ state: 'not_checked', reason: 'dns_present' });
        expect(projectDeploymentDomainDnsReadinessV1(health('unknown', 'not_checked')))
            .toEqual({ state: 'not_checked', reason: 'not_checked' });
    });
    it('prefers the typed cause and preserves historical DNS evidence when no cause was retained', () => {
        // ce870ef1875 finiteHealthCheckResult is the retained JSON-only producer.
        const retained = { status: 'down' as const, evidence: { v: 1 as const,
            items: [{ source: { kind: 'alert' as const, label: 'dns' }, author: { kind: 'process' as const },
                text: JSON.stringify({ kind: 'dns', vantage: 'sameMachine', observerMachineId: 'controller',
                    reason: 'dns_missing', remedy: 'Configure the DNS record, then verify again.' }) }] } };
        expect(projectDeploymentDomainDnsReadinessV1(retained)).toEqual({ state: 'missing', reason: 'dns_missing' });
        expect(projectDeploymentDomainDnsReadinessV1({ ...health('down', 'dns_not_this_machine'), evidence: retained.evidence }))
            .toEqual({ state: 'not_this_machine', reason: 'dns_not_this_machine' });
    });
});
