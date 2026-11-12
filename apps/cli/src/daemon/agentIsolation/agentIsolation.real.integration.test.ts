import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, copyFile, cp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { createServer } from 'node:http';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createNativeInactiveCatalogAdapter } from '@/agent/catalog/nativeInactiveSessionControlAdapters';
import { commonRouteParams } from '@/agent/catalog/nativeInactiveSessionControlAdapters.testkit';
import { createAgentIsolationOperationContext } from './agentIsolationSessionContext';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { prepareSessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalTransport';
import { withTempDir } from '@/testkit/fs/tempDir';
import { observeAgentIsolationMemberNativeIdentity } from './agentIsolationNativeIdentity';
import { observeAgentIsolationMemberLaunchReadiness } from './agentIsolationReadiness';
import { buildAgentIsolationProvisioningSteps, deriveAgentIsolationMemberIdentity, type AgentIsolationMemberRequester } from './provisioning';
import { createUnixAgentIdentityLaunch } from './unixAgentIdentityAdapter';
import { resolveMemberRunnableAgentCliLaunch } from '@/plugins/runtime/exec/system/tools/agentCliBinding';
import { resolveAgentCliManagedCommandPathForRuntime, type AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { managedJavaScriptRuntimeBinPath } from '@happier-dev/cli-common/agents/managedJavaScriptRuntime';
import { buildMemberAgentInstallEnvironment } from '@/capabilities/installJobs/memberInstallEnvironment';

const execute = promisify(execFile);

// Explicit opt-in: this fixture creates and removes its own Linux accounts and
// exact sudoers rules. It needs a non-root runner, sudo -n, useradd and setfacl.
describe.skipIf(process.platform !== 'linux' || process.env.HAPPIER_RUN_REAL_UID_INTEGRATION !== '1')('real Linux member preflight → RunAs → MCP', () => {
    it('runs the isolated owner under its own UID and denies another person with the same MCP bearer', async () => {
        expect(process.getuid?.()).toBeGreaterThan(0);
        await execute('sudo', ['-n', 'true']);
        await execute('setfacl', ['--version']);
        await withTempDir('realuid-', async directory => {
            await chmod(directory, 0o755);
            // Preserve the runtime asset owner's package layout. RunAs members
            // cannot load its process-tree owner from the private source tree.
            await mkdir(join(directory, 'dist'), { mode: 0o755 });
            await mkdir(join(directory, 'scripts'), { mode: 0o755 });
            const processTree = join(directory, 'scripts', 'process_tree.cjs');
            await copyFile(resolve('scripts/process_tree.cjs'), processTree);
            await chmod(processTree, 0o644);
            await cp(dirname(createRequire(import.meta.url).resolve('qrcode-terminal/package.json')),
                join(directory, 'node_modules', 'qrcode-terminal'), { recursive: true });
            const child = join(directory, 'dist', 'child.mjs');
            await build({ entryPoints: [resolve('src/testkit/process/agentIsolationRealUidChild.ts')],
                outfile: child, bundle: true, platform: 'node', format: 'esm', target: 'node22',
                // Preserve optional native binaries and the QR renderer's legacy
                // CommonJS syntax outside the ESM bundle.
                external: ['*.node', 'qrcode-terminal'], banner: { js: "import { createRequire as realUidCreateRequire } from 'node:module'; const require = realUidCreateRequire(import.meta.url);" },
                conditions: ['happier-source'], tsconfig: resolve('tsconfig.json'), logLevel: 'silent' });
            const binary = join(directory, 'happier');
            await writeFile(binary, `#!/bin/sh\nexec /usr/bin/node '${child}' "$@"\n`, { mode: 0o755 });
            const daemonHome = join(directory, 'daemon-home');
            await mkdir(daemonHome, { mode: 0o700 });
            const daemonPrivate = join(daemonHome, 'control');
            await writeFile(daemonPrivate, 'daemon-private', { mode: 0o600 });
            const installationId = randomUUID();
            const requesters = ['owner', 'other-person'].map(accountId => ({ kind: 'isolated' as const,
                separationRequired: accountId !== 'owner', homeServerIdentityId: 'real-uid-home',
                requester: { accountId, installationId, machineId: 'real-uid-machine', serverId: 'real-uid-profile' },
            } satisfies AgentIsolationMemberRequester));
            const members = requesters.map(deriveAgentIsolationMemberIdentity);
            const users: string[] = [];
            const rules: string[] = [];
            const workspaceRoots: string[] = [];
            const sudo = (args: string[]) => execute('sudo', ['-n', '--', ...args]);
            try {
                // Do not change permissions/ownership of any existing shared root.
                await sudo(['mkdir', '-p', '-m', '0711', '/var/lib/happier/members']);
                for (const [index, member] of members.entries()) {
                    await sudo(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', member.home,
                        '--shell', '/usr/sbin/nologin', '--comment', member.ownershipMarker, member.username]);
                    users.push(member.username);
                    await sudo(['install', '-d', '-m', '0700', '-o', member.username, '-g', member.primaryGroup, member.home]);
                    await sudo(['mkdir', '-p', '-m', '0711', dirname(member.workspaceRoot)]);
                    await sudo(['install', '-d', '-m', '0700', '-o', member.username, '-g', member.primaryGroup, member.workspaceRoot]);
                    workspaceRoots.push(member.workspaceRoot);
                    await execute('sudo', ['-n', '-u', member.username, '--', '/bin/sh', '-c',
                        'umask 077; printf member-private > "$HOME/private"']);
                    const rule = buildAgentIsolationProvisioningSteps({ daemonUsername: userInfo().username,
                        daemonPrimaryGroup: userInfo().username, binaryPath: binary, requesterIdentity: requesters[index] })
                        .find(step => step.id === 'agent-runas');
                    if (rule?.kind !== 'file' || rule.content?.kind !== 'literal') throw new Error('RunAs rule missing');
                    const source = join(directory, `rule-${index}`);
                    await writeFile(source, rule.content.value, { mode: 0o600 });
                    rules.push(rule.path);
                    await sudo(['install', '-m', '0440', '-o', 'root', '-g', 'root', source, rule.path]);
                    await sudo(['visudo', '-cf', rule.path]);
                }
                const identities = await Promise.all(members.map(member => observeAgentIsolationMemberNativeIdentity(member, {})));
                expect(new Set([process.getuid!(), ...identities.map(identity => identity.agentUid)]).size).toBe(3);
                expect((await stat(daemonHome)).mode & 0o777).toBe(0o700);
                for (const identity of identities) {
                    expect((await stat(identity.home)).mode & 0o777).toBe(0o700);
                    let launchFailure: unknown;
                    const readiness = await observeAgentIsolationMemberLaunchReadiness({ installedCli: binary, memberIdentity: identity,
                        system: { run: async (...args) => {
                            try { return await execFileWithDeadline(...args); }
                            catch (error) {
                                // This finite preflight has no MCP context or secret materials.
                                launchFailure = error && typeof error === 'object' ? Reflect.get(error, 'stderr') : undefined;
                                throw error;
                            }
                        } } });
                    expect(readiness.kind, `${JSON.stringify(readiness)} ${String(launchFailure ?? '')}`).toBe('member_native_ready');
                }
                const owner = identities[0]!;
                const other = identities[1]!;
                const sharedTools = join(directory, 'shared-tools');
                const sharedEnvironment = { HOME: daemonHome, PATH: '/owner/private/bin',
                    HAPPIER_HOME_DIR: daemonHome, HAPPIER_MANAGED_TOOLS_ROOT: sharedTools };
                const descriptor: AgentCliRuntimeDescriptor = { id: 'fixture-member', title: 'Member Fixture', binaryName: 'fixture-member',
                    knownUserBinDirSuffixes: ['.local/bin'], sourcePreferenceDefault: 'managed-first',
                    manualInstallKind: 'none', manualInstallRecipes: null, acceptsJavaScriptFileOverride: false,
                    managedInstall: { kind: 'github_release_binary', githubRepo: 'fixture/member', binaryName: 'fixture-member' } };
                const sharedCommand = resolveAgentCliManagedCommandPathForRuntime(descriptor, { processEnv: sharedEnvironment });
                const localCommand = resolveAgentCliManagedCommandPathForRuntime(descriptor, { processEnv: buildMemberAgentInstallEnvironment(owner.home) });
                const vendorCommand = join(owner.home, '.local/bin/fixture-member');
                await mkdir(dirname(sharedCommand), { recursive: true });
                await writeFile(sharedCommand, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
                const resolveMember = () => resolveMemberRunnableAgentCliLaunch({ agentId: descriptor.id, runtimeSpec: descriptor,
                    processEnv: { ...sharedEnvironment, HAPPIER_FIXTURE_MEMBER_PATH: daemonPrivate },
                    memberLaunch: { memberIdentity: owner, managedHappierBinaryPath: binary,
                        runtimeHome: join(owner.home, 'runtime', 'resolve-fixture'), signal: new AbortController().signal } });
                expect((await resolveMember()).resolvedPath).toBe(sharedCommand);
                await sudo(['install', '-d', '-m', '0755', '-o', owner.username, '-g', owner.primaryGroup, dirname(localCommand)]);
                await sudo(['install', '-m', '0755', '-o', owner.username, '-g', owner.primaryGroup, sharedCommand, localCommand]);
                await expect(access(localCommand, constants.X_OK)).rejects.toMatchObject({ code: 'EACCES' });
                expect((await resolveMember()).resolvedPath).toBe(localCommand);
                await sudo(['install', '-d', '-m', '0755', '-o', owner.username, '-g', owner.primaryGroup, dirname(vendorCommand)]);
                await sudo(['install', '-m', '0755', '-o', owner.username, '-g', owner.primaryGroup, sharedCommand, vendorCommand]);
                await expect(access(vendorCommand, constants.X_OK)).rejects.toMatchObject({ code: 'EACCES' });
                expect((await resolveMember()).resolvedPath).toBe(vendorCommand);

                // Native JS fixtures use the same explicitly public managed
                // runtime fallback as a member's real installed JavaScript CLI.
                const runtimeWrapper = managedJavaScriptRuntimeBinPath(sharedEnvironment);
                const sharedNode = join(dirname(runtimeWrapper), '..', 'runtime', 'bin', 'node');
                await mkdir(dirname(runtimeWrapper), { recursive: true });
                await mkdir(dirname(sharedNode), { recursive: true });
                await symlink('/usr/bin/node', sharedNode);
                await writeFile(runtimeWrapper, '#!/bin/sh\nexec /usr/bin/node "$@"\n', { mode: 0o755 });
                const native = join(directory, 'codex.cjs');
                const observationsPath = join(directory, 'native-uids');
                await writeFile(observationsPath, '');
                await chmod(observationsPath, 0o666);
                await writeFile(native, `#!/usr/bin/node
const fs = require('node:fs');
fs.appendFileSync(process.env.FIXTURE_UID_OBSERVATIONS, JSON.stringify({uid:process.getuid()})+'\\n');
if (process.argv.includes('--version')) { console.log('codex-cli 0.162.1'); process.exit(0); }
const denied = p => { try { fs.readFileSync(p); return false; } catch (e) { if(e.code === 'EACCES') return true; throw e; } };
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id === undefined) return;
 const result = m.method === 'plugin/list' ? [{ id:'plugin://fixture', installed:true, enabled:true,
 name:JSON.stringify({uid:process.getuid(), own:fs.readFileSync(process.env.OWN_PRIVATE,'utf8'),
 daemonDenied:denied(process.env.DAEMON_PRIVATE), otherDenied:denied(process.env.OTHER_PRIVATE)}) }] : {};
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
});`, { mode: 0o755 });
                const memberCodex = join(owner.home, '.local/bin/codex');
                await sudo(['install', '-m', '0755', '-o', owner.username, '-g', owner.primaryGroup, native, memberCodex]);
                vi.stubEnv('HAPPIER_CODEX_PATH', native);
                vi.stubEnv('HAPPIER_JS_RUNTIME_PATH', '/usr/bin/node');
                vi.stubEnv('HAPPIER_MANAGED_TOOLS_ROOT', sharedTools);
                const runtime = await createAdmittedPluginRuntimeFixture();
                try {
                    const material = { materializationKey: randomUUID(), environment: {
                        PATH: '/usr/bin:/bin', OWN_PRIVATE: join(owner.home, 'private'),
                        HAPPIER_CODEX_PATH: native, HAPPIER_JS_RUNTIME_PATH: '/usr/bin/node',
                        HAPPIER_MANAGED_TOOLS_ROOT: sharedTools,
                        FIXTURE_UID_OBSERVATIONS: observationsPath,
                        DAEMON_PRIVATE: daemonPrivate, OTHER_PRIVATE: join(other.home, 'private'),
                    }, selectedMaterials: [] };
                    const nativeOperation = createAgentIsolationOperationContext({
                        machine: { read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1',
                            status: { kind: 'effective', platform: 'linux' }, workspaceRoots: [directory] }) },
                        managedHappierBinaryPath: binary, requesterIdentity: requesters[0]!, memberIdentity: owner,
                        signal: new AbortController().signal, readMaterial: () => material,
                    });
                    const adapter = createNativeInactiveCatalogAdapter({ agentId: 'codex',
                        native: { vendorPlugins: true, skills: false }, dependencies: {
                            acquireRuntimeRegistryLease: async () => {
                                const lease = runtime.controller.tryAcquireRuntimeRegistry();
                                if (!lease) throw new Error('Fixture runtime unavailable');
                                return lease;
                            },
                            resolveLaunchScope: async () => ({ environment: material.environment, connectedAccounts: [],
                                nativeOperation, async assertCurrent() {}, async dispose() {} }),
                        } });
                    const result = await adapter.listVendorPlugins!({ ...commonRouteParams('member-inactive'),
                        cwd: directory, sessionMachineId: 'machine-local' });
                    expect(result, JSON.stringify(result))
                        .toMatchObject({ vendorPlugins: [expect.objectContaining({
                        name: JSON.stringify({ uid: owner.agentUid, own: 'member-private', daemonDenied: true, otherDenied: true }),
                    })] });
                    const uids = (await readFile(observationsPath, 'utf8')).trim().split('\n')
                        .map(line => (JSON.parse(line) as { uid: number }).uid);
                    expect(new Set(uids)).toEqual(new Set([owner.agentUid]));
                    expect(() => createAgentIsolationOperationContext({
                        machine: { read: () => nativeOperation.read() }, managedHappierBinaryPath: binary,
                        requesterIdentity: requesters[1]!, memberIdentity: owner,
                        signal: new AbortController().signal, readMaterial: () => material,
                    })).toThrowError('Execution material belongs to a different requester');
                } finally { await runtime.dispose(); vi.unstubAllEnvs(); }
                // The production transport selects a public parent for a different
                // UID; the daemon Home must remain private and non-traversable.
                const transport = await prepareSessionMcpLocalTransport({ agentUid: owner.agentUid });
                let initialized = 0;
                let listed = 0;
                const server = createServer(async (request, response) => {
                    if (!transport.authenticate(request.headers.authorization)) { response.writeHead(401); response.end(); return; }
                    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
                    const chunks: Buffer[] = [];
                    for await (const chunk of request) chunks.push(Buffer.from(chunk));
                    const message = JSON.parse(Buffer.concat(chunks).toString()) as {
                        id?: number; method: string; params?: { protocolVersion?: string };
                    };
                    if (message.id === undefined) { response.writeHead(202); response.end(); return; }
                    if (message.method === 'initialize') initialized += 1;
                    if (message.method === 'tools/list') listed += 1;
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize'
                        ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} },
                            serverInfo: { name: 'real-uid-fixture', version: '1' } } : { tools: [] } }));
                });
                try {
                    await transport.listen(server);
                    for (const identity of [owner, other]) {
                        const launch = createUnixAgentIdentityLaunch({ managedHappierBinaryPath: binary,
                            memberIdentity: identity, executable: '/usr/bin/node', args: [child, 'mcp-probe'],
                            cwd: identity.home, runtimeHome: join(identity.home, 'runtime', 'session'),
                            environment: { PATH: '/usr/bin:/bin', FIXTURE_DAEMON_PRIVATE: daemonPrivate,
                                FIXTURE_OTHER_PRIVATE: join(identity === owner ? other.home : owner.home, 'private') },
                            selectedEnvironmentKeys: ['FIXTURE_DAEMON_PRIVATE', 'FIXTURE_OTHER_PRIVATE'],
                            selectedMaterials: [], sessionMcpContext: transport.localContext });
                        const result = await execFileWithDeadline(launch.command, launch.args,
                            { env: launch.env, inputBytes: launch.stdinPreamble });
                        const observation: unknown = JSON.parse(String(result.stdout));
                        expect(observation).toMatchObject({ uid: identity.agentUid, homeMode: 0o700,
                            daemonPrivate: true, otherMemberPrivate: true, connected: identity === owner });
                        expect(observation).toMatchObject(identity === owner ? { server: 'real-uid-fixture', tools: [] }
                            : { code: 'mcp_socket_access_unavailable' });
                    }
                    // Only the selected owner reaches the MCP parser/catalog.
                    expect({ initialized, listed }).toEqual({ initialized: 1, listed: 1 });
                } finally {
                    server.closeAllConnections();
                    await new Promise<void>(resolve => server.close(() => resolve()));
                    await transport.retire();
                }
            } finally {
                for (const rule of rules.reverse()) await sudo(['rm', '-f', '--', rule]);
                for (const root of workspaceRoots.reverse()) await sudo(['rmdir', '--', root]);
                for (const username of users.reverse()) await sudo(['userdel', '--remove', username]);
            }
        }, '/tmp');
    });
});
