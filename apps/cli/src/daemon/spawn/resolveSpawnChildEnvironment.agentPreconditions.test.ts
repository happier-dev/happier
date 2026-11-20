import { describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { resolveAgentCliManagedCommandPathForRuntime, type AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { PluginManifestV2Schema, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST as CODEX_MANIFEST } from '@happier-dev/plugins-codex/manifest';
import { PLUGIN_MANIFEST as ANTIGRAVITY_MANIFEST } from '@happier-dev/plugins-antigravity/manifest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { projectBuiltInAgents } from '@/plugins/projection/registry/builtIn/agents';
import { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } from '@/plugins/projection/registry/sources/generatedBundledPlugins';
import { projectAgentCliAuthCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { resolveSpawnChildEnvironment, validateSpawnAgentCliLaunch } from './resolveSpawnChildEnvironment';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { prepareDaemonSpawnChildEnvironment } from './prepareDaemonSpawnChildEnvironment';
import { commitDaemonLaunchSession } from './commitDaemonLaunchSession';
import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { buildCommittedLaunchMetadata } from '@/agent/runtime/createSessionMetadata';
import { applyStartupMetadataUpdateToSession, buildModelOverride } from '@/agent/runtime/startupMetadataUpdate';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { resolveExistingSessionAttachContext } from '@/daemon/sessionEncryption/resolveExistingSessionAttachContext';
import { createSessionModelTransitionCoordinator } from '@/providers/sessions/sessionModelTransitionCoordinator';
import { createSessionModelTransitionAuthorizer } from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import { createModelIntentMetadataCasCandidate, createModelIntentV2MetadataCasCandidate } from '@happier-dev/agents/session/state/metadataWriters';
import { readSessionModelSelectionV2FromMetadata } from '@happier-dev/agents/session/state/metadataReaders';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionTeamCredentialBindingMetadataPatchV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingV1';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { buildMemberAgentInstallEnvironment } from '@/capabilities/installJobs/memberInstallEnvironment';
import { resolveMemberAgentInstallCli } from '@/capabilities/installJobs/memberResolveEffect';

const memberProcess = vi.hoisted(() => ({ resolutions: 0, probes: [] as string[] }));

// Keep the resolver, hook dispatch and probe subprocess real. Replace only the
// privileged operating-system user switch in this unprivileged test runner.
vi.mock('@/daemon/agentIsolation/runMemberNativeOperation', async importOriginal => {
  const actual = await importOriginal<typeof import('@/daemon/agentIsolation/runMemberNativeOperation')>();
  return { ...actual, runMemberAgentEffect: async (input: Parameters<typeof actual.runMemberAgentEffect>[0]) => {
    const request = input.request as { kind: string; runtimeSpec: AgentCliRuntimeDescriptor; sharedManagedToolsRoot?: string };
    if (request.kind !== 'resolve') return await actual.runMemberAgentEffect(input);
    const frame = await readAgentLaunchFrame(Readable.from([input.launch.stdinPreamble], { objectMode: false }));
    if (!frame.nativeIdentity) throw new Error('Expected a member executable lookup');
    memberProcess.resolutions++;
    return input.readRecord({ t: 'resolved', launch: resolveMemberAgentInstallCli(
      request, buildMemberAgentInstallEnvironment(frame.nativeIdentity.home),
    ) });
  } };
});

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (command: string, args: string[], options: import('node:child_process').SpawnOptions) => {
    if (command !== 'sudo' || args.at(-1) !== 'agent-launch') return actual.spawn(command, args, options);
    // The fixture CLI reads no stdin. Use the existing frame on the simulated
    // RunAs stdin to select the real executable at the native process boundary.
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    });
    void readAgentLaunchFrame(child.stdin).then(frame => {
      if (!frame.nativeIdentity || !args.includes(frame.nativeIdentity.username)) throw new Error('Expected a member version probe');
      memberProcess.probes.push(frame.executable);
      const probe = actual.spawn(frame.executable, [...frame.args], {
        cwd: frame.cwd, env: { ...frame.environment, HOME: frame.nativeIdentity.home },
      });
      probe.stdout.pipe(child.stdout);
      probe.stderr.pipe(child.stderr);
      probe.on('error', error => child.emit('error', error));
      probe.on('close', (code, signal) => child.emit('close', code, signal));
    }).catch(error => child.emit('error', error));
    return child;
  } };
});

async function createPinnedSpawnAgentRegistry(): Promise<ResolvedExecutablePluginRuntimeRegistry> {
  const manifests = [CODEX_MANIFEST, ANTIGRAVITY_MANIFEST].map((manifest) => PluginManifestV2Schema.parse(manifest));
  const agents = projectBuiltInAgents({
    manifestAgents: manifests.flatMap((manifest) => manifest.contributes.agents.map((definition) => ({
      ...projectManifestAgentContribution({
        definition, pluginId: manifest.id, provenance: 'first_party', source: { kind: 'bundled' },
        systemTools: manifest.contributes.systemTools,
      }),
      hostAccess: manifest.hostAccess,
    }))),
    registrationBindings: BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS.filter((binding) => (
      manifests.some((manifest) => manifest.id === binding.identity.pluginId)
    )),
  }).map((agent) => {
    if (agent.id !== 'codex') return agent;
    const manifest = manifests.find((item) => item.id === agent.pluginId);
    const cli = agent.richDefinition?.definition.cli;
    if (!manifest || !cli) throw new Error('Codex fixture needs its declared CLI metadata');
    return { ...agent, catalogEntry: {
      ...agent.catalogEntry!,
      ...projectAgentCliAuthCatalogEntry({
        agentId: 'codex', pluginId: manifest.id, cli, runtimeSpec: agent.runtimeSpec,
        systemTools: manifest.contributes.systemTools, hostAccess: manifest.hostAccess,
        agentCliSystemTool: agent.catalogEntry?.agentCliSystemTool, isCurrent: () => true,
        // The plugin boundary consumes bounded command output; real host tool resolution and execution remain intact.
        cliAuth: { detectAuthStatus: async ({ runDeclaredSystemToolCommand }) => {
          const status = await runDeclaredSystemToolCommand({ toolId: 'codex-cli', args: ['login', 'status'], timeoutMs: 6_000 });
          return status.ok ? { state: 'logged_in', method: 'oauth_cli', source: 'command' }
            : status.exitCode === null ? { state: 'unknown', reason: 'probe_failed' }
              : { state: 'logged_out', reason: 'missing_credentials' };
        } },
      }),
    } };
  });
  const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
    contributes: createResolvedContributionRegistry({ agents, activationTargets: [] }), pluginIds: [],
  } });
  onTestFinished(async () => await fixture.dispose());
  return fixture.registry;
}

describe('daemon Agent preconditions', () => {
  it.skipIf(process.platform !== 'linux')('checks the Provider minimum on the actual member Codex selected for launch', async () => {
    const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
    try {
      await fixture.registry.activateContributionsOnDemand([{ pluginId: 'happier.agent.codex', family: 'agents', localId: 'codex' }]);
      const daemonHome = fixture.happyHomeDir;
      const home = join(daemonHome, 'members', 'member');
      const identity = { ...deriveAgentIsolationMemberIdentity({
        homeServerIdentityId: 'fixture-home',
        requester: { serverId: 'fixture-server', accountId: 'fixture-member', machineId: 'fixture-machine', installationId: 'fixture-installation' },
      }), home, agentUid: 12001, agentGid: 12001 };
      const spec = fixture.registry.contributes.agentDefinitionsById.get('codex')?.runtimeSpec;
      if (!spec) throw new Error('Codex fixture needs its declared CLI metadata');
      const cli = resolveAgentCliManagedCommandPathForRuntime(spec, { processEnv: buildMemberAgentInstallEnvironment(home) });
      const writeVersion = async (version: string) => {
        await mkdir(dirname(cli), { recursive: true });
        await writeFile(cli, `#!/bin/sh\n[ "$1" = "--version" ] || exit 1\nprintf '%s\\n' 'codex-cli ${version}'\n`, { mode: 0o755 });
      };
      await writeVersion('0.162.1');
      const common = {
        happyHomeDir: daemonHome, pluginRuntimeRegistry: fixture.registry, resolvedAgentId: 'codex',
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } },
        profileEnvironmentVariables: {}, daemonSpawnHooks: null, processEnv: { HOME: daemonHome, PATH: '' },
        providerBindingContext: { v: 1, agentTargetKey: 'codex', connectionId: 'pc_fixture', modelId: 'fixture-model' },
        logDebug() {}, logInfo() {}, logWarn() {},
      } satisfies Parameters<typeof resolveSpawnChildEnvironment>[0];
      const managedHappierBinaryPath = '/opt/happier/cli/current/happier';
      const preflight = await resolveSpawnChildEnvironment({ ...common, providerBindingPrerequisitesOnly: true,
        agentIsolation: { managedHappierBinaryPath, read: () => ({
          enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective', platform: 'linux' }, workspaceRoots: [home],
        }) },
      });
      expect(preflight, JSON.stringify(preflight)).toMatchObject({ ok: true });
      const final = { ...common, runtimePrerequisitesAlreadyResolved: true, memberAgentCliLaunch: {
        memberIdentity: identity, managedHappierBinaryPath, runtimeHome: join(home, 'runtime', 'session'),
      } };
      const resolutionsBefore = memberProcess.resolutions;
      await expect(resolveSpawnChildEnvironment(final)).resolves.toMatchObject({
        ok: true, agentCliLaunchSpec: { resolvedPath: cli },
      });
      expect(memberProcess.resolutions - resolutionsBefore).toBe(1);
      expect(memberProcess.probes).toEqual([cli]);
      await writeVersion('0.146.0');
      await expect(resolveSpawnChildEnvironment(final)).resolves.toMatchObject({
        ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: expect.stringContaining('0.147.0'),
      });
    } finally {
      memberProcess.probes.length = 0;
      await fixture.dispose();
    }
  });

  it('uses the same profile-selected executable for precommit and final launch admission', async () => {
    const home = await createTempDir('happier-spawn-profile-executable-', tmpdir());
    try {
      const registry = await createPinnedSpawnAgentRegistry();
      const cli = writeExecutableShimSync({ dir: home,
        fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32' ? '@echo off\r\necho codex-cli 0.160.0\r\n' : '#!/bin/sh\necho codex-cli 0.160.0\n' });
      const input = {
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } },
        happyHomeDir: home, pluginRuntimeRegistry: registry, processEnv: { PATH: '', HOME: home, USERPROFILE: home },
        profileEnvironmentVariables: { AGENT_DIRECTORY: home,
          HAPPIER_CODEX_PATH: '${AGENT_DIRECTORY}/' + (process.platform === 'win32' ? 'codex.cmd' : 'codex') },
        daemonSpawnHooks: null, logDebug() {}, logInfo() {}, logWarn() {},
      } satisfies Parameters<typeof resolveSpawnChildEnvironment>[0];
      const beforeCommit = await validateSpawnAgentCliLaunch({ ...input, agentId: 'codex' });
      expect(beforeCommit).toMatchObject({ ok: true, launchSpec: { resolvedPath: cli } });
      const final = await resolveSpawnChildEnvironment({ ...input, resolvedAgentId: 'codex' });
      expect(final).toMatchObject({ ok: true, agentCliLaunchSpec: { resolvedPath: cli } });
    } finally { await removeTempDir(home); }
  });

  it('admits a validated custom Session factory without an undeclared CLI prerequisite', async () => {
    const fixtureRoot = new URL('../../../../../packages/tests/fixtures/plugin-platform/agent-runtime-conformance/', import.meta.url);
    const sourceManifest = PluginManifestV2Schema.parse(JSON.parse(await readFile(new URL('.happier-plugin/plugin.json', fixtureRoot), 'utf8')));
    const nativeManifest = { ...sourceManifest, contributes: { ...sourceManifest.contributes,
      agents: sourceManifest.contributes.agents.map(({ cli: _cli, ...agent }) => agent) } };
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
      plugins: [{ manifest: nativeManifest,
        files: { 'daemon.mjs': await readFile(new URL('daemon.mjs', fixtureRoot), 'utf8'),
          'agent-runtime.mjs': await readFile(new URL('agent-runtime.mjs', fixtureRoot), 'utf8') } }],
      runtimeOptions: { pluginIds: ['acme.native-runtime-proof'] },
    });
    try {
      await fixture.registry.activateContributionsOnDemand([
        { pluginId: 'acme.native-runtime-proof', family: 'agents', localId: 'novel-native-agent' },
      ]);
      const agentId = 'acme.native-runtime-proof/novel-native-agent';
      expect(fixture.registry.agentRuntimesByAgentId.get(agentId)?.sessionRunnerFactoryBinding).toBeDefined();
      const spawnInput = {
        happyHomeDir: fixture.happyHomeDir, pluginRuntimeRegistry: fixture.registry, resolvedAgentId: agentId,
        options: { directory: fixture.happyHomeDir,
          backendTarget: { kind: 'backend', backendId: agentId, sourceKind: 'built_in' },
          agentTarget: { kind: 'agent', identity: { pluginId: 'acme.native-runtime-proof', localId: 'novel-native-agent' } } },
        profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        processEnv: { PATH: '', HAPPIER_HOME_DIR: fixture.happyHomeDir },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      } satisfies Parameters<typeof resolveSpawnChildEnvironment>[0];
      const result = await resolveSpawnChildEnvironment(spawnInput);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      expect(result).not.toHaveProperty('agentCliLaunchSpec');
      fixture.registry.retireConsumers();
      expect(await resolveSpawnChildEnvironment(spawnInput)).toMatchObject({ ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING, agentId });
    } finally { await fixture.dispose(); }
  });

  it('uses the activated native auth probe for an OAuth-only connected home and still rejects a missing credential', async () => {
    const home = await createTempDir('happier-spawn-activated-auth-', tmpdir());
    const fixture = await createAdmittedPluginRuntimeFixture({
      // The fixture's scoped pluginIds are activation authority, not just
      // eager-load preferences. Admit Codex before asking for its native probe.
      runtimeOptions: { pluginIds: ['happier.agent.codex'] },
    });
    try {
      const connectedHome = join(home, 'connected');
      await mkdir(connectedHome);
      await writeFile(join(connectedHome, 'auth.json'), JSON.stringify({
        auth_mode: 'chatgptAuthTokens', tokens: { access_token: 'fixture-access' },
      }));
      const probe = join(home, 'native-probe.cjs');
      // The native executable is an OS boundary: only this synthetic CLI is replaced.
      // Keep the real manifest, activation, catalog, environment and result parser.
      await writeFile(probe, `const fs = require('node:fs'); const path = require('node:path');
if (process.argv.includes('--version')) { console.log('codex-cli 0.160.0'); process.exit(0); }
try { const auth = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8'));
process.exit(auth.tokens.access_token === 'fixture-access' ? 0 : 1); } catch { process.exit(1); }
`);
      const runtime = `'${process.execPath.replace(/'/g, `'\\''`)}'`;
      const script = `'${probe.replace(/'/g, `'\\''`)}'`;
      const cli = writeExecutableShimSync({
        dir: home, fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${probe}" %*\r\n`
          : `#!/bin/sh\nexec ${runtime} ${script} "$@"\n`,
      });
      const params = {
        happyHomeDir: fixture.happyHomeDir,
        pluginRuntimeRegistry: fixture.registry,
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } },
        profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        processEnv: { PATH: '', HOME: home, USERPROFILE: home, CODEX_HOME: join(home, 'signed-out'),
          HAPPIER_HOME_DIR: fixture.happyHomeDir, HAPPIER_CODEX_PATH: cli, HAPPIER_JS_RUNTIME_PATH: process.execPath },
        connectedServiceAuth: { env: { CODEX_HOME: connectedHome }, cleanupOnFailure: null, cleanupOnExit: null,
          connectedServicesBindings: { v: 2, bindingsByServiceId: {} }, qualifiedPurposeBindingSnapshot: null },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      } satisfies Parameters<typeof resolveSpawnChildEnvironment>[0] & {
        connectedServiceAuth: NonNullable<Parameters<typeof prepareDaemonSpawnChildEnvironment>[0]['connectedServiceAuth']>;
      };
      await mkdir(join(home, 'custodian-home'));
      await writeFile(join(home, 'custodian-home', 'auth.json'), JSON.stringify({
        tokens: { access_token: 'fixture-access' },
      }));
      await expect(resolveSpawnChildEnvironment({ ...params, allowNativeAccountCredentials: false,
        connectedServiceAuth: null, processEnv: { ...params.processEnv, CODEX_HOME: join(home, 'custodian-home') },
      })).resolves.toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED });
      // Connected-account materialization acquires the Agent before spawn;
      // the startup catalog must not be mistaken for this activated entry.
      const entry = await fixture.registry.acquireAgentCatalogEntry?.('codex');
      const authSpec = await entry?.getCliAuthSpec?.();
      await expect(authSpec?.detectAuthStatus?.({ resolvedPath: cli, processEnv: {
        ...params.processEnv, ...params.connectedServiceAuth?.env,
      } })).resolves.toMatchObject({ state: 'logged_in' });
      const admitted = await resolveSpawnChildEnvironment(params);
      if (!admitted.ok) expect(admitted.errorCode).toBe('agent_signed_out');
      expect(admitted).toMatchObject({ ok: true, extraEnvForChild: { CODEX_HOME: connectedHome } });
      const requester = await resolveSpawnChildEnvironment({ ...params, allowNativeAccountCredentials: false,
        connectedServiceAuth: { ...params.connectedServiceAuth!, targetMaterializedRoot: connectedHome },
        processEnv: { ...params.processEnv, OPENAI_API_KEY: 'custodian-key' },
      });
      expect(requester).toMatchObject({ ok: true, extraEnvForChild: { CODEX_HOME: connectedHome } });
      if (requester.ok) expect(requester.unsetEnvKeys).toContain('OPENAI_API_KEY');
      const requesterParams = { ...params, allowNativeAccountCredentials: false,
        connectedServiceAuth: { ...params.connectedServiceAuth, targetMaterializedRoot: connectedHome } };
      const requesterWithInheritedAlias = await resolveSpawnChildEnvironment({ ...requesterParams,
        daemonSpawnHooks: { augmentEnv: () => ({ openai_api_key: 'custodian-key' }) },
      });
      expect(requesterWithInheritedAlias).toMatchObject({ ok: true });
      if (!requesterWithInheritedAlias.ok) throw new Error(requesterWithInheritedAlias.errorMessage);
      expect(requesterWithInheritedAlias.extraEnvForChild).not.toHaveProperty('openai_api_key');
      expect(requesterWithInheritedAlias.unsetEnvKeys).toContain('OPENAI_API_KEY');
      const mutations = [
        { name: 'daemon hook replaces requester home', daemonSpawnHooks: {
          augmentEnv: () => ({ CODEX_HOME: join(home, 'custodian-home') }),
        } },
        { name: 'provider replaces requester home', providerEnvironmentOverlay: [
          { name: 'CODEX_HOME', value: join(home, 'custodian-home'), source: 'provider' as const },
        ] },
        { name: 'provider unsets requester home', providerEnvironmentOverlay: [
          { name: 'CODEX_HOME', value: null, source: 'provider' as const },
        ] },
      ] satisfies readonly (Partial<Parameters<typeof resolveSpawnChildEnvironment>[0]> & { name: string })[];
      for (const { name, ...mutation } of mutations) {
        await expect(resolveSpawnChildEnvironment({ ...requesterParams, ...mutation }), name)
          .resolves.toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED });
      }
      await expect(resolveSpawnChildEnvironment({ ...requesterParams,
        daemonSpawnHooks: { augmentEnv: () => ({ CODEX_HOME: join(home, 'custodian-home') }) },
        providerEnvironmentOverlay: [{ name: 'CODEX_HOME', value: connectedHome, source: 'provider' }],
      })).resolves.toMatchObject({ ok: true, extraEnvForChild: { CODEX_HOME: connectedHome } });
      const sessionId = 'session-requester-committed';
      const requesterCredentials = { token: 'fixture-requester-token', encryption: null } as const;
      let createdSession: ReturnType<typeof createPlainSessionFixture> | null = null;
      const network = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
        if (String(url).includes('/v1/account/encryption/currentness')) return {
          status: 200, data: createAccountEncryptionCurrentnessFixture(),
        };
        if (String(url).includes(`/v2/sessions/${sessionId}`) && createdSession) return { status: 200,
          data: { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
            metadata: JSON.stringify(createdSession.metadata), dataEncryptionKey: null }) } };
        throw new Error(`Unexpected Home read: ${String(url)}`);
      });
      const launchResourceScope = createProviderLaunchResourceScope();
      const providerDiagnosticRedactionLease = createProviderRedactionLease({ values: [] });
      try {
        // Home creation/read transports are the boundary; the real committed
        // launch and child-environment owners carry the requester identity.
        const committed = await commitDaemonLaunchSession({
          api: { getOrCreateSession: async input => {
            const session = { ...createPlainSessionFixture({ id: sessionId, metadata: createTestMetadata(input.metadata) }),
              sessionCreationOutcome: { disposition: 'created' as const, organizationPlacement: { folderId: null, tagIds: [] } },
            };
            createdSession = session;
            return session;
          } },
          credentials: requesterCredentials, directory: home, options: params.options, accountSettings: {},
        });
        expect(committed.ok).toBe(true);
        if (!committed.ok) throw new Error('Fixture committed Session could not attach');
        const child = await prepareDaemonSpawnChildEnvironment({
          options: { ...committed.session.options, requesterSessionCredentialFile: join(home, 'requester.json') },
          pluginRuntimeRegistry: fixture.registry, effectiveModelSelection: undefined, terminal: undefined,
          profileEnvironmentVariables: {}, daemonSpawnHooks: null, processEnv: params.processEnv,
          connectedServiceAuth: params.connectedServiceAuth!, connectedServiceMaterializationIdentity: null,
          providerBindingAttempt: null, providerAgentTargetKey: null, launchResourceScope, providerDiagnosticRedactionLease,
        });
        expect(child).toMatchObject({ ok: true, extraEnvForChild: {
          HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: join(home, 'requester.json'),
          HAPPIER_SESSION_REQUESTER_SESSION_ID: sessionId, CODEX_HOME: connectedHome,
        } });
      } finally {
        network.mockRestore();
        await launchResourceScope.release();
        providerDiagnosticRedactionLease.close();
      }
      await expect(resolveSpawnChildEnvironment({ ...params, allowNativeAccountCredentials: false,
        connectedServiceAuth: { ...params.connectedServiceAuth!, targetMaterializedRoot: connectedHome },
        profileEnvironmentVariables: { OPENAI_API_KEY: '${CUSTODIAN_PRIVATE_KEY}' },
        processEnv: { ...params.processEnv, CUSTODIAN_PRIVATE_KEY: 'alice-private-key' },
      })).resolves.toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.AUTH_ENV_UNEXPANDED });
      // A connected home never observed signed in is refused before launch. (The signed-in
      // fact for `connectedHome` is held; a credential removed under it surfaces at provider
      // start instead: P03 redesign plan r2, S4 / accepted imperfection #8.)
      const signedOutHome = join(home, 'connected-signed-out');
      await mkdir(signedOutHome);
      await expect(resolveSpawnChildEnvironment({ ...params,
        connectedServiceAuth: { ...params.connectedServiceAuth!, env: { CODEX_HOME: signedOutHome } },
      })).resolves.toMatchObject({
        ok: false, errorCode: 'agent_signed_out', agentId: 'codex',
      });
    } finally {
      await fixture.dispose();
      await removeTempDir(home);
    }
  });

  it('preserves the missing Agent identity through daemon child preparation', async () => {
    const home = await createTempDir('happier-spawn-prepared-preconditions-', tmpdir());
    const launchResourceScope = createProviderLaunchResourceScope();
    const providerDiagnosticRedactionLease = createProviderRedactionLease({ values: [] });
    try {
      const result = await prepareDaemonSpawnChildEnvironment({
        pluginRuntimeRegistry: await createPinnedSpawnAgentRegistry(),
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'antigravity', sourceKind: 'built_in' } },
        effectiveModelSelection: undefined,
        terminal: undefined,
        profileEnvironmentVariables: {},
        daemonSpawnHooks: null,
        processEnv: { PATH: '', HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home, HAPPIER_ANTIGRAVITY_PATH: join(home, 'missing-cli') },
        connectedServiceAuth: null,
        connectedServiceMaterializationIdentity: null,
        providerBindingAttempt: null,
        providerAgentTargetKey: null,
        providerDiagnosticRedactionLease,
        launchResourceScope,
      });
      expect(result).toMatchObject({ ok: false, result: { type: 'error', errorCode: 'agent_cli_missing', agentId: 'antigravity' } });
    } finally {
      await launchResourceScope.release();
      providerDiagnosticRedactionLease.close();
      await removeTempDir(home);
    }
  });

  it('requires the Agent CLI when dependency prerequisites succeed', async () => {
    const home = await createTempDir('happier-spawn-preconditions-', tmpdir());
    try {
      const result = await resolveSpawnChildEnvironment({
        pluginRuntimeRegistry: await createPinnedSpawnAgentRegistry(),
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'antigravity', sourceKind: 'built_in' } },
        profileEnvironmentVariables: {},
        // An external plugin's prerequisite callback is the boundary; CLI resolution stays real.
        daemonSpawnHooks: { resolveRuntimePrerequisites: async () => ({ ok: true }) },
        processEnv: { PATH: '', HAPPIER_HOME_DIR: join(home, 'happier') },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'agent_cli_missing', agentId: 'antigravity' });
      if (result.ok) throw new Error('expected missing Agent CLI');
      expect(result.errorMessage).toContain('Antigravity');
    } finally {
      await removeTempDir(home);
    }
  });

  it('does not invoke prerequisite acquisition when the Agent CLI is missing', async () => {
    const home = await createTempDir('happier-spawn-no-download-', tmpdir());
    let acquired = false;
    try {
      const result = await resolveSpawnChildEnvironment({
        pluginRuntimeRegistry: await createPinnedSpawnAgentRegistry(),
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'antigravity', sourceKind: 'built_in' } },
        profileEnvironmentVariables: {},
        daemonSpawnHooks: { resolveRuntimePrerequisites: async () => { acquired = true; return { ok: true }; } },
        processEnv: { PATH: '', HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'agent_cli_missing', agentId: 'antigravity' });
      expect(acquired).toBe(false);
    } finally {
      await removeTempDir(home);
    }
  });

  it('uses an admitted Team broker route without native login, but never caller intent or another purpose', async () => {
    const home = await createTempDir('happier-spawn-team-auth-', tmpdir());
    try {
      const cli = writeExecutableShimSync({ dir: home,
        fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n' });
      const binding = { v: 1 as const, slot: { kind: 'provider_model' as const }, resourceId: 'resource-1',
        expectedResourceRevision: 3, deliveryMode: 'brokered' as const, teamId: 'team-1' };
      const params = { pluginRuntimeRegistry: await createPinnedSpawnAgentRegistry(),
        options: { directory: home, existingSessionId: 'accepted-session', teamCredentialBindings: [binding],
          backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const } },
        profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        processEnv: { NODE_ENV: 'test' as const, PATH: '', HOME: home, USERPROFILE: home, CODEX_HOME: home, HAPPIER_HOME_DIR: home,
          HAPPIER_CODEX_PATH: cli, HAPPIER_JS_RUNTIME_PATH: process.execPath },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {} };
      expect(await resolveSpawnChildEnvironment(params)).toMatchObject({ ok: false, errorCode: 'agent_signed_out' });
      expect(await resolveSpawnChildEnvironment({ ...params, acceptedTeamCredentialBinding: binding })).toMatchObject({ ok: true });
      expect(await resolveSpawnChildEnvironment({ ...params, acceptedTeamCredentialBinding: { ...binding,
        slot: { kind: 'connected_service_purpose', purpose: { consumer: { pluginId: 'acme.other', localId: 'other' }, purpose: 'mcp' } },
      } })).toMatchObject({ ok: false, errorCode: 'agent_signed_out' });
      const metadata = createTestMetadata(buildCommittedLaunchMetadata({ directory: home, options: { directory: home,
        modelSelection: { v: 1, updatedAt: 10, ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'team-model',
        } }, teamCredentialBindings: [binding],
      } }));
      for (const acceptedTeamCredentialBinding of [undefined, { ...binding, resourceId: 'another-resource' },
        { ...binding, deliveryMode: 'direct' as const }]) {
        expect(await resolveSpawnChildEnvironment({ ...params, existingSessionMetadata: metadata, acceptedTeamCredentialBinding }))
          .toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED, errorMessage: 'team_credential_provider_binding_unavailable' });
      }
      expect(await resolveSpawnChildEnvironment({ ...params, existingSessionMetadata: metadata, acceptedTeamCredentialBinding: binding }))
        .toMatchObject({ ok: true });
      const nativeDelivery = { managedId: 'managed', controllerInstallationId: 'controller-installation',
        guestInstallationId: 'guest-installation', bindingKey: 'binding', placeholderRef: 'placeholder',
        sourceRevision: 'source-1', providerTicket: 't'.repeat(43) };
      const nativeBinding = { ...binding, deliveryMode: 'vendor-native' as const, nativeDelivery,
        providerModelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'team-model',
          nativeSource: { sourceRevision: nativeDelivery.sourceRevision, providerTicket: nativeDelivery.providerTicket } } };
      const nativeMetadata = createModelIntentV2MetadataCasCandidate({ nowMs: () => 10, selection: { v: 2, updatedAt: 10, ref: {
        source: 'team_resource', resourceId: binding.resourceId, teamId: binding.teamId,
        expectedResourceRevision: binding.expectedResourceRevision, deliveryMode: 'vendor-native',
        agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'team-model', nativeDelivery,
      } } }).update(metadata);
      expect(await resolveSpawnChildEnvironment({ ...params, existingSessionMetadata: nativeMetadata,
        acceptedTeamCredentialBinding: nativeBinding })).toMatchObject({ ok: true });
      for (const acceptedTeamCredentialBinding of [{ ...nativeBinding, nativeDelivery: undefined }, {
        ...nativeBinding, nativeDelivery: { ...nativeDelivery, placeholderRef: 'another-placeholder' },
      }]) {
        expect(await resolveSpawnChildEnvironment({ ...params, existingSessionMetadata: nativeMetadata,
          acceptedTeamCredentialBinding }))
          .toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'team_credential_provider_binding_unavailable' });
      }
      const pendingNativeMetadata = createModelIntentV2MetadataCasCandidate({ nowMs: () => 10, selection: { v: 2, updatedAt: 10, ref: {
        source: 'team_resource', resourceId: binding.resourceId, teamId: binding.teamId,
        expectedResourceRevision: binding.expectedResourceRevision, deliveryMode: 'vendor-native',
        agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'team-model',
      } } }).update(nativeMetadata);
      for (const existingSessionMetadata of [nativeMetadata, pendingNativeMetadata]) {
      const tracked = await prepareDaemonSpawnChildEnvironment({ ...params, existingSessionMetadata,
        options: { ...params.options, teamCredentialBindings: [{ ...nativeBinding,
          nativeDelivery: { ...nativeDelivery, placeholderRef: 'caller-stale' } }] },
        sessionAttachPayload: { v: 2, encryptionMode: 'plain', snapshot: { metadata: existingSessionMetadata,
          metadataVersion: 1, agentState: null, agentStateVersion: 1, acceptedTeamCredentialBinding: nativeBinding } },
        effectiveModelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'team-model' } },
        terminal: undefined, connectedServiceAuth: null, connectedServiceMaterializationIdentity: null,
        providerBindingAttempt: null, providerAgentTargetKey: null,
        providerDiagnosticRedactionLease: createProviderRedactionLease({ values: [] }), launchResourceScope: createProviderLaunchResourceScope(),
      });
      expect(tracked).toMatchObject({ ok: true, trackedSpawnOptions: { teamCredentialBindings: [nativeBinding] } });
      }
    } finally { await removeTempDir(home); }
  });

  it('resumes a Team selection after failed prompt dispatch and startup replay through the real metadata and attach owners', async () => {
    const home = await createTempDir('happier-team-retained-attach-', tmpdir());
    const credentials = { token: 'fixture-token', encryption: null } as const;
    const binding = { v: 1 as const, slot: { kind: 'provider_model' as const }, resourceId: 'resource-1', teamId: 'team-1',
      expectedResourceRevision: 3, deliveryMode: 'brokered' as const };
    const selection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'team-model' } as const;
    const modelSelection = { v: 1 as const, updatedAt: 10, ref: selection };
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
      metadata: buildCommittedLaunchMetadata({ directory: home, options: { directory: home,
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, modelSelection, teamCredentialBindings: [binding] } }), agentState: null });
    let rawSession = createSessionRecordFixture({ id: 'team-retained', encryptionMode: 'plain', dataEncryptionKey: null, share: null,
      metadataLayoutVersion: 1, metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
      metadataVersion: 1, agentState: null, agentStateVersion: 1, acceptedTeamCredentialBinding: binding });
    // Substitute only Home HTTP. All serializers, intent/tuple writers, startup
    // merge, attach reader, model authorizer and native sign-in admission run.
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith('/v2/sessions/team-retained')) return { status: 200, data: { session: rawSession } };
      throw new Error('Unexpected Home read');
    });
    const patch = vi.spyOn(axios, 'patch').mockImplementation(async (_url, body: unknown) => {
      const team = SessionTeamCredentialBindingMetadataPatchV1Schema.safeParse(body);
      const request = team.success ? team.data : SessionMetadataTuplePatchV1Schema.parse(body);
      if (request.mode !== 'owner' && request.mode !== 'owner_team_credential_binding') throw new Error('Expected owner write');
      // These metadata-only writes preserve the server producer's AgentState version.
      rawSession = { ...rawSession, metadata: request.sharedMetadata.ciphertext, ownerMetadata: request.ownerMetadata,
        metadataVersion: rawSession.metadataVersion + 1, agentStateVersion: request.agentState.expectedVersion,
        ...(team.success && team.data.teamCredentialBindings.some(item => item.slot.kind === 'provider_model' && item.resourceId === null)
          ? { acceptedTeamCredentialBinding: null } : {}) };
      return { status: 200, data: { success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: rawSession.metadataVersion }, agentState: { version: rawSession.agentStateVersion } } };
    });
    const currentness = createAccountEncryptionCurrentnessFixture();
    const session: Parameters<typeof applyStartupMetadataUpdateToSession>[0]['session'] = { updateMetadata: async updater => {
      await updateSessionMetadataWithRetry({ token: credentials.token, credentials, sessionId: rawSession.id, rawSession,
        accountEncryptionCurrentness: currentness, updater: (current, context) => updater(createTestMetadata(current), context) });
    } };
    const initialTarget = { selection, policy: 'live' as const, providerBinding: null, sessionBindingMetadata: null,
      runtimeBindingBasis: null, revalidateBeforeEffect: async () => true,
      readAppliedTeamCredentialModel: () => ({ kind: 'team_credential_provider_model' as const,
        resourceId: binding.resourceId, teamId: binding.teamId, expectedResourceRevision: binding.expectedResourceRevision,
        deliveryMode: binding.deliveryMode, agentTargetKey: selection.agentTargetKey, modelId: selection.modelId }) };
    const authorize = createSessionModelTransitionAuthorizer({ sessionId: rawSession.id, machineId: 'machine-1', agentId: 'codex',
      agentTargetKey: selection.agentTargetKey, nativeModelApplyPolicy: 'restart_session', readActiveTarget: () => initialTarget });
    const coordinator = createSessionModelTransitionCoordinator({ runId: 'run-1', agentTargetKey: selection.agentTargetKey,
      initialActiveTarget: initialTarget, initialActiveTargetConfirmed: true, isCurrentRun: () => true,
      readModelSelectionIntent: () => readSessionModelSelectionV2FromMetadata(tryDecryptSessionOwnerMetadataView({
        credentials, rawSession, accountEncryptionMode: 'plain',
      })),
      checkCurrentPublisherAuthority: async () => true, authorize,
      publishIntent: async requested => {
        const candidate = createModelIntentMetadataCasCandidate({ selection: requested, nowMs: () => 20 });
        await session.updateMetadata(candidate.update);
        return { accepted: candidate.readState().accepted, updatedAt: candidate.readState().updatedAt! };
      }, applyRuntime: async () => { throw new Error('Carried model must not be reapplied'); },
      publishActive: async () => { throw new Error('Carried model must not publish new active facts'); },
      revokeActiveSelectionProof: async () => {}, fencePromptAdmission: async () => {}, clearPromptAdmission: async () => {},
      transferPromptAdmission: async (_epoch, options) => { await options.dispatch(); return { status: 'dispatched', value: undefined }; },
    });
    try {
      const cli = writeExecutableShimSync({ dir: home, fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n' });
      const registry = await createPinnedSpawnAgentRegistry();
      await expect(coordinator.submit(selection, { source: 'prompt', runWithActiveSelection: async transfer => {
        await transfer({ abortSignal: new AbortController().signal, dispatch: async () => { throw new Error('controlled turn failure'); } });
      } })).rejects.toThrow('controlled turn failure');
      expect(patch).not.toHaveBeenCalled();
      await applyStartupMetadataUpdateToSession({ session, next: createTestMetadata({ flavor: 'codex', hostPid: 42 }),
        nowMs: 30, permissionModeOverride: null, modelOverride: buildModelOverride({ modelSelection: { ...modelSelection, updatedAt: 25 } }),
        capturedTeamCredentialBinding: binding, mode: 'attach' });
      expect(rawSession.acceptedTeamCredentialBinding).toEqual(binding);
      const attach = await resolveExistingSessionAttachContext({ token: credentials.token, credentials, sessionId: rawSession.id });
      expect(attach.ok, attach.ok ? '' : JSON.stringify(attach)).toBe(true);
      if (!attach.ok) throw new Error(attach.reason);
      expect(attach.metadata).toHaveProperty('modelSelectionIntentV2.ref.source', 'team_resource');
      const spawnInput = { pluginRuntimeRegistry: registry, options: { directory: home, existingSessionId: rawSession.id,
        backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const } },
        profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        processEnv: { NODE_ENV: 'test' as const, PATH: '', HOME: home, USERPROFILE: home, CODEX_HOME: home, HAPPIER_HOME_DIR: home,
          HAPPIER_CODEX_PATH: cli, HAPPIER_JS_RUNTIME_PATH: process.execPath }, logDebug() {}, logInfo() {}, logWarn() {} };
      expect(await resolveSpawnChildEnvironment({ ...spawnInput, existingSessionMetadata: attach.metadata,
        acceptedTeamCredentialBinding: attach.attachPayload.snapshot?.acceptedTeamCredentialBinding })).toMatchObject({ ok: true });
      await expect(coordinator.submit(selection, { source: 'command' })).resolves.toMatchObject({ ok: false, status: 'restart_required' });
      expect(rawSession.acceptedTeamCredentialBinding).toBeNull();
      const nativeAttach = await resolveExistingSessionAttachContext({ token: credentials.token, credentials, sessionId: rawSession.id });
      if (!nativeAttach.ok) throw new Error(nativeAttach.reason);
      expect(nativeAttach.metadata).not.toHaveProperty('modelSelectionIntentV2');
      expect(await resolveSpawnChildEnvironment({ ...spawnInput, existingSessionMetadata: nativeAttach.metadata,
        acceptedTeamCredentialBinding: nativeAttach.attachPayload.snapshot?.acceptedTeamCredentialBinding }))
        .toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT });
    } finally { await coordinator.dispose(); get.mockRestore(); patch.mockRestore(); await removeTempDir(home); }
  });

  it('refuses a signed-out Agent and preserves cleanup for its prepared credentials', async () => {
    const home = await createTempDir('happier-spawn-signed-out-', tmpdir());
    try {
      const cli = writeExecutableShimSync({
        dir: home,
        fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32'
          ? '@echo off\r\nif "%1"=="--version" (echo 1.2.3 & exit /b 0)\r\nexit /b 1\r\n'
          : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.3; exit 0; fi\nexit 1\n',
      });
      const cleanup = async () => {};
      const result = await resolveSpawnChildEnvironment({
        pluginRuntimeRegistry: await createPinnedSpawnAgentRegistry(),
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } },
        profileEnvironmentVariables: {},
        daemonSpawnHooks: { resolveRuntimePrerequisites: async () => ({ ok: true }) },
        processEnv: { PATH: '', HOME: home, USERPROFILE: home, CODEX_HOME: home, HAPPIER_HOME_DIR: home, HAPPIER_CODEX_PATH: cli, HAPPIER_JS_RUNTIME_PATH: process.execPath },
        connectedServiceAuth: { env: {}, cleanupOnFailure: cleanup, cleanupOnExit: cleanup },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'agent_signed_out', agentId: 'codex', cleanupOnFailure: cleanup });
    } finally {
      await removeTempDir(home);
    }
  });

  it('holds the signed-in Agent fact per binary identity and config dir instead of probing every spawn', async () => {
    const home = await createTempDir('happier-spawn-held-auth-', tmpdir());
    try {
      if (process.platform === 'win32') return;
      // The installed CLI is the process boundary: it records each invocation.
      const log = join(home, 'invocations.log');
      const writeCli = (exitCode: number) => writeExecutableShimSync({ dir: home, fileName: 'codex',
        contents: `#!/bin/sh\n${exitCode === 0 ? '' : '# signed out\n'}echo "$*" >> '${log}'\nexit ${exitCode}\n` });
      const cli = writeCli(0);
      // The Agent's config dir is its sign-in state; the process log lives outside it.
      const codexHome = join(home, 'codex-home');
      const otherHome = join(home, 'other-codex-home');
      await mkdir(codexHome, { recursive: true });
      await mkdir(otherHome, { recursive: true });
      // The real activated Codex plugin supplies its auth probe and native-home declaration.
      const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
      onTestFinished(async () => await fixture.dispose());
      const spawn = async (codexHome: string) => await resolveSpawnChildEnvironment({
        happyHomeDir: fixture.happyHomeDir,
        pluginRuntimeRegistry: fixture.registry,
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } },
        profileEnvironmentVariables: {},
        daemonSpawnHooks: { resolveRuntimePrerequisites: async () => ({ ok: true }) },
        processEnv: { PATH: '', HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, HAPPIER_HOME_DIR: fixture.happyHomeDir, HAPPIER_CODEX_PATH: cli, HAPPIER_JS_RUNTIME_PATH: process.execPath },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      });
      const authProbes = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n')
        .filter((line) => line.includes('login status')).length;

      for (let index = 0; index < 3; index += 1) expect(await spawn(codexHome)).toMatchObject({ ok: true });
      expect(await authProbes()).toBe(1);
      expect(await spawn(otherHome)).toMatchObject({ ok: true });
      expect(await authProbes()).toBe(2);
      // A replaced binary changes its stat identity and is observed again.
      writeCli(1);
      expect(await spawn(codexHome)).toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT });
      expect(await authProbes()).toBe(3);
      // Codex may keep its sign-in in the OS keyring (cli_auth_credentials_store), so it declares no
      // observable sign-in state: a signed-out answer is checked again on the next spawn.
      expect(await spawn(codexHome)).toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT });
      expect(await authProbes()).toBe(4);
    } finally {
      await removeTempDir(home);
    }
  });

  it.each(['profile', 'connected', 'provider'] as const)('admits credentials from the effective %s environment', async (source) => {
    const home = await createTempDir('happier-spawn-effective-auth-', tmpdir());
    try {
      const cli = writeExecutableShimSync({
        dir: home,
        fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n',
      });
      const result = await resolveSpawnChildEnvironment({
        pluginRuntimeRegistry: await createPinnedSpawnAgentRegistry(),
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } },
        profileEnvironmentVariables: source === 'profile' ? { CODEX_API_KEY: 'fixture-key' } : {},
        daemonSpawnHooks: { resolveRuntimePrerequisites: async () => ({ ok: true }) },
        processEnv: { PATH: '', HOME: home, USERPROFILE: home, CODEX_HOME: home, HAPPIER_HOME_DIR: home, HAPPIER_CODEX_PATH: cli, HAPPIER_JS_RUNTIME_PATH: process.execPath },
        ...(source === 'connected' ? { connectedServiceAuth: { env: { CODEX_API_KEY: 'fixture-key' }, cleanupOnFailure: null, cleanupOnExit: null } } : {}),
        ...(source === 'provider' ? { providerEnvironmentOverlay: [{ name: 'CODEX_API_KEY', value: 'fixture-key', source: 'provider' as const }] } : {}),
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.errorMessage);
      expect(result.agentCliLaunchSpec?.resolvedPath).toBe(cli);
      expect(result.extraEnvForChild.CODEX_API_KEY).toBe('fixture-key');
    } finally {
      await removeTempDir(home);
    }
  });

  it('admits a materialized Provider binding without requiring unrelated native login', async () => {
    const home = await createTempDir('happier-spawn-provider-auth-', tmpdir());
    try {
      const cli = writeExecutableShimSync({
        dir: home, fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32'
          ? '@echo off\r\nif "%1"=="--version" (echo 1.2.3 & exit /b 0)\r\nexit /b 1\r\n'
          : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.3; exit 0; fi\nexit 1\n',
      });
      const connectionId = ProviderConnectionIdSchema.parse('pc_fixture');
      const result = await resolveSpawnChildEnvironment({
        pluginRuntimeRegistry: await createPinnedSpawnAgentRegistry(),
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } },
        profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        processEnv: { PATH: '', HOME: home, USERPROFILE: home, CODEX_HOME: home, HAPPIER_HOME_DIR: home, HAPPIER_CODEX_PATH: cli, HAPPIER_JS_RUNTIME_PATH: process.execPath },
        providerBindingContext: { v: 1, agentTargetKey: 'codex', connectionId, modelId: 'fixture-model' },
        // The already-authorized Provider materializer is the external boundary.
        // Its real Codex adapter clears native keys and owns a separate transport key.
        materializeProviderBindingAfterHooks: async () => ({
          ok: true,
          providerEnvironmentOverlay: [
            { name: 'CODEX_API_KEY', value: null, source: 'provider' },
            { name: 'OPENAI_API_KEY', value: null, source: 'provider' },
            { name: 'HAPPIER_CODEX_PROVIDER_API_KEY', value: 'fixture-key', source: 'provider' },
          ],
          providerBindingLaunchHandoff: {
            v: 1, materialization: { v: 1, kind: 'spawnEnv' },
            sessionBindingMetadata: {
              v: 1, connectionId, contributionKey: 'plugin.openrouter/openrouter', connectionRevision: 1,
              protocol: 'openai-responses', materialization: 'spawnEnv', adapterBindingKey: 'fixture',
              compatibilityFingerprint: 'fixture-compatibility', bindingSecurityFingerprint: 'fixture-security',
              displaySnapshot: { providerName: 'Fixture', connectionName: 'Fixture', connectionRole: 'named', connectionDisplayNameMode: 'custom' },
            },
          },
        }),
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      });
      expect(result).toMatchObject({ ok: true, extraEnvForChild: { HAPPIER_CODEX_PROVIDER_API_KEY: 'fixture-key' } });
      if (!result.ok) throw new Error(result.errorMessage);
      expect(result.extraEnvForChild).not.toHaveProperty('CODEX_API_KEY');
      expect(result.unsetEnvKeys).toContain('CODEX_API_KEY');
    } finally {
      await removeTempDir(home);
    }
  });
});
