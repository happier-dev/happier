import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** Superserve OpenAPI 0.1.0 / sandbox ee91ea60f1e1, 2026-11-01. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, guest, body, decode, name, managedId, privateBinding } = world;
    const foreignId = 'ssb_foreign';
    return {
        foreignId, launch: { template: 'superserve/base' },
        account: { headers: { 'x-api-key': privateBinding } },
        facts: { nativeExpiry: 'with-evidence' },
        http(request, { url, path, method, isForeign, targetPresent }) {
            const native = () => ({ id: isForeign ? foreignId : 'ssb_owned', name: isForeign ? 'foreign' : name, status: s.power === 'running' ? 'active' : 'paused',
                vcpu_count: 1, memory_mib: 1024, created_at: '2026-11-01T00:00:00Z',
                metadata: { 'happier-managed-id': managedId }, access_token: privateBinding, routing_hint: privateBinding,
                ...(s.evidence ? { auto_delete_at: new Date(world.nativeExpiry).toISOString(), auto_delete_seconds: 86400 } : {}) });
            if (url.origin === 'https://sandbox.superserve.ai') {
                if (path === '/files') {
                    const target = url.searchParams.get('path');
                    if (!target) throw new Error('Missing Superserve file path');
                    mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, request.body!);
                    return { value: { path: target, size: request.body!.length } };
                }
                if (path === '/exec') {
                    const input = body(request), completed = guest([String(input.command), ...(input.args as string[])]);
                    return { value: { stdout: decode.decode(completed.stdout), stderr: decode.decode(completed.stderr),
                        exit_code: completed.termination.observed.kind === 'exit' ? completed.termination.observed.exitCode : 1 } };
                }
                throw new Error(`Unexpected Superserve guest HTTP ${method} ${path}`);
            }
            if (path === '/sandboxes' && method === 'POST') { s.allocations++; s.present = true; s.owned.add('sandbox'); return { value: native(), status: 201 }; }
            if (path === '/sandboxes') {
                const sandboxes = [...(s.present ? [native()] : []), ...(s.foreignPresent ? [{ ...native(), id: foreignId, name: 'foreign', metadata: { 'happier-managed-id': 'foreign-managed-id' } }] : [])];
                const selected = url.searchParams.get('metadata.happier-managed-id');
                return { value: selected === null ? sandboxes : sandboxes.filter(item => item.metadata['happier-managed-id'] === selected) };
            }
            if (path.endsWith('/activate')) { s.power = 'running'; return { value: native() }; }
            if (path.endsWith('/pause')) { s.power = 'suspended'; return { status: 204 }; }
            if (path.endsWith('/resume')) { s.power = 'running'; return { value: { id: 'ssb_owned', status: 'active', access_token: privateBinding, routing_hint: privateBinding } }; }
            if (method === 'DELETE') { world.remove(path.split('/').at(-1), 'ssb_owned', () => { s.present = false; s.owned.delete('sandbox'); }); return { status: 204 }; }
            return { status: targetPresent ? 200 : 404, value: native() };
        },
    };
};
