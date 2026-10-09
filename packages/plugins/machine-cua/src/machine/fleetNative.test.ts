import { describe, expect, it, vi } from 'vitest';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { createCuaNativeClient } from './nativeClient.js';
import { createCuaFleet, decodeFleetClaim } from './fleet.js';

const launch = { namespace: 'reviewed-pool', runtimeId: 'kubevirt', imageId: 'ghcr.io/acme/linux:chosen',
    sizeId: 'reviewed-pool', nativeLease: { durationSeconds: 7200 } };
const resource = { namespace: 'reviewed-pool', claimId: 'our-claim' };
const now = Date.parse('2026-10-08T12:00:00Z');
const pool = { metadata: { name: launch.namespace, namespace: launch.namespace },
    spec: { sandboxTemplateRef: { name: 'template-one' } } };
const template = { metadata: { name: 'template-one', namespace: launch.namespace },
    spec: { vmTemplate: { containerDiskImage: launch.imageId, runtime: launch.runtimeId,
        cpuCores: 4, memory: '8Gi', services: [{ name: 'env', targetPort: 3211 }] } } };
function claim(phase = 'Pending', sandboxId?: string) {
    return { metadata: { name: resource.claimId, namespace: resource.namespace,
        creationTimestamp: '2026-10-08T11:00:00Z' },
    spec: { sandboxTemplateRef: { name: 'template-one' }, ttlSecondsAfterCreated: 7200 },
    status: { phase, ...(sandboxId && { sandbox: { name: sandboxId } }) } };
}
type Response = { status: number; value?: unknown } | Error;
function harness(...responses: Response[]) {
    const requests: Parameters<HttpService['request']>[0][] = [];
    // Only the authenticated native HTTP boundary is substituted. Client,
    // routes, strict input validation and identity/expiry decoding stay real.
    const request = vi.fn(async (input: Parameters<HttpService['request']>[0]) => {
        requests.push(input);
        const next = responses.shift();
        if (!next || next instanceof Error) throw next ?? new Error('Unexpected native request');
        return { status: next.status, finalUrl: input.url, headers: {},
            body: new TextEncoder().encode(next.value === undefined ? '' : JSON.stringify(next.value)) };
    });
    const run = vi.fn(async () => { throw new Error('Fleet must not invoke heartbeat-owning CLI'); });
    const native = createCuaNativeClient({ exec: { run }, executable: { kind: 'systemTool', id: 'cua' },
        fleet: { http: { request }, origin: 'https://fleet.example/', headers: { authorization: 'Bearer controller-private' } } });
    return { fleet: createCuaFleet(native), requests, run };
}
const ok = (value: unknown) => ({ status: 200, value });
const missing = { status: 404 };

describe('Fleet native exact claim operations', () => {
    it('projects the reviewed native pool and template with the explicit finite lease, without changing capacity', async () => {
        const h = harness(ok(pool), ok(template));
        expect(await h.fleet.options({ namespace: launch.namespace, nativeLease: launch.nativeLease })).toEqual({ choices: [{
            id: launch.namespace, title: { key: 'machineCua.fleet.nativeChoice', fallback: 'reviewed-pool · kubevirt · 4 CPU · 8Gi' },
            launch, available: true, nativeFacts: {
                size: { id: launch.namespace, title: 'reviewed-pool · kubevirt · 4 CPU · 8Gi', cpuCores: 4 },
                image: { id: launch.imageId, title: launch.imageId }, location: { id: launch.namespace, title: launch.namespace } },
        }] });
        expect(h.requests.map(request => request.method)).toEqual(['GET', 'GET']);
        expect(h.run).not.toHaveBeenCalled();
        const wrong = harness(ok({ ...pool, metadata: { ...pool.metadata, namespace: 'neighbor' } }));
        await expect(wrong.fleet.options({ namespace: launch.namespace, nativeLease: launch.nativeLease }))
            .rejects.toMatchObject({ code: 'native_options_unavailable' });
        const invalid = harness();
        await expect(invalid.fleet.options({ namespace: launch.namespace, nativeLease: { durationSeconds: 0 } })).rejects.toThrow();
        expect(invalid.requests).toEqual([]);
    });
    it('requires the current native bound sandbox identity rather than filling it from stored identity', () => {
        expect(decodeFleetClaim({ name: resource.claimId, namespace: resource.namespace,
            json: JSON.stringify(claim('Bound')) }, { ...resource, sandboxId: 'old-binding' }, now))
            .toEqual({ kind: 'unknown', resource: { ...resource, sandboxId: 'old-binding' } });
    });
    it('preserves the returned native sandbox identity without imposing claim-route name limits on it', async () => {
        const h = harness(ok(claim('Bound', 'native.sandbox')));
        expect(await h.fleet.attach(resource, now)).toMatchObject({ kind: 'bound',
            resource: { ...resource, sandboxId: 'native.sandbox' } });
        expect(h.requests[0]?.url).toBe('https://fleet.example/api/k8s/apis/osgym.cua.ai/v1alpha1/namespaces/reviewed-pool/osgymsandboxclaims/our-claim');
    });
    it('claims without waiting or renewing, preserving the admitted identity before binding', async () => {
        const h = harness(ok(pool), ok(template), missing, { status: 201, value: claim() });
        expect(await h.fleet.create(launch, 'our-claim', now)).toMatchObject({ kind: 'pending', resource,
            nativeExpiryAt: Date.parse('2026-10-08T13:00:00Z'), resume: 'unsupported' });
        const effect = h.requests[3];
        expect(effect?.method).toBe('POST');
        expect(effect?.url).toBe('https://fleet.example/api/k8s/apis/osgym.cua.ai/v1alpha1/namespaces/reviewed-pool/osgymsandboxclaims');
        expect(JSON.parse(new TextDecoder().decode(effect?.body))).toEqual({ apiVersion: 'osgym.cua.ai/v1alpha1',
            kind: 'OSGymSandboxClaim', metadata: { name: 'our-claim', namespace: 'reviewed-pool' },
            spec: { sandboxTemplateRef: { name: 'template-one' }, bindDeadline: 900, ttlSecondsAfterCreated: 7200 } });
        expect(h.run).not.toHaveBeenCalled();
    });
    it('preserves exact recovery after a dropped claim response and attaches only by read', async () => {
        const h = harness(ok(pool), ok(template), missing, new Error('lost response'), ok(claim('Bound', 'sandbox-one')));
        expect(await h.fleet.create(launch, 'our-claim', now)).toEqual({ kind: 'unknown', recovery: resource });
        expect(await h.fleet.attach(resource, now)).toMatchObject({ kind: 'bound', resource: { ...resource, sandboxId: 'sandbox-one' } });
        expect(h.requests.map(r => r.method)).toEqual(['GET', 'GET', 'GET', 'POST', 'GET']);
    });
    it('reattaches an existing exact claim without another POST and rejects template drift before acquisition', async () => {
        const h = harness(ok(pool), ok(template), ok(claim('Bound', 'sandbox-one')));
        expect(await h.fleet.create(launch, 'our-claim', now)).toMatchObject({ kind: 'bound', resource: { ...resource, sandboxId: 'sandbox-one' } });
        expect(h.requests.every(r => r.method === 'GET')).toBe(true);
        const drift = harness(ok(pool), ok({ ...template, spec: { vmTemplate: { ...template.spec.vmTemplate, runtime: 'gvisor' } } }));
        expect(await drift.fleet.create(launch, 'our-claim', now)).toMatchObject({ kind: 'unavailable', reason: 'native_selection_mismatch' });
        expect(drift.requests.every(r => r.method === 'GET')).toBe(true);
    });
    it('recovers a concurrent exact-name claim and rejects a neighboring or differently leased response', async () => {
        const h = harness(ok(pool), ok(template), missing, { status: 409 }, ok(claim('Bound', 'sandbox-one')));
        expect(await h.fleet.create(launch, 'our-claim', now)).toMatchObject({ kind: 'bound', resource: { ...resource, sandboxId: 'sandbox-one' } });
        const other = claim();
        other.metadata.name = 'other-claim';
        expect(await harness(ok(pool), ok(template), missing, { status: 201, value: other }).fleet.create(launch, 'our-claim', now))
            .toEqual({ kind: 'unknown', recovery: resource });
        const differentLease = claim();
        differentLease.spec.ttlSecondsAfterCreated = 3600;
        expect(await harness(ok(pool), ok(template), ok(differentLease)).fleet.create(launch, 'our-claim', now))
            .toEqual({ kind: 'unknown', recovery: resource });
    });
    it('keeps authorization and transport failures unknown while authenticated missing is absent', async () => {
        for (const response of [{ status: 401 }, { status: 403 }, new Error('gateway unreachable')]) {
            expect(await harness(response).fleet.inspect(resource, now)).toMatchObject({ kind: 'unknown', existence: 'unknown', resource });
        }
        expect(await harness(missing).fleet.inspect(resource, now)).toMatchObject({ kind: 'absent', existence: 'absent', resource });
    });
    it('projects canonical provider facts without inferring power, billing rates or absence from claim expiry', async () => {
        const h = harness(ok(claim()), ok(claim('Bound', 'sandbox-one')), missing, { status: 403 });
        const facts = { observedAt: now, availability: 'present', power: 'unknown',
            billing: { location: 'cloud', stoppedBilling: 'unknown' }, nativeExpiry: Date.parse('2026-10-08T13:00:00Z') };
        expect(await h.fleet.observe(resource, now)).toEqual(facts);
        expect(await h.fleet.observe(resource, now)).toEqual(facts);
        expect(await h.fleet.observe(resource, now)).toEqual({ observedAt: now, availability: 'absent', power: 'unknown',
            billing: facts.billing });
        expect(await h.fleet.observe(resource, now)).toEqual({ observedAt: now, availability: 'unavailable', power: 'unknown',
            billing: facts.billing, reason: 'native_claim_unknown' });
        const expiredAt = Date.parse('2026-10-08T14:00:00Z');
        expect(await harness(ok(claim('Bound', 'sandbox-one'))).fleet.observe(resource, expiredAt))
            .toEqual({ ...facts, observedAt: expiredAt });
    });
    it('marks an expired claim ended without declaring absence or acquiring replacement compute', async () => {
        const h = harness(ok(claim('Bound', 'sandbox-one')));
        expect(await h.fleet.attach({ ...resource, sandboxId: 'sandbox-one' }, Date.parse('2026-10-08T14:00:00Z')))
            .toMatchObject({ kind: 'ended', existence: 'present', resume: 'unsupported' });
        expect(h.requests.map(r => r.method)).toEqual(['GET']);
        const wrong = harness(ok(claim('Bound', 'replacement')));
        expect(await wrong.fleet.attach({ ...resource, sandboxId: 'original' }, now)).toMatchObject({ kind: 'unknown', resource: { ...resource, sandboxId: 'original' } });
        expect(await harness(new Error('lost attach response')).fleet.attach({ ...resource, sandboxId: 'original' }, now))
            .toMatchObject({ kind: 'unknown', resource: { ...resource, sandboxId: 'original' } });
        for (const phase of ['Error', 'Expired']) {
            expect(await harness(ok(claim(phase))).fleet.inspect(resource, now)).toMatchObject({ kind: 'ended', existence: 'present' });
        }
        const { status: _status, ...newClaim } = claim();
        expect(await harness(ok(newClaim)).fleet.attach(resource, now)).toMatchObject({ kind: 'pending', resource });
    });
    it('releases only the exact claim and verifies disappearance after an accepted delete', async () => {
        const h = harness(ok(claim('Bound', 'sandbox-one')), { status: 202 }, missing);
        expect(await h.fleet.release(resource, now)).toEqual({ kind: 'released', existence: 'absent', resource });
        expect(h.requests.map(r => [r.method, r.url])).toEqual(['GET', 'DELETE', 'GET'].map(method => [method,
            'https://fleet.example/api/k8s/apis/osgym.cua.ai/v1alpha1/namespaces/reviewed-pool/osgymsandboxclaims/our-claim']));
        const stillPresent = harness(ok(claim()), { status: 202 }, ok(claim()));
        expect(await stillPresent.fleet.release(resource, now)).toMatchObject({ kind: 'unknown', existence: 'unknown' });
        const denied = harness({ status: 403 });
        expect(await denied.fleet.release(resource, now)).toMatchObject({ kind: 'unknown' });
        expect(denied.requests).toHaveLength(1);
    });
    it('rejects invalid native path identifiers before any request and honors cancellation', async () => {
        const h = harness();
        await expect(h.fleet.create({ ...launch, namespace: '../another' }, 'our-claim', now)).rejects.toThrow();
        await expect(h.fleet.attach(resource, now, AbortSignal.abort())).rejects.toThrow();
        expect(h.requests).toHaveLength(0);
    });
});
