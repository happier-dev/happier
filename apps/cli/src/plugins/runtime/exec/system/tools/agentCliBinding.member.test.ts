import { expect, it } from 'vitest';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { userInfo } from 'node:os';
import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import { resolveAgentCliManagedCommandPathForRuntime } from '@happier-dev/cli-common/agents/resolution';
import { FIRST_PARTY_INSTALL_HOME_ENV_KEY } from '@happier-dev/cli-common/firstPartyRuntime';
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

it.skipIf(process.platform !== 'linux').each(['owner', 'managed', 'missing', 'inaccessible', 'javascript', 'javascriptMissingRuntime'] as const)(
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
            const identity = { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'home',
                requester: { serverId: 'server', accountId: 'member', machineId: 'machine', installationId: 'installation' } }),
                agentUid: 994, agentGid: 994 };
            let probes = 0;
            // sudo is the OS boundary. The real binding, resolver, readiness
            // owner and framed member launch remain beneath this boundary.
            const system: AgentIsolationReadinessSystem = { run: async (command, args, options) => {
                probes++;
                expect(command).toBe('sudo');
                expect(args?.slice(0, 4)).toEqual(['-n', '-u', identity.username, '--']);
                const frame = await readAgentLaunchFrame(Readable.from([options!.inputBytes!], { objectMode: false }));
                expect(frame.nativeIdentity).toMatchObject({ agentUid: 994, agentGid: 994 });
                expect(frame.args).toContain(managed);
                expect(frame.args).not.toContain(owner);
                if (javascript) expect(frame.args.slice(-2)).toEqual([runner, managed]);
                if (outcome === 'inaccessible') throw Object.assign(new Error('Access denied as member'), { code: 73 });
                return { stdout: 'member-native-ready\n', stderr: '' };
            } };
            const service = createAgentCliSystemToolService({ agentId: 'codex', runtimeSpec,
                binding: { toolId: 'codex-cli' },
                definition: { toolId: 'codex-cli', displayName: 'Codex', lookupNames: ['codex'] },
                processEnv, delegate: { async resolve() { throw new Error('No alternate resolution'); } },
                ...(outcome === 'owner' ? {} : { memberLaunch: { identity, installedCli: '/opt/happier/current/happier', system } }),
            });
            const selection = service.resolve({ toolId: 'codex-cli', purpose: 'Start Codex', signal: new AbortController().signal });
            if (outcome === 'missing' || outcome === 'inaccessible' || outcome === 'javascriptMissingRuntime') {
                await expect(selection).rejects.toMatchObject({ code: 'agent_cli_not_runnable', retryable: false,
                    details: { agentId: 'codex', remedy: 'install_managed_runtime' },
                    message: expect.stringMatching(/Codex.*[Ii]nstall.*managed/u) });
            } else {
                await expect(selection).resolves.toMatchObject({ executablePath: outcome === 'owner' ? owner : managed });
                if (javascript) await expect(selection).resolves.toMatchObject({ launch: { executablePath: runner, args: [managed] } });
            }
            expect(probes).toBe(outcome === 'owner' || outcome === 'missing' || outcome === 'javascriptMissingRuntime' ? 0 : 1);
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
        try {
            const identity = { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'home', requester: {
                serverId: 'server', accountId: 'member', machineId: 'machine', installationId: 'installation',
            } }), agentUid: 994, agentGid: 994 };
            const input = { agentId: 'codex', options: { directory: home },
                pluginRuntimeRegistry: fixture.registry,
                processEnv: { PATH: '', HOME: home, [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: home },
                memberAgentCliLaunch: { identity, installedCli: '/opt/happier/current/happier' },
            };
            await expect(validateSpawnAgentCliLaunch(input)).resolves.toMatchObject({
                ok: false, errorCode: 'SPAWN_VALIDATION_FAILED', errorMessage: 'agent_cli_not_runnable' });
            await expect(resolveSpawnChildEnvironment({ ...input, resolvedAgentId: 'codex',
                profileEnvironmentVariables: {}, daemonSpawnHooks: null, logDebug() {}, logInfo() {}, logWarn() {},
            })).resolves.toMatchObject({ ok: false, errorCode: 'SPAWN_VALIDATION_FAILED',
                errorMessage: 'agent_cli_not_runnable', agentId: 'codex' });
        } finally { await fixture.dispose(); }
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
