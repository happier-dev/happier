import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** Public REST v2 / official @upstash/box 0.7.10, 170dd8b98821 (2026-11-01). */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, guest, body, decode, name } = world;
    const foreignId = 'box-foreign';
    return {
        foreignId, launch: { runtime: 'node', size: 'small' },
        account: { headers: { 'x-box-api-key': world.privateBinding } },
        http(request, { url, path, method, isForeign, targetPresent }) {
            const native = () => ({ id: isForeign ? foreignId : 'box-owned', name: isForeign ? 'foreign' : name, labels: ['happier-managed'],
                status: s.power === 'running' ? 'idle' : 'paused', runtime: 'node', size: 'small', keep_alive: false, created_at: 1000, updated_at: 2000 });
            if (path === '/v2/box' && method === 'GET') return { value: url.searchParams.get('label') === 'happier-access-check' ? [] : [...(s.present ? [native()] : []), ...(s.foreignPresent ? [{ ...native(), id: foreignId, name: 'foreign', labels: ['happier-managed'] }] : [])] };
            if (path === '/v2/box' && method === 'POST') { s.allocations++; s.present = true; s.owned.add('box'); return { value: native() }; }
            if (path.endsWith('/exec')) {
                const output = guest(body(request).command as string[]);
                return { value: { exit_code: output.termination.observed.kind === 'exit' ? output.termination.observed.exitCode : 1,
                    output: decode.decode(output.stdout), error: decode.decode(output.stderr) } };
            }
            if (path.endsWith('/files/write')) {
                const input = body(request), target = String(input.path);
                mkdirSync(join(target, '..'), { recursive: true });
                writeFileSync(target, Buffer.from(String(input.content), 'base64')); return { value: {} };
            }
            if (path.endsWith('/startup')) return { value: {} };
            if (path.endsWith('/pause') || path.endsWith('/resume')) { s.power = path.endsWith('/pause') ? 'stopped' : 'running'; return { value: {} }; }
            if (method === 'DELETE') { world.remove(path.split('/').at(-1), 'box-owned', () => { s.present = false; s.owned.delete('box'); }); return { value: {} }; }
            return { status: targetPresent ? 200 : 404, value: targetPresent ? native() : { error: 'Box not found' } };
        },
    };
};
