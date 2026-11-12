import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { chmod, copyFile, cp, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { accessSync } from 'node:fs';
import { build } from 'esbuild';
import { PassThrough, Readable } from 'node:stream';
import { userInfo } from 'node:os';
import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import { resolveAgentCliManagedCommandPathForRuntime } from '@happier-dev/cli-common/agents/resolution';
import { FIRST_PARTY_INSTALL_HOME_ENV_KEY } from '@happier-dev/cli-common/firstPartyRuntime';
import * as processBoundary from '@happier-dev/cli-common/process';
import { managedJavaScriptRuntimeBinPath } from '@happier-dev/cli-common/agents/managedJavaScriptRuntime';
import { withTempDir } from '@/testkit/fs/tempDir';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { observeAgentIsolationMemberLaunchReadiness, type AgentIsolationReadinessSystem } from '@/daemon/agentIsolation/agentIsolationReadiness';
import { executeAgentLaunchPayload } from '@/daemon/agentIsolation/agentLaunchShim';
import { createAgentCliSystemToolService } from './agentCliBinding';
import { resolveSpawnChildEnvironment, validateSpawnAgentCliLaunch } from '@/daemon/spawn/resolveSpawnChildEnvironment';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { projectBuiltInAgents } from '@/plugins/projection/registry/builtIn/agents';
import { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } from '@/plugins/projection/registry/sources/generatedBundledPlugins';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-codex/manifest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';

let fixtureRoot: string;
let fixtureBinary: string;
const nativeBoundary = vi.hoisted(() => ({ enabled: false, binary: '', deniedHome: '' }));
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, accessSync: (...args: Parameters<typeof actual.accessSync>) => {
        const path = args[0];
        // Model the daemon's EACCES at the OS boundary. The real child process
        // has its own filesystem view and does not inherit this boundary mock.
        if (nativeBoundary.enabled && nativeBoundary.deniedHome && typeof path === 'string'
            && (path === nativeBoundary.deniedHome || path.startsWith(nativeBoundary.deniedHome + '/'))) {
            throw Object.assign(new Error('Member home is private'), { code: 'EACCES' });
        }
        return actual.accessSync(...args);
    } };
});
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
        if (nativeBoundary.enabled && args[0] === 'sudo' && Array.isArray(args[1]) && args[1].at(-1) === 'agent-launch') {
            expect(args[1].at(-2)).toBe(nativeBoundary.binary);
            const child = actual.spawn(nativeBoundary.binary, ['mapped-agent-launch'], args[2]);
            // Expose loader failures from this secret-free fixture child.
            child.stderr?.pipe(process.stderr);
            return child;
        }
        return actual.spawn(...args);
    } };
});
beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'member-cli-native-child-'));
    await mkdir(join(fixtureRoot, 'dist'));
    await mkdir(join(fixtureRoot, 'scripts'));
    await copyFile(resolve('scripts/process_tree.cjs'), join(fixtureRoot, 'scripts/process_tree.cjs'));
    // This dependency uses legacy CommonJS escapes that cannot enter an ESM
    // bundle. Keep its real, dependency-free package beside the disposable child.
    await cp(dirname(createRequire(import.meta.url).resolve('qrcode-terminal/package.json')),
        join(fixtureRoot, 'node_modules', 'qrcode-terminal'), { recursive: true });
    fixtureBinary = join(fixtureRoot, 'dist', 'happier.mjs');
    await build({ entryPoints: [resolve('src/testkit/process/agentIsolationRealUidChild.ts')],
        outfile: fixtureBinary, bundle: true, platform: 'node', format: 'esm', target: 'node22',
        external: ['*.node', 'qrcode-terminal'], conditions: ['happier-source'], tsconfig: resolve('tsconfig.json'),
        banner: { js: `#!${process.execPath}\nimport { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(import.meta.url);` }, logLevel: 'silent' });
    await chmod(fixtureBinary, 0o755);
});
afterAll(async () => { await rm(fixtureRoot, { recursive: true, force: true }); });

function memberLaunch(home: string) {
    nativeBoundary.deniedHome = home;
    const actual = userInfo();
    return { memberIdentity: { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'home', requester: {
        serverId: 'server', accountId: 'member', machineId: 'machine', installationId: 'installation',
    } }), username: actual.username, agentUid: actual.uid, agentGid: actual.gid, home },
    managedHappierBinaryPath: fixtureBinary, runtimeHome: join(home, 'runtime', 'agent-cli') };
}

function mapNativeUserBoundary() {
    // Only the OS RunAs boundary is mapped; the private child and resolver stay real.
    nativeBoundary.enabled = true;
    nativeBoundary.binary = fixtureBinary;
    nativeBoundary.deniedHome = '';
    return { mockRestore() { nativeBoundary.enabled = false; } };
}

it.skipIf(process.platform !== 'linux').each(['owner', 'managed', 'missing', 'javascript', 'javascriptMissingRuntime'] as const)(
    'selects the Agent CLI for its admitted native identity (%s)', async outcome => {
        await withTempDir('member-agent-selection-', async home => {
            const runtimeSpec = getAgentCliRuntimeSpec('codex')!;
            const owner = join(home, 'private', 'codex');
            await mkdir(dirname(owner), { mode: 0o700 });
            await writeFile(owner, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
            const processEnv = { PATH: dirname(owner), HOME: home, HAPPIER_HOME_DIR: join(home, 'private'),
                HAPPIER_JS_RUNTIME_PATH: owner,
                [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: join(home, 'public-install') };
            const managed = resolveAgentCliManagedCommandPathForRuntime(runtimeSpec, { processEnv });
            const javascript = outcome === 'javascript' || outcome === 'javascriptMissingRuntime';
            const wrapper = managedJavaScriptRuntimeBinPath(processEnv);
            const runner = join(dirname(wrapper), '..', 'runtime', 'bin', 'node');
            if (outcome !== 'missing') {
                await mkdir(dirname(managed), { recursive: true });
                await writeFile(managed, javascript ? '#!/usr/bin/env node\nprocess.exit(0);\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
            }
            if (outcome === 'javascript') {
                await mkdir(dirname(wrapper), { recursive: true });
                await mkdir(dirname(runner), { recursive: true });
                await writeFile(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
                await writeFile(runner, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
            }
            // Observe the OS process boundary while the binding and managed
            // resolution stay real: admitted selections require no sudo probe.
            const nativeBoundary = mapNativeUserBoundary();
            const probes = vi.spyOn(processBoundary, 'execFileWithDeadline')
                .mockResolvedValue({ stdout: 'member-native-ready\n', stderr: '' });
            try {
                const service = createAgentCliSystemToolService({ agentId: 'codex', runtimeSpec,
                    binding: { toolId: 'codex-cli' },
                    definition: { toolId: 'codex-cli', displayName: 'Codex', lookupNames: ['codex'] },
                    processEnv, delegate: { async resolve() { throw new Error('No alternate resolution'); } },
                    ...(outcome === 'owner' ? {} : { memberLaunch: memberLaunch(home) }),
                });
                const selection = service.resolve({ toolId: 'codex-cli', purpose: 'Start Codex', signal: new AbortController().signal });
                if (outcome !== 'owner') expect(() => accessSync(managed)).toThrowError(expect.objectContaining({ code: 'EACCES' }));
                if (outcome === 'missing' || outcome === 'javascriptMissingRuntime') {
                    await expect(selection).rejects.toMatchObject({ code: 'agent_cli_not_runnable', retryable: false,
                        details: { agentId: 'codex', remedy: 'install_managed_runtime' },
                        message: expect.stringMatching(/Codex.*[Ii]nstall.*managed/u) });
                } else {
                    await expect(selection).resolves.toMatchObject({ executablePath: outcome === 'owner' ? owner : managed });
                    if (javascript) await expect(selection).resolves.toMatchObject({ launch: { executablePath: runner, args: [managed] } });
                }
                if (outcome === 'managed' || outcome === 'javascript') {
                    await expect(service.resolve({ toolId: 'codex-cli', purpose: 'Start Codex', preferredPath: owner }))
                        .resolves.toMatchObject({ executablePath: managed });
                    const controller = new AbortController();
                    const cancellation = new Error('Tool resolution cancelled');
                    controller.abort(cancellation);
                    await expect(service.resolve({ toolId: 'codex-cli', purpose: 'Start Codex', signal: controller.signal }))
                        .rejects.toBe(cancellation);
                    await unlink(managed);
                    await expect(service.resolve({ toolId: 'codex-cli', purpose: 'Start Codex' }))
                        .rejects.toMatchObject({ code: 'agent_cli_not_runnable' });
                }
                expect(probes).not.toHaveBeenCalled();
            } finally { probes.mockRestore(); nativeBoundary.mockRestore(); }
        });
    });

it.skipIf(process.platform !== 'linux')('allows an installed vendor-recipe Agent for a member while ignoring owner overrides', async () => {
    await withTempDir('member-vendor-agent-', async home => {
        const runtimeSpec = getAgentCliRuntimeSpec('muse')!;
        const vendorBin = join(home, '.local', 'bin', runtimeSpec.binaryName);
        const ownerOverride = join(home, 'owner-private', runtimeSpec.binaryName);
        await mkdir(dirname(vendorBin), { recursive: true });
        await mkdir(dirname(ownerOverride), { recursive: true });
        await writeFile(vendorBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        await writeFile(ownerOverride, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        const nativeBoundary = mapNativeUserBoundary();
        const service = createAgentCliSystemToolService({
            agentId: 'muse', runtimeSpec,
            binding: { toolId: 'muse-cli' },
            definition: { toolId: 'muse-cli', displayName: 'Muse', lookupNames: ['muse'] },
            processEnv: {
                PATH: '', HOME: home,
                HAPPIER_MUSE_PATH: ownerOverride,
                [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: join(home, 'public-install'),
            },
            memberLaunch: memberLaunch(home),
            delegate: { async resolve() { throw new Error('No alternate resolution'); } },
        });

        try {
            await expect(service.resolve({ toolId: 'muse-cli', purpose: 'Start Muse' }))
                .resolves.toMatchObject({ executablePath: vendorBin });
        } finally { nativeBoundary.mockRestore(); }
    });
});

it.skipIf(process.platform !== 'linux')('returns a closed member refusal before Session commit', async () => {
    await withTempDir('member-agent-preflight-', async home => {
        const manifest = PluginManifestV2Schema.parse(PLUGIN_MANIFEST);
        const agents = projectBuiltInAgents({ manifestAgents: manifest.contributes.agents.map(definition => ({
            ...projectManifestAgentContribution({ definition, pluginId: manifest.id, provenance: 'first_party',
                source: { kind: 'bundled' }, systemTools: manifest.contributes.systemTools }), hostAccess: manifest.hostAccess,
        })), registrationBindings: BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS.filter(binding => binding.identity.pluginId === manifest.id) });
        const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
            contributes: createResolvedContributionRegistry({ agents, activationTargets: [] }), pluginIds: [],
        } });
        const nativeBoundary = mapNativeUserBoundary();
        try {
            const input = { agentId: 'codex', options: { directory: home },
                pluginRuntimeRegistry: fixture.registry,
                processEnv: { PATH: '', HOME: home, [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: home },
                memberAgentCliLaunch: memberLaunch(home),
            };
            await expect(validateSpawnAgentCliLaunch(input)).resolves.toMatchObject({
                ok: false, errorCode: 'SPAWN_VALIDATION_FAILED', errorMessage: 'agent_cli_not_runnable' });
            await expect(resolveSpawnChildEnvironment({ ...input, resolvedAgentId: 'codex',
                profileEnvironmentVariables: {}, daemonSpawnHooks: null, logDebug() {}, logInfo() {}, logWarn() {},
            })).resolves.toMatchObject({ ok: false, errorCode: 'SPAWN_VALIDATION_FAILED',
                errorMessage: 'agent_cli_not_runnable', agentId: 'codex' });
        } finally { nativeBoundary.mockRestore(); await fixture.dispose(); }
    });
});

const current = userInfo();
it.skipIf(process.platform !== 'linux' || current.uid <= 0 || current.gid <= 0
    || process.getgroups?.().some(group => group !== current.gid)).each(['native', 'javascript', 'unreadableEntry'] as const)(
    'qualifies actual member filesystem access for %s', async kind => {
        await withTempDir('member-agent-access-', async home => {
            const payload = join(home, 'happier');
            const command = join(home, 'runner');
            const entry = kind === 'native' ? command : join(home, 'agent.js');
            await writeFile(payload, '#!/bin/sh\nexit 0\n', { mode: 0o555 });
            await copyFile('/bin/true', command);
            await chmod(command, 0o111);
            if (entry !== command) await writeFile(entry, 'process.exit(0)', { mode: kind === 'unreadableEntry' ? 0o000 : 0o444 });
            const identity = { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'home', requester: {
                serverId: 'server', accountId: 'member', machineId: 'machine', installationId: 'installation',
            } }), username: current.username, agentUid: current.uid, agentGid: current.gid, home };
            // Replace sudo with this process's actual UID. The fixed check
            // program, frame decoder, shim and filesystem permissions are real.
            const system: AgentIsolationReadinessSystem = { run: async (_command, _args, options) => {
                const frame = await readAgentLaunchFrame(Readable.from([options!.inputBytes!], { objectMode: false }));
                const stdout = new PassThrough();
                const chunks: Buffer[] = [];
                stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
                const result = await executeAgentLaunchPayload(frame, { agentHome: home, input: Readable.from([]),
                    stdout, stderr: new PassThrough(), signal: options?.signal });
                if (result.code !== 0) throw Object.assign(new Error('Native access denied'), { code: result.code });
                return { stdout: Buffer.concat(chunks), stderr: '' };
            } };
            const result = await observeAgentIsolationMemberLaunchReadiness({ installedCli: payload,
                memberIdentity: identity, agentCliLaunch: { command, resolvedPath: entry }, system });
            expect(result).toMatchObject(kind === 'unreadableEntry'
                ? { kind: 'unavailable', code: 'payload_not_accessible' } : { kind: 'member_native_ready' });
        });
    });
