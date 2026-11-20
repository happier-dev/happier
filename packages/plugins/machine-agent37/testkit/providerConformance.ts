import type { ProviderConformanceExpectedFailures, ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';
import { Agent37LaunchSchema } from '../src/machine/schemas.js';

/** Agent37 REST boundary for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, guest, body, decode } = world;
    const foreignId = 'ff12cd34ef';
    return {
        foreignId, launch: Agent37LaunchSchema.parse({ kind: 'vm', size: '2-4', region: 'us' }),
        account: { headers: { authorization: `Bearer ${world.privateBinding}`, 'x-agent37-key': world.privateBinding } },
        http(request, { path, method, isForeign, targetPresent }) {
            const native = () => ({ id: isForeign ? foreignId : 'ab12cd34ef', status: s.power === 'running' ? 'running' : 'stopped', type: 'vm', auto_sleep: false });
            if (path.endsWith('/exec')) {
                const completed = guest(['sh', '-c', String(body(request).command)]);
                return { value: { exit_code: completed.termination.observed.kind === 'exit' ? completed.termination.observed.exitCode : 1,
                    stdout: decode.decode(completed.stdout), stderr: decode.decode(completed.stderr), truncated: false } };
            }
            if (path === '/v1/instances' && method === 'POST') { s.allocations++; s.present = true; s.owned.add('instance'); return { value: native(), status: 201 }; }
            if (path === '/v1/instances') return { value: { data: [...(s.present ? [native()] : []), ...(s.foreignPresent ? [{ ...native(), id: foreignId }] : [])] } };
            if (path.endsWith('/stop') || path.endsWith('/start')) { s.power = path.endsWith('/stop') ? 'stopped' : 'running'; return { value: native() }; }
            if (method === 'DELETE') { world.remove(path.split('/').at(-1), 'ab12cd34ef', () => { s.present = false; s.owned.delete('instance'); }); return { value: { id: path.split('/').at(-1), deleted: true } }; }
            return { status: targetPresent ? 200 : 404, value: targetPresent ? native() : { error: { code: 'not_found' } } };
        },
    };
};

/** Shared cases this provider is known to fail and the owner fixing each; the owner deletes its entry with the fix. */
export const providerConformanceExpectedFailures: ProviderConformanceExpectedFailures = {};
