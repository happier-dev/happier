import { writeFileSync } from 'node:fs';
import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';
import { DOCKER_ACCOUNT_SERVICE } from '../src/machine/dockerAccount.js';
import { LaunchSchema as CloudLaunchSchema } from '../src/cloud/schemas.js';
import { sandboxFixture, endpointCredentialFixture } from '../src/cloud/fixtures.js';

/** Docker Sandboxes CLI (local) and Docker cloud REST boundaries for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, result, guest, body, managedId, privateBinding } = world;
    const account = { service: DOCKER_ACCOUNT_SERVICE, environment: { DOCKER_ID: 'fixture-user', DOCKER_PAT: privateBinding } };
    if (world.contribution === 'docker-cloud') {
        const foreignId = 'foreign';
        return {
            foreignId, account, launch: CloudLaunchSchema.parse({ imageRef: 'ubuntu:24.04', cpus: 2, memoryMib: 4096, timeoutSeconds: 3600 }),
            // Lost-reply recovery lists by label and reports a missing sandbox as unknown (src/cloud/nativeClient.ts recover), never as proven absence.
            http(request, { url, path, method, isForeign, targetPresent }) {
                const native = (id = 'fixture') => ({ ...sandboxFixture, name: `sandboxes/${id}`, uid: id,
                    core: { ...sandboxFixture.core, status: s.power, labels: { 'happier-managed-id': id === 'fixture' ? managedId : 'foreign-managed-id' } },
                    effectiveFeatures: s.evidence ? { timeouts: { expiresAt: new Date(world.nativeExpiry).toISOString() } } : {} });
                if (url.hostname === 'hub.docker.com') return { value: { access_token: privateBinding } };
                if (url.hostname === 'sandbox.invalid') {
                    if (path.endsWith('/files/content')) {
                        writeFileSync(url.searchParams.get('path')!, request.body!, { mode: Number(url.searchParams.get('mode') ?? 0o600) }); return { status: 204 };
                    }
                    if (path.endsWith('/processes/exec')) {
                        const completed = guest(body(request).cmd as string[]);
                        return { value: { exitCode: completed.termination.observed.kind === 'exit' ? completed.termination.observed.exitCode : 1,
                            stdout: Buffer.from(completed.stdout).toString('base64'), stderr: Buffer.from(completed.stderr).toString('base64'), incomplete: false } };
                    }
                    throw new Error(`Unexpected Docker cloud guest HTTP ${method} ${path}`);
                }
                if (path.endsWith('/endpoint-credentials')) return { value: endpointCredentialFixture };
                if (path.endsWith('/sandboxes') && method === 'POST') { s.allocations++; s.present = true; s.owned.add('sandbox'); return { value: native(), status: 201 }; }
                if (path.endsWith('/sandboxes')) return { value: { sandboxes: [...(s.present ? [native()] : []), ...(s.foreignPresent ? [native(foreignId)] : [])] } };
                if (path.endsWith('/start') || path.endsWith('/stop')) { s.power = path.endsWith('/start') ? 'running' : 'stopped'; return { value: native() }; }
                if (method === 'DELETE') { world.remove(path.split('/').at(-1), 'fixture', () => { s.present = false; s.owned.delete('sandbox'); }); return { status: 204 }; }
                return { status: targetPresent ? 200 : 404, value: targetPresent ? native(isForeign ? foreignId : 'fixture') : { code: 'notFound' } };
            },
        };
    }
    let instance = '';
    return {
        foreignId: 'happier-foreign', account, launch: { name: 'happier-conformance', templateId: 'shell-base:latest' },
        // The local sandbox listing proves exact absence of a deleted sandbox.
        facts: { provesAbsenceAfterDelete: true },
        process(request, args) {
            if (args[0] === 'template') return result('shell-base:latest\n');
            if (args[0] === 'create') { s.allocations++; s.present = true; instance = args[args.indexOf('--name') + 1]!; s.owned.add('sandbox'); }
            if (args[0] === 'ls') return result({ sandboxes: [...(s.present ? [{ name: instance, status: s.power, guest_unresponsive: false }] : []), ...(s.foreignPresent ? [{ name: world.foreignId, status: 'running', guest_unresponsive: false }] : [])] });
            if (args[0] === 'stop') s.power = 'stopped';
            if (args[0] === 'run') s.power = 'running';
            if (args[0] === 'rm') for (const target of args.slice(1).filter(arg => !arg.startsWith('-'))) world.remove(target, instance, () => { s.present = false; s.owned.delete('sandbox'); });
            if (args[0] === 'exec') return guest(args.slice(args.indexOf('--') + 2), request.stdin);
            return result('');
        },
    };
};
