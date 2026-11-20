import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderConformanceExpectedFailures, ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';
import { MaritimeLaunchSchema } from '../src/machine/schemas.js';
import { SandboxLaunchSchema } from '../src/sandbox/schemas.js';

const dataOrigin = 'https://maritime-sandbox.example.test';

/** Maritime agent-box and sandbox REST boundaries for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, guest, body, decode, name, managedId, privateBinding, directory } = world;
    const foreignId = 'box-foreign';
    if (world.contribution === 'maritime-sandbox') return {
        foreignId, launch: SandboxLaunchSchema.parse({ from: 'base', vcpu: 1, memoryMib: 1024, diskGib: 5 }),
        // Maritime's SDK sends its sandbox token through native fetch, separately
        // from the account-authenticated control plane. Both reach this HTTP owner.
        dataOrigin,
        http(request, { url, path, method, isForeign, targetPresent }) {
            const native = () => ({ id: isForeign ? foreignId : 'sandbox-owned', name: isForeign ? 'foreign' : name,
                state: s.power === 'running' ? 'running' : 'paused', forEndUser: true, dataPlaneUrl: dataOrigin, secret: privateBinding });
            if (url.origin === dataOrigin) {
                if (path === '/commands') {
                    s.power = 'running';
                    const completed = guest(body(request).cmd as string[]);
                    return { value: { state: 'exited', exitCode: completed.termination.observed.kind === 'exit' ? completed.termination.observed.exitCode : 1,
                        stdout: decode.decode(completed.stdout), stderr: decode.decode(completed.stderr), truncated: false } };
                }
                if (path === '/files') { writeFileSync(url.searchParams.get('path')!, request.body!); return { status: 204 }; }
                throw new Error(`Unexpected Maritime sandbox guest HTTP ${method} ${path}`);
            }
            if (path === '/api/v1/account/limits') return { value: { plan: 'growth', machines: 0, awakeMachines: 0 } };
            if (path === '/v1/sandboxes' && method === 'POST') { s.allocations++; s.present = true; s.owned.add('sandbox'); return { value: native(), status: 201 }; }
            if (path.endsWith('/pause')) { s.power = 'suspended'; return { value: native() }; }
            if (method === 'DELETE') { world.remove(path.split('/').at(-1), 'sandbox-owned', () => { s.present = false; s.owned.delete('sandbox'); }); return { status: 204 }; }
            return targetPresent ? { value: native() } : { status: 404, value: { code: 'sandbox_not_found' } };
        },
    };
    return {
        foreignId, launch: MaritimeLaunchSchema.parse({ kind: 'agent-box', memMb: 2048, diskGb: 5, alwaysOn: true, templateId: 'zeroclaw' }),
        async http(request, { url, path, method, isForeign, targetPresent }) {
            const native = () => ({ id: isForeign ? foreignId : 'box-one', name: isForeign ? 'foreign-managed-id' : managedId, externalId: isForeign ? 'foreign-managed-id' : managedId, framework: 'zeroclaw', tier: 'always_on',
                status: s.power === 'running' ? 'active' : s.power === 'suspended' ? 'sleeping' : 'stopped', invocationCount: 0, createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' });
            if (path === '/api/v1/account/limits') return { value: { plan: 'growth', machines: 0, awakeMachines: 0 } };
            if (path.endsWith('/exec')) {
                const command = body(request).command;
                if (!Array.isArray(command) || !command.every(arg => typeof arg === 'string')) throw new Error('Invalid Maritime argv');
                const completed = guest(command.map(arg => arg.replaceAll('/data', directory)));
                return { value: { executionId: 'execution-one', status: 'completed', exitCode: completed.termination.observed.kind === 'exit' ? completed.termination.observed.exitCode : 1,
                    stdout: command[0] === 'mktemp' ? decode.decode(completed.stdout).replaceAll(directory, '/data') : decode.decode(completed.stdout),
                    stderr: decode.decode(completed.stderr) } };
            }
            if (path.endsWith('/resize')) return { value: { ok: true, alwaysOn: true, memMb: null, diskGb: null, appliesOn: 'immediate', billingPreview: null } };
            if (path.endsWith('/files/upload')) {
                const form = await new Response(new Uint8Array(request.body!), { headers: request.headers }).formData();
                const file = form.get('file');
                if (!(file instanceof File) || typeof form.get('dest_dir') !== 'string') throw new Error('Invalid Maritime upload');
                writeFileSync(join(String(form.get('dest_dir')).replaceAll('/data', directory), file.name), new Uint8Array(await file.arrayBuffer())); return { status: 204 };
            }
            if (path.endsWith('/files')) { writeFileSync(url.searchParams.get('path')!, request.body!); return { status: 204 }; }
            if (path === '/api/agents' && method === 'POST') { s.allocations++; s.present = true; s.owned.add('box'); return { value: native(), status: 201 }; }
            if (path === '/api/agents') return { value: [...(s.present ? [native()] : []), ...(s.foreignPresent ? [{ ...native(), id: foreignId, name: 'foreign', externalId: 'foreign-managed-id' }] : [])]
                .filter(entry => !url.searchParams.has('externalId') || entry.externalId === url.searchParams.get('externalId')) };
            if (path.endsWith('/stop') || path.endsWith('/sleep') || path.endsWith('/start') || path.endsWith('/wake')) {
                s.power = path.endsWith('/stop') ? 'stopped' : path.endsWith('/sleep') ? 'suspended' : 'running'; return { value: native() };
            }
            if (method === 'DELETE') { world.remove(path.split('/').at(-1), 'box-one', () => { s.present = false; s.owned.delete('box'); }); return { status: 204 }; }
            return { status: targetPresent ? 200 : 404, value: native() };
        },
    };
};

/** Shared cases this provider is known to fail and the owner fixing each; the owner deletes its entry with the fix. */
export const providerConformanceExpectedFailures: ProviderConformanceExpectedFailures = {
    'maritime-sandbox': { powerReplyLost: 'MACH-CORE-SEAMS-1120 F1, one native-intent settlement owner settles a thrown power effect (O-MACH board 2026-11-19 23:26Z)' },
};
