import { railwayVendor } from '../../../../../packages/plugins/machine-railway/testkit/vendor.js';
import { Agent37LaunchSchema } from '../../../../../packages/plugins/machine-agent37/src/machine/schemas.js';
import { MaritimeLaunchSchema } from '../../../../../packages/plugins/machine-maritime/src/machine/schemas.js';
import { CoderLaunchSchema, ACCOUNT_SERVICE as CODER_ACCOUNT_SERVICE } from '../../../../../packages/plugins/machine-coder/src/machine/schemas.js';
import { coderWorkspaceName } from '../../../../../packages/plugins/machine-coder/src/machine/nativeClient.js';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { PluginExecSpawnRequest, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildSync } from 'esbuild';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';

export const PRIVATE_BINDING = 'conformance-private-credential-binding';
export const PUBLIC_KEY = 'ssh-ed25519 AQIDBA==';
export const MANAGED_ID = 'cmvnxb7gn009mmcagisyszwlh';
export const NATIVE_EXPIRY = Date.parse('2026-11-03T12:00:00Z');
const text = new TextEncoder();
const decode = new TextDecoder('utf-8', { ignoreBOM: true });
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected vendor object');
    return value as Record<string, unknown>;
}
function body(request: HttpRequest) { return object(JSON.parse(decode.decode(request.body))); }
export type ProviderFixture = ReturnType<typeof cloudFixture>;

/** Stateful vendor boundary only: public registration, roles, codecs and managed owners stay real. */
export function cloudFixture(leaf: string, contribution: string) {
    const directory = mkdtempSync(join(tmpdir(), 'happier-provider-conformance-'));
    const modalState = join(directory, 'modal-state.json');
    const modalPreload = join(directory, 'preload.mjs');
    const modalEntry = join(directory, 'worker.mjs');
    if (leaf === 'machine-modal') {
        writeFileSync(modalState, JSON.stringify({ present: false, failure: false, allocations: 0, foreignPresent: true }));
        writeFileSync(join(directory, 'loader.mjs'), `export async function resolve(specifier, context, nextResolve) { return specifier === 'modal' ? { url: ${JSON.stringify(new URL('./providerConformance.modal-fixture.mjs', import.meta.url).href)}, shortCircuit: true } : nextResolve(specifier, context); }`);
        // Compile the current private worker; its real roles/native client are bundled unchanged.
        buildSync({ entryPoints: [new URL('../../../../../packages/plugins/machine-modal/src/machine/sdkWorker.ts', import.meta.url).pathname], outfile: modalEntry, bundle: true, platform: 'node', format: 'esm', external: ['modal'],
            banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
        writeFileSync(modalPreload, `import { register } from 'node:module'; register(new URL('./loader.mjs', import.meta.url));`);
    }
    const railway = leaf === 'machine-railway' ? railwayVendor() : undefined;
    const calls: HttpRequest[] = [];
    const processes: PluginExecSpawnRequest[] = [];
    let instance = '', spacePresent = false;
    const logs: unknown[] = [];
    const owned = new Set<string>();
    let allocations = 0, foreignPresent = true;
    const foreignId = ({
        'machine-agent37': 'ff12cd34ef', 'machine-maritime': 'box-foreign', 'machine-coder': 'workspace-foreign',
        'machine-superserve': 'ssb_foreign', 'machine-e2b': 'e2b-foreign', 'machine-upstash-box': 'box-foreign',
        'machine-freestyle': 'vm-foreign', 'machine-daytona': 'sandbox-foreign', 'machine-boat': 'bx_98765432',
        'machine-hetzner': '99', 'machine-digitalocean': '43', 'machine-fly': 'machine-foreign',
        'machine-crabbox': 'cbx_111111111111',
        'machine-cua': `${contribution === 'byoc' ? 'aws' : 'local'}:happier-foreign`,
        'devcontainer': 'b'.repeat(64),
    } as Record<string, string>)[leaf] ?? 'happier-foreign';
    // Each external delete addresses one native identity, never the fixture's sole resource.
    function remove(target: string | undefined, expected: string, effect: () => void) {
        if (target === foreignId) { foreignPresent = false; return; }
        if (target !== expected) throw new Error(`Unexpected ${leaf} deletion target: ${target}`);
        effect();
    }
    let present = false, power = 'running', failure = false, evidence = false;
    const leaseId = `cbx_${createHash('sha256').update(MANAGED_ID).digest('hex').slice(0, 12)}`;
    const name = `happier-${MANAGED_ID}`;
    const commands = new Map<string, { command: string; args: string[]; stdin: Buffer[]; output?: string; stderr?: string; exitCode?: number }>();
    let flyConfig: unknown = {};
    const launch: Record<string, unknown> = leaf === 'machine-boat' ? { size: 'small', source: { kind: 'blank' } }
        : leaf === 'machine-agent37' ? Agent37LaunchSchema.parse({ kind: 'vm', size: '2-4', region: 'us' })
        : leaf === 'machine-maritime' ? MaritimeLaunchSchema.parse({ kind: 'agent-box', memMb: 2048, diskGb: 5, alwaysOn: true, templateId: 'zeroclaw' })
        : leaf === 'machine-coder' ? CoderLaunchSchema.parse({ organizationId: 'org', templateId: 'template', templateVersionId: 'version', agentName: 'main', parameterValues: [] })
        : leaf === 'machine-e2b' ? { templateId: 'base', timeoutSeconds: 300 }
        : leaf === 'machine-freestyle' ? { snapshotId: 'freestyle/ubuntu' }
        : leaf === 'machine-railway' ? { environmentId: 'environment-one' }
        : leaf === 'machine-superserve' ? { template: 'superserve/base' }
        : leaf === 'machine-daytona' ? { snapshot: 'daytona-small' }
        : leaf === 'machine-upstash-box' ? { runtime: 'node', size: 'small' }
        : leaf === 'machine-hetzner' ? { serverTypeId: 'cx23', imageId: 'ubuntu-24.04', locationId: 'fsn1', publicNetworking: { ipv4: true, ipv6: false } }
        : leaf === 'machine-digitalocean' ? { regionSlug: 'nyc3', sizeSlug: 's-1vcpu-1gb', imageId: 1, publicNetworking: { ipv6: false } }
        : leaf === 'machine-crabbox' ? { backendId: 'aws', transport: 'coordinator', namespace: 'test-org', target: 'linux', nativeImageId: 'ami-test', nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 }
        : leaf === 'machine-fly' ? { app: { name, ownership: 'created', organizationSlug: 'test-org' }, region: 'ord', imageReference: 'ubuntu:24.04', guest: { cpuKind: 'shared', cpus: 1, memoryMb: 512 }, volume: { kind: 'create', sizeGb: 1 } }
        : leaf === 'machine-lima' ? { store: join(directory, 'lima'), image: 'https://example.test/ubuntu.img', arch: 'x86_64', vmType: 'qemu', cpus: 2, memoryGiB: 4, diskGiB: 20, mounts: [] }
        : leaf === 'machine-lume' ? { storage: 'external_disk', cpu: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 20 * 1024 ** 3, image: { kind: 'native-image', reference: 'registry.example/team/linux:prepared', privateCarrier: { kind: 'lume-default-password', guestOs: 'linux', user: 'owner' } } }
        : leaf === 'machine-docker-sandboxes' ? { name: 'happier-conformance', templateId: 'shell-base:latest' }
        : leaf === 'machine-cua' ? contribution === 'byoc' ? { cloud: 'aws', region: 'us-west-2', nativeImageId: 'linux', nativeSizeId: 't3.medium', nativeLifetime: { kind: 'no-native-ttl' } } : { on: 'local', runtimeId: 'qemu', imageId: 'ghcr.io/trycua/linux:24.04-disk', size: { cpu: 4, memoryBytes: 4 * 1024 ** 3, diskBytes: 20 * 1024 ** 3 } }
        : leaf === 'machine-modal' ? { appReference: 'conformance', imageReference: 'ubuntu:24.04', resources: { cpu: 0.125, memoryMb: 512 }, timeoutMs: 300000 }
        : leaf === 'devcontainer' ? { workspaceFolder: directory, configPath: join(directory, '.devcontainer', 'devcontainer.json') }
        : { image: 'vercel/sandbox/universal:latest', region: 'iad1', vcpus: 2, timeoutMs: 300000, snapshotExpirationMs: 0 };
    if (leaf === 'machine-crabbox' && contribution === 'crabbox') { delete launch.nativeSizeId; Object.assign(launch, { backendId: 'local-container', transport: 'direct', nativeImageId: 'ubuntu:24.04', localContainerRuntime: 'docker' }); }
    if (leaf === 'devcontainer') {
        mkdirSync(join(directory, '.devcontainer'));
        writeFileSync(String(launch.configPath), JSON.stringify({ image: 'example:latest', remoteUser: 'coder', workspaceFolder: '/work/custom' }));
    }
    function result(value: unknown = '', exitCode = 0): PluginProcessResult {
        return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
            stdout: text.encode(typeof value === 'string' ? value : JSON.stringify(value)), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
    }
    function guest(argv: readonly string[], stdin?: Uint8Array): PluginProcessResult {
        if (argv.some(arg => arg === 'uname -s; uname -m; printf "%s\\n" "$HOME"')) return result(`Linux\nx86_64\n${directory}\n`);
        const completed = spawnSync(argv[0]!, argv.slice(1), { input: stdin, env: { ...process.env, HOME: directory } });
        if (completed.error) throw completed.error;
        return { ...result('', completed.status ?? 1), stdout: completed.stdout, stderr: completed.stderr };
    }
    async function processRequest(request: PluginExecSpawnRequest): Promise<PluginProcessResult> {
        processes.push(request);
        if (failure) return { ...result(PRIVATE_BINDING, 1), stderr: text.encode(PRIVATE_BINDING) };
        const args = request.args ?? [];
        if (request.executable.kind === 'systemTool' && request.executable.id === 'ssh-keyscan') return result(`203.0.113.8 ${PUBLIC_KEY}\n`);
        if (leaf === 'machine-lume') return result(''); // native public-key installation over Lume SSH
        if (leaf === 'machine-coder') {
            if (args[0] === 'ssh') return guest(['sh', '-c', args.slice(args.indexOf('--') + 1).join(' ')], request.stdin);
            throw new Error(`Unexpected Coder command ${JSON.stringify(args)}`);
        }
        if (leaf === 'machine-lima') {
            const verb = args[0];
            if (verb === '--version') return result('limactl version 2.2.1');
            if (verb === 'info') return result({ hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'] });
            if (verb === 'create') { allocations++; present = true; instance = args.find(arg => arg.startsWith('--name='))?.slice(7) ?? args[args.indexOf('--name') + 1] ?? ''; owned.add('vm'); }
            if (verb === 'start' || verb === 'restart') power = 'running';
            if (verb === 'stop') power = 'stopped';
            if (verb === 'delete') for (const target of args.slice(1).filter(arg => !arg.startsWith('-'))) remove(target, instance, () => { present = false; owned.delete('vm'); });
            if (verb === 'list') {
                const selected = args.slice(1).filter(arg => !arg.startsWith('-'));
                const native = (vmName: string) => ({ name: vmName, dir: `${launch.store}/${vmName}`, status: power === 'running' ? 'Running' : 'Stopped', vmType: 'qemu', arch: 'x86_64', cpus: 2, memory: 4 * 1024 ** 3, disk: 20 * 1024 ** 3,
                    config: { images: [{ location: launch.image, arch: 'x86_64' }], mounts: [], ssh: { forwardAgent: false }, containerd: { user: false, system: false } } });
                return result([...(present ? [instance] : []), ...(foreignPresent ? [foreignId] : [])]
                    .filter(id => !selected.length || selected.includes(id)).map(id => JSON.stringify(native(id))).join('\n'));
            }
            if (verb === 'shell') return guest(args.slice(args.indexOf('--') + 1), request.stdin);
            return result('');
        }
        if (leaf === 'machine-docker-sandboxes') {
            if (args[0] === 'template') return result('shell-base:latest\n');
            if (args[0] === 'create') { allocations++; present = true; instance = args[args.indexOf('--name') + 1]!; owned.add('sandbox'); }
            if (args[0] === 'ls') return result({ sandboxes: [...(present ? [{ name: instance, status: power, guest_unresponsive: false }] : []), ...(foreignPresent ? [{ name: foreignId, status: 'running', guest_unresponsive: false }] : [])] });
            if (args[0] === 'stop') power = 'stopped';
            if (args[0] === 'run') power = 'running';
            if (args[0] === 'rm') for (const target of args.slice(1).filter(arg => !arg.startsWith('-'))) remove(target, instance, () => { present = false; owned.delete('sandbox'); });
            if (args[0] === 'exec') return guest(args.slice(args.indexOf('--') + 2), request.stdin);
            return result('');
        }
        if (leaf === 'machine-crabbox') {
            if (args[0] === 'warmup') { allocations++; present = true; owned.add('sandbox'); }
            if (args[0] === 'stop') { remove(args[args.indexOf('--id') + 1], leaseId, () => { present = false; owned.delete('sandbox'); }); return result(''); }
            const isForeign = args[args.indexOf('--id') + 1] === foreignId;
            return (isForeign ? foreignPresent : present) ? result({ id: isForeign ? foreignId : leaseId, provider: 'local-container', target: 'linux', state: 'ready', serverId: 'a'.repeat(64),
                sshHost: '203.0.113.8', sshUser: 'root', sshPort: '22', ready: true, hasHost: true,
                ...(evidence ? { expiresAt: new Date(NATIVE_EXPIRY).toISOString() } : {}) }) : result('', 4);
        }
        if (leaf === 'machine-cua') {
            const namespace = contribution === 'byoc' ? 'aws' : 'local', sandboxId = `${namespace}:${name}`;
            if (args.includes('doctor')) return result({ host: { os: 'linux', arch: 'x86_64', kvm: true, accel: { x86_64: 'kvm', aarch64: 'tcg' } }, backends: [{ backend: 'qemu', ready: true, provisionable: false }], qemu: { version: '10.1.0' }, lume: { version: null }, container: { reachable: false, gvisor: false, runtimes: [] } });
            if (args.includes('images')) {
                const digest = `sha256:${'a'.repeat(64)}`;
                return result(contribution === 'byoc' ? { ref: 'ghcr.io/trycua/linux:24.04', published: true } : [{ ref: launch.imageId, os: 'linux', arch: ['amd64'], local: 'qemu', published: true, spacesd: true, digest, sizes: { digest, platforms: [{ arch: 'amd64', disk: 20 * 1024 ** 3 }] } }]);
            }
            const info = () => ({ id: sandboxId, name, location: namespace, runtime: 'qemu', kind: 'vm', image: contribution === 'byoc' ? 'ghcr.io/trycua/linux:24.04' : launch.imageId,
                status: power === 'running' ? 'ready' : 'stopped', state: power === 'running' ? 'running' : 'suspended', ephemeral: false, expires_at: evidence ? new Date(NATIVE_EXPIRY).toISOString() : null,
                ...(namespace === 'aws' ? { provider_details: { provider: 'aws', id: 'i-owned' } } : {}) });
            if (args.includes('status')) return result({ providers: [{ name: 'aws', connected: true, region: 'us-west-2', ttl_hours: 0, kinds: [{ image: 'linux', supported: true, machine_type: 't3.medium', usd_per_hour: 0.04 }] }], resources: present ? [{ provider: 'aws', id: 'i-owned', type: 'instance', sandbox: sandboxId, machine: '', region: 'us-west-2', state: power, expires: '', expired: false }] : [] });
            if (args.includes('create')) { allocations++; present = true; owned.add('sandbox'); if (contribution === 'local-space') { spacePresent = true; owned.add('space'); return result({ spaces: [{ id: sandboxId, provider: 'local' }] }); } return result(info()); }
            if (args.includes('info')) {
                const isForeign = args[args.indexOf('info') + 1] === foreignId;
                return (isForeign ? foreignPresent : present) ? result(isForeign ? { ...info(), id: foreignId, name: 'happier-foreign' } : info()) : result('', 3);
            }
            if (args.includes('suspend') || args.includes('stop')) { power = 'stopped'; return result('Suspending'); }
            if (args.includes('resume') || args.includes('start')) { power = 'running'; return result({ id: sandboxId }); }
            if (args.includes('ls') && args.includes('spaces')) return result({ spaces: [...(spacePresent ? [{ id: sandboxId, provider: namespace, image: launch.imageId }] : []), ...(foreignPresent ? [{ id: foreignId, provider: namespace, image: launch.imageId }] : [])] });
            if (args.includes('rm')) { const target = args[args.indexOf('rm') + 1]; remove(target, sandboxId, () => { if (args.includes('spaces')) { spacePresent = false; owned.delete('space'); } else { present = false; owned.delete('sandbox'); } }); return result({ deleted: target, missing: false }); }
            if (args.includes('cp')) {
                const index = args.indexOf('cp'), source = args[index + 1]!, target = args[index + 2]!.slice(sandboxId.length + 1), bytes = readFileSync(source);
                copyFileSync(source, target);
                return result({ direction: 'upload', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
            }
            if (args.includes('shell')) return guest(['sh', '-c', args.at(-1)!]);
            if (args.includes('daemon')) return result({ ok: true, status: 'started' });
            throw new Error(`Unexpected Cua command ${JSON.stringify(args)}`);
        }
        if (leaf === 'devcontainer') {
            if (args[0] === 'read-configuration') return result({ configuration: JSON.parse(readFileSync(String(launch.configPath), 'utf8')), workspace: { workspaceFolder: '/work/custom' }, mergedConfiguration: { remoteUser: 'coder', workspaceFolder: '/work/custom' }, featuresConfiguration: { featureSets: [] } });
            if (args[0] === 'image') return result([{ Id: 'sha256:image', Config: { Labels: {} } }]);
            if (args[0] === 'up') { allocations++; present = true; power = 'running'; owned.add('container'); return result({ outcome: 'success', containerId: 'a'.repeat(64), remoteUser: 'coder', remoteWorkspaceFolder: '/work/custom' }); }
            if (args[0] === 'stop') power = 'stopped';
            if (args[0] === 'rm') for (const target of args.slice(1).filter(arg => !arg.startsWith('-'))) remove(target, 'a'.repeat(64), () => { present = false; owned.delete('container'); });
            if (args[0] === 'ps') {
                const idFilter = args.find(arg => arg.startsWith('id='))?.slice(3);
                return result([...(present ? ['a'.repeat(64)] : []), ...(foreignPresent && !args.some(arg => arg.startsWith('label=happier.managed-machine=')) ? [foreignId] : [])]
                    .filter(id => !idFilter || id === idFilter).join('\n'));
            }
            if (args[0] === 'inspect') {
                const isForeign = args.includes(foreignId);
                return (isForeign ? foreignPresent : present) ? result([{ Id: isForeign ? foreignId : 'a'.repeat(64), State: { Running: power === 'running', Paused: false }, Config: { Labels: { 'devcontainer.local_folder': directory, 'devcontainer.config_file': launch.configPath, 'happier.managed-machine': isForeign ? 'foreign-managed-id' : MANAGED_ID } }, Mounts: [{ Type: 'bind', Source: directory, Destination: '/work/custom' }] }]) : result('', 1);
            }
            if (args[0] === 'exec') {
                if (args.at(-1)?.includes('id -un')) return result('coder\n/work/custom\n');
                const index = args.indexOf('a'.repeat(64)); return guest(args.slice(index + 1), request.stdin);
            }
            return result('');
        }
        throw new Error(`Unexpected vendor process for ${leaf}`);
    }
    const sandbox = () => ({ name, createdAt: 1000, currentSessionId: 'sbx_one', currentSnapshotId: 'snap_one', status: power,
        persistent: true, ...(evidence ? { expiresAt: NATIVE_EXPIRY } : {}), tags: { 'happier-managed-id': MANAGED_ID }, networkPolicy: { mode: 'allow-all' } });
    const session = () => ({ id: 'sbx_one', sourceSandboxName: name, projectId: 'prj_one', createdAt: 1000, networkPolicy: { mode: 'allow-all' } });
    const snapshot = () => ({ id: 'snap_one', sourceSessionId: 'sbx_one', status: 'created', createdAt: 2000 });
    function commandResponse(id: string, exitCode: number | null) {
        const c = commands.get(id)!;
        return { command: { id, sessionId: 'sbx_one', exitCode, args: c.args, name: c.command, cwd: directory, startedAt: 2000 } };
    }
    async function request(request: HttpRequest) {
        calls.push(request);
        const url = new URL(request.url), path = url.pathname, method = request.method ?? 'GET';
        const isForeign = path.split('/').includes(foreignId), targetPresent = isForeign ? foreignPresent : present;
        let value: unknown, status = 200, contentType = 'application/json';
        if (failure) return { status: 503, finalUrl: request.url, headers: {}, body: text.encode(JSON.stringify({
            error: { code: PRIVATE_BINDING, message: PRIVATE_BINDING }, message: PRIVATE_BINDING, code: PRIVATE_BINDING, id: PRIVATE_BINDING,
        })) };
        if (leaf === 'machine-agent37') {
            const native = () => ({ id: isForeign ? foreignId : 'ab12cd34ef', status: power === 'running' ? 'running' : 'stopped', type: 'vm', auto_sleep: false });
            if (path.endsWith('/exec')) {
                const completed = guest(['sh', '-c', String(body(request).command)]);
                value = { exit_code: completed.termination.observed.kind === 'exit' ? completed.termination.observed.exitCode : 1,
                    stdout: decode.decode(completed.stdout), stderr: decode.decode(completed.stderr), truncated: false };
            } else if (path === '/v1/instances' && method === 'POST') { allocations++; present = true; owned.add('instance'); value = native(); status = 201; }
            else if (path === '/v1/instances') value = { data: [...(present ? [native()] : []), ...(foreignPresent ? [{ ...native(), id: foreignId }] : [])] };
            else if (path.endsWith('/stop') || path.endsWith('/start')) { power = path.endsWith('/stop') ? 'stopped' : 'running'; value = native(); }
            else if (method === 'DELETE') { remove(path.split('/').at(-1), 'ab12cd34ef', () => { present = false; owned.delete('instance'); }); value = { id: path.split('/').at(-1), deleted: true }; }
            else { status = targetPresent ? 200 : 404; value = targetPresent ? native() : { error: { code: 'not_found' } }; }
        } else if (leaf === 'machine-maritime') {
            const native = () => ({ id: isForeign ? foreignId : 'box-one', name: isForeign ? 'foreign-managed-id' : MANAGED_ID, externalId: isForeign ? 'foreign-managed-id' : MANAGED_ID, framework: 'zeroclaw', tier: 'always_on',
                status: power === 'running' ? 'active' : power === 'suspended' ? 'sleeping' : 'stopped', invocationCount: 0, createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' });
            if (path === '/api/v1/account/limits') value = { plan: 'growth', machines: 0, awakeMachines: 0 };
            else if (path.endsWith('/exec')) {
                const command = body(request).command;
                if (!Array.isArray(command) || !command.every(arg => typeof arg === 'string')) throw new Error('Invalid Maritime argv');
                const completed = guest(command.map(arg => arg.replaceAll('/data', directory)));
                value = { executionId: 'execution-one', status: 'completed', exitCode: completed.termination.observed.kind === 'exit' ? completed.termination.observed.exitCode : 1,
                    stdout: command[0] === 'mktemp' ? decode.decode(completed.stdout).replaceAll(directory, '/data') : decode.decode(completed.stdout),
                    stderr: decode.decode(completed.stderr) };
            } else if (path.endsWith('/resize')) value = { ok: true, alwaysOn: true, memMb: null, diskGb: null, appliesOn: 'immediate', billingPreview: null };
            else if (path.endsWith('/files/upload')) {
                const form = await new Response(new Uint8Array(request.body!), { headers: request.headers }).formData();
                const file = form.get('file');
                if (!(file instanceof File) || typeof form.get('dest_dir') !== 'string') throw new Error('Invalid Maritime upload');
                writeFileSync(join(String(form.get('dest_dir')).replaceAll('/data', directory), file.name), new Uint8Array(await file.arrayBuffer())); status = 204;
            } else if (path.endsWith('/files')) { writeFileSync(url.searchParams.get('path')!, request.body!); status = 204; }
            else if (path === '/api/agents' && method === 'POST') { allocations++; present = true; owned.add('box'); value = native(); status = 201; }
            else if (path === '/api/agents') value = [...(present ? [native()] : []), ...(foreignPresent ? [{ ...native(), id: foreignId, name: 'foreign', externalId: 'foreign-managed-id' }] : [])]
                .filter(entry => !url.searchParams.has('externalId') || entry.externalId === url.searchParams.get('externalId'));
            else if (path.endsWith('/stop') || path.endsWith('/sleep') || path.endsWith('/start') || path.endsWith('/wake')) {
                power = path.endsWith('/stop') ? 'stopped' : path.endsWith('/sleep') ? 'suspended' : 'running'; value = native();
            } else if (method === 'DELETE') { remove(path.split('/').at(-1), 'box-one', () => { present = false; owned.delete('box'); }); status = 204; }
            else { status = targetPresent ? 200 : 404; value = native(); }
        } else if (leaf === 'machine-coder') {
            const build = () => ({ id: `build-${power}`, workspace_id: 'workspace', template_version_id: 'version',
                transition: power === 'stopped' ? 'stop' : 'start', status: power, job: { status: 'succeeded' },
                resources: [{ agents: [{ id: 'agent-main', name: 'main', status: 'connected', directory }] }] });
            const workspace = () => ({ id: isForeign ? foreignId : 'workspace', owner_id: 'user-a', owner_name: 'alice', organization_id: 'org', template_id: 'template',
                name: coderWorkspaceName(MANAGED_ID), dormant_at: null, latest_build: build() });
            if (path === '/api/v2/users/me') value = { id: 'user-a', username: 'alice' };
            else if (path === '/api/v2/templateversions/version') value = { id: 'version', template_id: 'template', organization_id: 'org' };
            else if (path === '/api/v2/organizations/org/templates') value = [{ id: 'template', name: 'Template', organization_id: 'org', active_version_id: 'version' }];
            else if (path.endsWith('/rich-parameters')) value = [];
            else if (method === 'POST' && path.endsWith('/workspaces')) { allocations++; present = true; owned.add('workspace'); value = workspace(); status = 201; }
            else if (method === 'POST' && path.endsWith('/builds')) {
                const transition = body(request).transition;
                if (transition === 'delete') remove(path.split('/').at(-2), 'workspace', () => { present = false; owned.delete('workspace'); });
                else power = transition === 'stop' ? 'stopped' : 'running';
                value = { ...build(), transition }; status = 201;
            } else if (path.startsWith('/api/v2/workspacebuilds/')) value = build();
            else { status = targetPresent ? 200 : 404; value = workspace(); }
        } else if (leaf === 'machine-superserve') {
            // Superserve OpenAPI 0.1.0 / sandbox ee91ea60f1e1, 2026-11-01.
            const native = () => ({ id: isForeign ? foreignId : 'ssb_owned', name: isForeign ? 'foreign' : name, status: power === 'running' ? 'active' : 'paused',
                vcpu_count: 1, memory_mib: 1024, created_at: '2026-11-01T00:00:00Z',
                metadata: { 'happier-managed-id': MANAGED_ID }, access_token: PRIVATE_BINDING, routing_hint: PRIVATE_BINDING,
                ...(evidence ? { auto_delete_at: new Date(NATIVE_EXPIRY).toISOString(), auto_delete_seconds: 86400 } : {}) });
            if (url.origin === 'https://sandbox.superserve.ai') {
                if (path === '/files') {
                    const target = url.searchParams.get('path');
                    if (!target) throw new Error('Missing Superserve file path');
                    mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, request.body!);
                    value = { path: target, size: request.body!.length };
                } else if (path === '/exec') {
                    const input = body(request), completed = guest([String(input.command), ...(input.args as string[])]);
                    value = { stdout: decode.decode(completed.stdout), stderr: decode.decode(completed.stderr),
                        exit_code: completed.termination.observed.kind === 'exit' ? completed.termination.observed.exitCode : 1 };
                } else throw new Error(`Unexpected Superserve guest HTTP ${method} ${path}`);
            } else if (path === '/sandboxes' && method === 'POST') { allocations++; present = true; owned.add('sandbox'); value = native(); status = 201; }
            else if (path === '/sandboxes') value = [...(present ? [native()] : []), ...(foreignPresent ? [{ ...native(), id: foreignId, name: 'foreign', metadata: { 'happier-managed-id': 'foreign-managed-id' } }] : [])];
            else if (path.endsWith('/activate')) { power = 'running'; value = native(); }
            else if (path.endsWith('/pause')) { power = 'suspended'; status = 204; }
            else if (path.endsWith('/resume')) { power = 'running'; value = { id: 'ssb_owned', status: 'active', access_token: PRIVATE_BINDING, routing_hint: PRIVATE_BINDING }; }
            else if (method === 'DELETE') { remove(path.split('/').at(-1), 'ssb_owned', () => { present = false; owned.delete('sandbox'); }); status = 204; }
            else { status = targetPresent ? 200 : 404; value = native(); }
        } else if (leaf === 'machine-e2b') {
            // E2B OpenAPI 0.1.0 + envd 0.1.3 / process.proto, 2026-11-01.
            const sandbox = () => ({ sandboxID: isForeign ? foreignId : 'e2b-owned', templateID: 'base', clientID: 'team-fixture', envdVersion: '0.5.3',
                envdAccessToken: PRIVATE_BINDING, domain: 'e2b.app', startedAt: '2026-11-01T00:00:00Z', endAt: new Date(NATIVE_EXPIRY).toISOString(),
                cpuCount: 2, memoryMB: 512, diskSizeMB: 1024, state: power === 'running' ? 'running' : 'paused',
                metadata: { 'happier-managed-id': MANAGED_ID }, lifecycle: { autoResume: false, onTimeout: 'pause' } });
            if (url.hostname !== 'api.e2b.app') {
                if (path === '/files') { writeFileSync(url.searchParams.get('path')!, request.body!); value = [{ name: 'file', type: 'file', path: url.searchParams.get('path') }]; }
                else if (path === '/process.Process/Start') {
                    const envelope = request.body!;
                    const start = object(JSON.parse(decode.decode(envelope.subarray(5))));
                    const config = object(start.process);
                    const completed = guest([String(config.cmd), ...(config.args as string[] ?? [])]);
                    const frame = (payload: unknown, flag = 0) => {
                        const bytes = Buffer.from(JSON.stringify(payload)); const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(bytes.length, 1); return Buffer.concat([header, bytes]);
                    };
                    return { status: 200, finalUrl: request.url, headers: { 'content-type': 'application/connect+json' }, body: Buffer.concat([
                        frame({ event: { start: { pid: 42 } } }), frame({ event: { data: { stdout: Buffer.from(completed.stdout).toString('base64') } } }),
                        frame({ event: { data: { stderr: Buffer.from(completed.stderr).toString('base64') } } }),
                        frame({ event: { end: { exited: true, exitCode: completed.termination.observed.kind === 'exit' ? completed.termination.observed.exitCode : 1 } } }), frame({}, 2),
                    ]) };
                } else throw new Error(`Unexpected E2B guest HTTP ${method} ${path}`);
            } else if (path === '/v2/sandboxes' && method === 'POST') { allocations++; present = true; owned.add('sandbox'); value = sandbox(); status = 201; }
            else if (path === '/v2/sandboxes') value = [...(present ? [sandbox()] : []), ...(foreignPresent ? [{ ...sandbox(), sandboxID: foreignId, metadata: { 'happier-managed-id': 'foreign-managed-id' } }] : [])];
            else if (path.endsWith('/pause')) { power = 'suspended'; status = 204; }
            else if (path.endsWith('/connect')) { power = 'running'; value = sandbox(); status = 201; }
            else if (method === 'DELETE') { remove(path.split('/').at(-1), 'e2b-owned', () => { present = false; owned.delete('sandbox'); }); status = 204; }
            else { value = sandbox(); status = targetPresent ? 200 : 404; }
        } else if (leaf === 'machine-upstash-box') {
            // Public REST v2 / official @upstash/box 0.7.10, 170dd8b98821 (2026-11-01).
            const native = () => ({ id: isForeign ? foreignId : 'box-owned', name: isForeign ? 'foreign' : name, labels: ['happier-managed:' + (isForeign ? 'foreign-managed-id' : MANAGED_ID)],
                status: power === 'running' ? 'idle' : 'paused', runtime: 'node', size: 'small', keep_alive: false, created_at: 1000, updated_at: 2000 });
            if (path === '/v2/box' && method === 'GET') value = url.searchParams.get('label') === 'happier-access-check' ? [] : [...(present ? [native()] : []), ...(foreignPresent ? [{ ...native(), id: foreignId, name: 'foreign', labels: ['happier-managed:foreign-managed-id'] }] : [])];
            else if (path === '/v2/box' && method === 'POST') { allocations++; present = true; owned.add('box'); value = native(); }
            else if (path.endsWith('/exec')) {
                const command = body(request).command as string[];
                const output = guest(command);
                value = { exit_code: output.termination.observed.kind === 'exit' ? output.termination.observed.exitCode : 1,
                    output: decode.decode(output.stdout), error: decode.decode(output.stderr) };
            } else if (path.endsWith('/files/write')) {
                const input = body(request), target = String(input.path);
                mkdirSync(join(target, '..'), { recursive: true });
                writeFileSync(target, Buffer.from(String(input.content), 'base64')); value = {};
            } else if (path.endsWith('/startup')) value = {};
            else if (path.endsWith('/pause') || path.endsWith('/resume')) { power = path.endsWith('/pause') ? 'stopped' : 'running'; value = {}; }
            else if (method === 'DELETE') { remove(path.split('/').at(-1), 'box-owned', () => { present = false; owned.delete('box'); }); value = {}; }
            else { status = targetPresent ? 200 : 404; value = targetPresent ? native() : { error: 'Box not found' }; }
        } else if (leaf === 'machine-freestyle') {
            // Freestyle v5 REST / OpenAPI info 0.1.0, observed 2026-11-01.
            const native = () => ({ id: isForeign ? foreignId : 'vm-owned', slug: isForeign ? 'foreign' : name, state: power === 'running' ? 'running' : 'paused',
                resources: { cpu: 4, memory: 8192, storage: 32768 }, metadata: { 'happier-managed-id': MANAGED_ID },
                createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
                autoDeleteSeconds: null, ttlSeconds: evidence ? (NATIVE_EXPIRY - Date.parse('2026-11-01T00:00:00Z')) / 1000 : null });
            if (path === '/v5/vms' && method === 'GET') value = { vms: [], totalCount: 0, runningCount: 0, startingCount: 0, pausedCount: 0, stoppedCount: 0 };
            else if (path === '/v5/vms' && method === 'POST') { allocations++; present = true; owned.add('vm'); value = native(); status = 201; }
            else if (path.endsWith('/exec-await')) {
                const b = body(request), output = guest(['sh', '-c', String(b.command)], typeof b.stdin === 'string' ? Buffer.from(b.stdin, 'base64') : undefined);
                value = { statusCode: output.termination.observed.kind === 'exit' ? output.termination.observed.exitCode : null,
                    stdout: decode.decode(output.stdout), stderr: decode.decode(output.stderr) };
            } else if (path.endsWith('/fs/write')) {
                const target = url.searchParams.get('path');
                if (!target) throw new Error('Missing Freestyle file path');
                writeFileSync(target, request.body!, { mode: Number(url.searchParams.get('mode') ?? 0o600) }); status = 204;
            } else if (path.endsWith('/pause') || path.endsWith('/start')) { power = path.endsWith('/pause') ? 'suspended' : 'running'; value = native(); }
            else if (method === 'DELETE') { remove(path.split('/').at(-1), 'vm-owned', () => { present = false; owned.delete('vm'); }); status = 204; }
            else { status = targetPresent ? 200 : 404; value = native(); }
        } else if (leaf === 'machine-daytona') {
            const native = () => ({ id: isForeign ? foreignId : 'sandbox-owned', name: isForeign ? 'foreign' : name, organizationId: 'org-one',
                state: power === 'running' ? 'started' : 'stopped', toolboxProxyUrl: 'https://proxy.app.daytona.io/toolbox',
                labels: { 'happier-managed-id': MANAGED_ID }, autoStopInterval: 0, autoPauseInterval: 0, autoDeleteInterval: -1,
                ...(evidence ? { autoDestroyAt: new Date(NATIVE_EXPIRY).toISOString() } : {}) });
            if (path === '/api/api-keys/current') value = { name: 'Conformance', organizationId: 'org-one', permissions: ['write:sandboxes', 'delete:sandboxes'] };
            else if (path === '/api/sandbox' && method === 'POST') { allocations++; present = true; owned.add('sandbox'); value = native(); }
            else if (path.endsWith('/process/execute')) {
                const output = guest(['sh', '-c', String(body(request).command)]);
                value = { exitCode: output.termination.observed.kind === 'exit' ? output.termination.observed.exitCode : 1,
                    result: decode.decode(output.stdout) + decode.decode(output.stderr) };
            } else if (path.endsWith('/files/upload-v2')) {
                const target = url.searchParams.get('path');
                if (!target) throw new Error('Missing Daytona file path');
                mkdirSync(join(target, '..'), { recursive: true });
                writeFileSync(target, request.body ?? new Uint8Array());
                value = { path: target };
            } else if (path.endsWith('/stop') || path.endsWith('/start')) { power = path.endsWith('/stop') ? 'stopped' : 'running'; value = native(); }
            else if (method === 'DELETE') { remove(path.split('/').at(-1), 'sandbox-owned', () => { present = false; owned.delete('sandbox'); }); value = { ...native(), id: path.split('/').at(-1), state: 'destroyed' }; }
            else { status = targetPresent ? 200 : 404; value = targetPresent ? native() : { message: 'Sandbox not found' }; }
        } else if (leaf === 'machine-boat') {
            const native = () => ({ id: isForeign ? foreignId : 'bx_23456789', state: power === 'running' ? 'ready' : 'archived', ttlSeconds: null,
                ...(evidence ? { stoppedAt: '2026-11-01T12:00:00Z', archiveAfter: new Date(NATIVE_EXPIRY).toISOString() } : {}) });
            if (path.endsWith('/limits') && method === 'GET') value = { ok: true, type: 'limits.info', sandboxPlanKey: 'box_100', sandboxPlanDollars: 100, canStart: true, activeSandboxes: 0, maxActiveSandboxes: 100, billingStatus: 'active' };
            else if (path.endsWith('/saved-snapshots') && method === 'GET') value = { ok: true, type: 'snapshot.named.list', snapshots: [{ name: 'ready-one', status: 'ready', sourceSandboxId: 'bx_23456789', createdAt: '2026-10-12T00:00:00Z' }] };
            else if (path.endsWith('/sandboxes') && method === 'GET') value = { ok: true, type: 'sandbox.list', sandboxes: [...(present ? [{ id: 'bx_23456789', state: 'ready' }] : []), ...(foreignPresent ? [{ id: foreignId, state: 'ready' }] : [])]
                .filter(entry => !url.searchParams.has('label') || url.searchParams.get('label') === `happier-managed-id=${entry.id === foreignId ? 'foreign-managed-id' : MANAGED_ID}`) };
            else if (path.endsWith('/sandboxes') && method === 'POST') { allocations++; present = true; owned.add('sandbox'); value = { ok: true, sandbox: native() }; status = 202; }
            else if (path.endsWith('/sshkey')) value = { ok: true, type: 'ssh_key.configured', success: true, machineIp: '203.0.113.8', sshUser: 'user', hostKey: PUBLIC_KEY };
            else if (path.endsWith('/stop') || path.endsWith('/resume')) { power = path.endsWith('/stop') ? 'stopped' : 'running'; value = { ok: true, sandbox: native() }; status = 202; }
            else if (method === 'DELETE') { remove(path.split('/').at(-1), 'bx_23456789', () => { present = false; owned.delete('sandbox'); }); value = { ok: true, type: 'deletion.operation', operation: {
                id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox', targetId: path.split('/').at(-1), reason: 'explicit', status: 'completed', attemptCount: 1,
                requestedAt: '2026-11-01T00:00:00Z', completedAt: '2026-11-01T00:01:00Z' } }; status = 202; }
            else if (path.includes('/deletion-operations/')) value = { ok: true, type: 'deletion.operation', operation: { id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox', targetId: 'bx_23456789', reason: 'explicit', status: 'completed', attemptCount: 1, requestedAt: '2026-11-01T00:00:00Z', completedAt: '2026-11-01T00:01:00Z' } };
            else { value = targetPresent ? { ok: true, type: 'sandbox.info', sandbox: native() } : { ok: false, code: 'not_found' }; status = targetPresent ? 200 : 404; }
        } else if (leaf === 'machine-hetzner') {
            const server = () => ({ id: isForeign ? Number(foreignId) : 41, status: power === 'running' ? 'running' : 'off', labels: { 'happier-managed': isForeign ? 'foreign-managed-id' : MANAGED_ID }, volumes: [7], public_net: { ipv4: { id: 9, ip: '203.0.113.8' }, ipv6: null } });
            if (method === 'GET' && ['/v1/server_types', '/v1/images', '/v1/locations', '/v1/pricing'].includes(path)) {
                const pair = { net: '0.02', gross: '0.02' };
                value = { server_types: [{ id: 114, name: 'cx23', cores: 2, memory: 4, disk: 40, architecture: 'x86', locations: [{ name: 'fsn1', available: true, deprecation: null }], prices: [{ location: 'fsn1', price_hourly: pair, price_monthly: pair }] }],
                    images: [{ id: 1, name: 'ubuntu-24.04', description: '', architecture: 'x86', type: 'system', status: 'available', deprecated: null, os_flavor: 'ubuntu' }, { id: 2, name: 'ubuntu-22.04', description: '   ', architecture: 'x86', type: 'system', status: 'available', deprecated: null, os_flavor: 'ubuntu' }],
                    locations: [{ id: 1, name: 'fsn1', description: 'Falkenstein', country: null }], pricing: { currency: 'USD' }, meta: { pagination: { next_page: null } } };
            } else if (path === '/v1/servers' && method === 'POST') { allocations++; present = true; owned.add('/v1/primary_ips/9'); value = { server: server() }; status = 201; }
            else if (path.includes('/actions/')) { if (method === 'POST') power = path.endsWith('/shutdown') ? 'stopped' : 'running'; value = { action: { id: 10, status: 'success', command: power === 'running' ? 'poweron' : 'shutdown', resources: [{ id: 41, type: 'server' }] } }; }
            else if (method === 'DELETE') { if (path.startsWith('/v1/servers/')) remove(path.split('/').at(-1), '41', () => { present = false; }); else { if (!owned.has(path)) throw new Error(`Unexpected Hetzner owned-resource deletion: ${path}`); owned.delete(path); } value = { action: { id: 10, status: 'success' } }; }
            else if (path === '/v1/servers/41' || path === `/v1/servers/${foreignId}`) { value = targetPresent ? { server: server() } : { error: { code: 'not_found' } }; status = targetPresent ? 200 : 404; }
            else { status = owned.has(path) ? 200 : 404; value = status === 404 ? { error: { code: 'not_found' } } : { id: 7 }; }
        } else if (leaf === 'machine-digitalocean') {
            const droplet = () => ({ id: isForeign ? Number(foreignId) : 42, name: isForeign ? 'foreign' : name, status: power === 'running' ? 'active' : 'off', volume_ids: ['owned'], tags: [isForeign ? 'foreign-managed-id' : MANAGED_ID], networks: { v4: [{ type: 'public', ip_address: '203.0.113.8' }], v6: [] } });
            if (method === 'GET' && ['/v2/sizes', '/v2/images', '/v2/regions'].includes(path)) value = {
                sizes: [{ slug: 's-1vcpu-1gb', memory: 1024, vcpus: 1, disk: 25, transfer: 1, price_hourly: 0.02, regions: ['nyc3'], available: true }],
                regions: [{ slug: 'nyc3', name: 'New York 3', available: true, sizes: ['s-1vcpu-1gb'] }], images: [{ id: 1, name: 'Ubuntu', description: '', distribution: 'Ubuntu', regions: ['nyc3'], status: 'available', type: 'base' }, { id: 2, name: 'Ubuntu second', description: '   ', distribution: 'Ubuntu', regions: ['nyc3'], status: 'available', type: 'base' }], links: {} };
            else if (path === '/v2/droplets' && method === 'POST') { allocations++; present = true; value = { droplet: droplet() }; status = 202; }
            else if (path.endsWith('/actions') && method === 'POST') { power = body(request).type === 'shutdown' ? 'stopped' : 'running'; value = { action: { type: body(request).type, id: 10, status: 'completed', resource_id: 42, resource_type: 'droplet' } }; status = 201; }
            else if (path === '/v2/actions/10') value = { action: { type: power === 'running' ? 'power_on' : 'shutdown', id: 10, status: 'completed', resource_id: 42, resource_type: 'droplet' } };
            else if (path.endsWith('/actions')) value = { actions: [] };
            else if (method === 'DELETE') { if (path.startsWith('/v2/droplets/')) remove(path.split('/').at(-1), '42', () => { present = false; }); else { if (!owned.has(path)) throw new Error(`Unexpected DigitalOcean owned-resource deletion: ${path}`); owned.delete(path); } status = 204; }
            else if (path === '/v2/droplets/42' || path === `/v2/droplets/${foreignId}`) { status = targetPresent ? 200 : 404; value = { droplet: droplet() }; }
            else { status = owned.has(path) ? 200 : 404; value = { volume: { id: 'owned', droplet_ids: [] } }; }
        } else if (leaf === 'machine-crabbox') {
            if (method === 'PUT') { allocations++; present = true; owned.add('lease'); }
            if (path.endsWith('/release')) remove(path.split('/').at(-2), leaseId, () => { present = false; owned.delete('lease'); });
            const leasePresent = isForeign ? foreignPresent : present;
            value = { lease: { id: isForeign ? foreignId : leaseId, provider: 'aws', org: 'test-org', state: leasePresent ? 'active' : 'released', keep: true, cloudID: isForeign ? 'i-foreign' : 'i-owned',
                ...(leasePresent ? { host: '203.0.113.8', sshUser: 'crabbox', sshPort: '22', sshHostKey: PUBLIC_KEY,
                    ...(evidence ? { expiresAt: new Date(NATIVE_EXPIRY).toISOString() } : {}) }
                    : { cleanupStatus: 'complete', cleanupCompletedAt: '2026-11-01T00:01:00Z', releaseDeletesServer: true }) } };
        } else if (leaf === 'machine-fly') {
            if (url.hostname === 'api.fly.io' && String(body(request).query).includes('certificates')) value = { data: { app: { name, certificates: { totalCount: 0 }, ipAddresses: { totalCount: 0 }, egressIpAddresses: { totalCount: 0 }, addOns: { totalCount: 0 }, secrets: [], services: [], allocations: [], hasDeploymentSource: false } } };
            else if (url.hostname === 'api.fly.io') value = { data: { platform: { regions: [{ code: 'ord', name: 'Chicago', deprecated: false, requiresPaidPlan: false }],
                vmSizes: [{ name: 'shared-cpu-1x', cpuCores: 1, memoryMb: 256, maxMemoryMb: 2048, memoryIncrementsMb: [256], priceMonth: 2, priceSecond: 0.001 }] } } };
            else if (path === '/v1/apps' && method === 'GET') value = { total_apps: 0, apps: [] };
            else if (path === '/v1/apps' && method === 'POST') { owned.add('app'); value = { id: 'app-owned', name }; }
            else if (path.endsWith('/volumes') && method === 'GET') value = [];
            else if (path.endsWith('/volumes') && method === 'POST') { owned.add('volume'); value = { id: 'vol-owned', state: 'created', region: 'ord', attached_machine_id: null }; }
            else if (path.endsWith('/machines') && method === 'POST') { allocations++; present = true; flyConfig = body(request).config; value = { id: 'machine-owned', state: 'started', region: 'ord', config: flyConfig }; }
            else if (path.endsWith('/exec')) { const b = body(request); const argv = b.command as string[]; const completed = guest(argv, b.stdin === undefined ? undefined : text.encode(String(b.stdin))); value = { exit_code: completed.termination.observed.kind === 'exit' ? completed.termination.observed.exitCode : 1, stdout: decode.decode(completed.stdout), stderr: decode.decode(completed.stderr) }; }
            else if (path.endsWith('/stop') || path.endsWith('/start')) { power = path.endsWith('/stop') ? 'stopped' : 'running'; value = {}; }
            else if (method === 'DELETE') {
                if (path.includes('/machines/')) remove(path.split('/').at(-1), 'machine-owned', () => { present = false; });
                else if (path.includes('/volumes/')) { if (!path.endsWith('/volumes/vol-owned')) throw new Error(`Unexpected Fly volume deletion: ${path}`); owned.delete('volume'); }
                else { if (!path.endsWith(`/apps/${name}`)) throw new Error(`Unexpected Fly app deletion: ${path}`); owned.delete('app'); }
                value = {};
            }
            else if (path.endsWith('/machines/machine-owned') || path.endsWith(`/machines/${foreignId}`)) { status = targetPresent ? 200 : 404; value = { id: isForeign ? foreignId : 'machine-owned', state: power === 'running' ? 'started' : 'stopped', region: 'ord', config: flyConfig }; }
            else if (path.endsWith('/volumes/vol-owned')) { status = owned.has('volume') ? 200 : 404; value = { id: 'vol-owned', state: 'created', region: 'ord', attached_machine_id: present ? 'machine-owned' : null }; }
            else if (path.endsWith('/machines')) value = [];
            else { status = owned.has('app') ? 200 : 404; value = { id: 'app-owned', name }; }
        } else if (leaf === 'machine-vercel') {
            if (path === `/v2/sandboxes/${foreignId}`) {
                if (method === 'DELETE') foreignPresent = false;
                return { status: foreignPresent || method === 'DELETE' ? 200 : 404, finalUrl: request.url,
                    headers: { 'content-type': 'application/json' }, body: text.encode(JSON.stringify({ sandbox: { ...sandbox(), name: foreignId }, session: session(), routes: [] })) };
            }
            if (path.startsWith('/v9/projects/')) value = { id: 'prj_one' };
            else if (path.startsWith('/v2/teams/')) value = { id: 'team_one', billing: { plan: 'hobby' } };
            else if (path === '/v4/sandboxes') { allocations++; present = true; owned.add('sandbox'); value = { sandbox: sandbox(), session: session(), routes: [] }; }
            else if (path === '/v2/sandboxes/' + name) { if (method === 'DELETE') { present = false; owned.delete('sandbox'); if (url.searchParams.get('deleteOrphanSnapshots') === 'true') owned.delete('snapshot'); }
                if (url.searchParams.get('resume') === 'true') power = 'running';
                status = !present && method !== 'DELETE' ? 404 : 200; value = { sandbox: sandbox(), session: session(), routes: [] }; }
            else if (path === '/v2/sandboxes/snapshots') value = { snapshots: owned.has('snapshot') ? [snapshot()] : [], pagination: { next: null, count: owned.has('snapshot') ? 1 : 0 } };
            else if (path.includes('/snapshots/')) { if (method === 'DELETE') { if (!path.endsWith('/snapshots/snap_one')) throw new Error(`Unexpected Vercel snapshot deletion: ${path}`); owned.delete('snapshot'); } status = owned.has('snapshot') ? 200 : 404; value = { snapshot: snapshot() }; }
            else if (path.endsWith('/stop')) { power = 'stopped'; owned.add('snapshot'); value = { sandbox: sandbox(), session: session(), snapshot: snapshot() }; }
            else if (/\/sessions\/[^/]+$/.test(path)) value = { session: session() };
            else if (path.endsWith('/cmd')) { const b = body(request); const id = 'cmd_' + commands.size; commands.set(id, { command: String(b.command), args: b.args as string[], stdin: [] }); value = commandResponse(id, null); }
            else if (path.includes('/cmd/')) {
                const [id, suffix] = path.split('/cmd/')[1]!.split('/'); const c = commands.get(id!)!;
                const finish = () => { if (c.output === undefined) { const completed = guest([c.command, ...c.args], Buffer.concat(c.stdin)); c.output = decode.decode(completed.stdout); c.stderr = decode.decode(completed.stderr); c.exitCode = completed.termination.observed.kind === 'exit' ? completed.termination.observed.exitCode : 1; } return c.output; };
                if (suffix === 'stdin') { const b = body(request); c.stdin.push(Buffer.from(String(b.data), 'base64')); if (b.close) finish(); value = { ...commandResponse(id!, b.close ? c.exitCode! : null), bytesWritten: Buffer.concat(c.stdin).length }; }
                else if (suffix === 'logs') { finish(); value = JSON.stringify({ stream: 'stdout', data: c.output }) + '\n' + JSON.stringify({ stream: 'stderr', data: c.stderr }) + '\n'; contentType = 'application/x-ndjson'; }
                else { finish(); value = commandResponse(id!, c.exitCode!); }
            } else throw new Error(`Unexpected Vercel HTTP ${method} ${path}`);
        } else if (leaf === 'machine-lume') {
            const native = () => ({ name: isForeign ? foreignId : name, locationName: 'external_disk', status: power, os: 'linux', cpuCount: 2,
                memorySize: 4 * 1024 ** 3, diskSize: { allocated: 1024 ** 3, total: 20 * 1024 ** 3 }, ipAddress: '203.0.113.8', sshAvailable: true });
            if (url.hostname === 'ghcr.io' && path === '/token') value = { token: 'public-fixture-token' };
            else if (url.hostname === 'ghcr.io' && path.endsWith('/tags/list')) value = { name: path.slice('/v2/'.length, -'/tags/list'.length), tags: [] };
            else if (path.endsWith('/host/status')) value = { version: '0.6.1' };
            else if (path.endsWith('/config/locations')) value = [{ name: 'external_disk' }];
            else if (path.endsWith('/config')) value = { cachingEnabled: true };
            else if (path === '/lume/vms') value = [...(present ? [native()] : []), ...(foreignPresent ? [{ ...native(), name: foreignId }] : [])];
            else if (path.endsWith('/pull')) { allocations++; present = true; power = 'stopped'; owned.add('vm'); value = { name, image: body(request).image }; }
            else if (path.endsWith('/run')) { power = 'running'; value = {}; status = 202; }
            else if (path.endsWith('/stop')) { power = 'stopped'; value = {}; }
            else if (method === 'DELETE') { remove(path.split('/').at(-1), name, () => { present = false; owned.delete('vm'); }); value = {}; }
            else if (method === 'PATCH') value = {};
            else { status = targetPresent ? 200 : 400; value = targetPresent ? native() : { message: `Virtual machine not found: ${isForeign ? foreignId : name}` }; }
        } else if (railway) {
            const response = await railway.request(request.url, { method, body: typeof request.body === 'string' ? request.body : decode.decode(request.body) });
            return { status: response.status, finalUrl: request.url, headers: { 'content-type': 'application/json' }, body: new Uint8Array(await response.arrayBuffer()) };
        } else throw new Error(`No vendor HTTP fixture for ${leaf}`);
        return { status, finalUrl: request.url, headers: { 'content-type': contentType }, body: status === 204 ? new Uint8Array() : text.encode(contentType === 'application/json' ? JSON.stringify(value) : String(value)) };
    }
    // Host credential storage is a system boundary. No role or native client is replaced.
    const services = {
        http: { request },
        exec: { run: processRequest, systemTools: { resolve: async (request: { toolId: string }) => ({ executable: { kind: 'systemTool', id: request.toolId } }) } },
        managedServices: { dependencies: { status: async (id: string) => ({ state: 'ready', version: '0.5.0', executable: { kind: 'managedDependency', id: { pluginId: leaf === 'devcontainer' ? 'happier.devcontainer' : `happier.machine.${leaf.slice(8)}`, localId: id } } }) } },
        connectedAccounts: {
            getBinding: async () => ({ account: { service: leaf === 'machine-coder' ? CODER_ACCOUNT_SERVICE
                : { pluginId: 'happier.machine.crabbox', localId: 'coordinator' }, accountId: 'selected' } }),
            materialize: async (_purpose: string, request: { kind: string }) => request.kind === 'environment'
                ? { kind: 'environment', env: { VERCEL_TEAM_ID: 'team_one', VERCEL_PROJECT_ID: 'prj_one', FLY_ORGANIZATION: 'test-org',
                    CUA_HOME: directory, CUA_CREDENTIAL_STORE: 'file', CODER_URL: 'https://coder.example.test', CODER_SESSION_TOKEN: PRIVATE_BINDING,
                    MODAL_TOKEN_ID: 'fixture-token', MODAL_TOKEN_SECRET: PRIVATE_BINDING, MODAL_SERVER_URL: 'https://modal.example.test',
                    CRABBOX_COORDINATOR_URL: 'https://coordinator.example.test/native', CRABBOX_COORDINATOR_TOKEN: PRIVATE_BINDING, CRABBOX_ORG: 'test-org' } }
                : { kind: 'httpHeaders', headers: ['machine-e2b', 'machine-superserve'].includes(leaf) ? { 'x-api-key': PRIVATE_BINDING }
                    : leaf === 'machine-agent37' ? { authorization: `Bearer ${PRIVATE_BINDING}`, 'x-agent37-key': PRIVATE_BINDING }
                    : leaf === 'machine-upstash-box' ? { 'x-box-api-key': PRIVATE_BINDING } : { authorization: `Bearer ${PRIVATE_BINDING}` } },
        },
        machineProvisioners: { materializeBootstrapCredential: async (request: { kind: 'file' | 'bytes' }) => {
            const bytes = text.encode('private-bootstrap-fixture-key');
            if (request.kind === 'bytes') return { kind: 'bytes' as const, bytes, dispose: async () => { bytes.fill(0); } };
            const path = join(directory, 'bootstrap-key');
            writeFileSync(path, bytes, { mode: 0o600 });
            return { kind: 'file' as const, path, dispose: async () => { rmSync(path, { force: true }); } };
        }, withBootstrapCredentialFile: async (request: { relativePath: string }, effect: (credential: { path: string }) => Promise<unknown>) => effect({ path: join(directory, request.relativePath) }), materializeGuestHostCredential: async () => ({ kind: 'bytes', bytes: text.encode('private-guest-host-key'), dispose: async () => {} }) },
        logger: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...values: unknown[]) => { logs.push(values); }])),
    } as unknown as PluginTestServicesFixture;
    return { directory, launch, services, calls, processes, logs, modalPreload, modalState, modalEntry,
        get allocationCount() { return railway ? railway.calls.filter(call => call.query.includes('sandboxCreate(')).length
            : leaf === 'machine-modal' ? Number(JSON.parse(readFileSync(modalState, 'utf8')).allocations) : allocations; },
        get foreignPresent() { return railway ? railway.foreignPresent
            : leaf === 'machine-modal' ? Boolean(JSON.parse(readFileSync(modalState, 'utf8')).foreignPresent) : foreignPresent; },
        get owned() { return railway ? new Set<string>(railway.present ? ['sandbox'] : []) : leaf === 'machine-modal' ? new Set<string>(JSON.parse(readFileSync(modalState, 'utf8')).present ? ['sandbox'] : []) : owned; },
        get present() { return railway ? railway.present : leaf === 'machine-modal' ? Boolean(JSON.parse(readFileSync(modalState, 'utf8')).present) : present; },
        setFailure(value: boolean) { failure = value; railway?.setFailure(value); if (leaf === 'machine-modal') writeFileSync(modalState, JSON.stringify({ ...JSON.parse(readFileSync(modalState, 'utf8')), failure: value })); },
        setEvidence(value: boolean) { evidence = value; }, cleanup() { railway?.cleanup(); rmSync(directory, { recursive: true, force: true }); } };
}
