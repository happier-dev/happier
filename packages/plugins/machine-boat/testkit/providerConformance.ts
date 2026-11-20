import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** Boat REST boundary for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, managedId } = world;
    const foreignId = 'bx_98765432';
    return {
        foreignId, launch: { size: 'small', source: { kind: 'blank' } },
        facts: { nativeExpiry: 'with-evidence', stoppedAt: Date.parse('2026-11-01T12:00:00Z') },
        http(_request, { url, path, method, isForeign, targetPresent }) {
            const native = () => ({ id: isForeign ? foreignId : 'bx_23456789', state: s.power === 'running' ? 'ready' : 'archived', ttlSeconds: null,
                ...(s.evidence ? { stoppedAt: '2026-11-01T12:00:00Z', archiveAfter: new Date(world.nativeExpiry).toISOString() } : {}) });
            const operation = (targetId: string | undefined) => ({ id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox', targetId, reason: 'explicit', status: 'completed', attemptCount: 1,
                requestedAt: '2026-11-01T00:00:00Z', completedAt: '2026-11-01T00:01:00Z' });
            if (path.endsWith('/limits') && method === 'GET') return { value: { ok: true, type: 'limits.info', sandboxPlanKey: 'box_100', sandboxPlanDollars: 100, canStart: true, activeSandboxes: 0, maxActiveSandboxes: 100, billingStatus: 'active' } };
            if (path.endsWith('/saved-snapshots') && method === 'GET') return { value: { ok: true, type: 'snapshot.named.list', snapshots: [{ name: 'ready-one', status: 'ready', sourceSandboxId: 'bx_23456789', createdAt: '2026-10-12T00:00:00Z' }] } };
            if (path.endsWith('/sandboxes') && method === 'GET') return { value: { ok: true, type: 'sandbox.list', sandboxes: [...(s.present ? [{ id: 'bx_23456789', state: 'ready' }] : []), ...(s.foreignPresent ? [{ id: foreignId, state: 'ready' }] : [])]
                .filter(entry => !url.searchParams.has('label') || url.searchParams.get('label') === `happier-managed-id=${entry.id === foreignId ? 'foreign-managed-id' : managedId}`) } };
            if (path.endsWith('/sandboxes') && method === 'POST') { s.allocations++; s.present = true; s.owned.add('sandbox'); return { value: { ok: true, sandbox: native() }, status: 202 }; }
            if (path.endsWith('/sshkey')) return { value: { ok: true, type: 'ssh_key.configured', success: true, machineIp: '203.0.113.8', sshUser: 'user', hostKey: world.publicKey } };
            if (path.endsWith('/stop') || path.endsWith('/resume')) { s.power = path.endsWith('/stop') ? 'stopped' : 'running'; return { value: { ok: true, sandbox: native() }, status: 202 }; }
            if (method === 'DELETE') {
                world.remove(path.split('/').at(-1), 'bx_23456789', () => { s.present = false; s.owned.delete('sandbox'); });
                return { value: { ok: true, type: 'deletion.operation', operation: operation(path.split('/').at(-1)) }, status: 202 };
            }
            if (path.includes('/deletion-operations/')) return { value: { ok: true, type: 'deletion.operation', operation: operation('bx_23456789') } };
            return { value: targetPresent ? { ok: true, type: 'sandbox.info', sandbox: native() } : { ok: false, code: 'not_found' }, status: targetPresent ? 200 : 404 };
        },
    };
};
