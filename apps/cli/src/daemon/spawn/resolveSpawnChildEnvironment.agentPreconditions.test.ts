import { unexpectedProjectNativeAdapterResolution } from "@/plugins/testkit/unexpectedProjectNativeAdapterResolution";
import { unexpectedCaptureSourceResolution } from "@/plugins/testkit/unexpectedCaptureSourceResolution";
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { prepareDaemonSpawnChildEnvironment } from './prepareDaemonSpawnChildEnvironment';

function createPinnedSpawnAgentRegistry(): ResolvedExecutablePluginRuntimeRegistry {
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
  return {
    contributes: createResolvedContributionRegistry({ agents, activationTargets: [] }),
    hookHandlersByHookId: new Map(), agentRuntimesByAgentId: new Map(), scmHostingProvidersById: new Map(),
    pluginDiagnosticsByPluginId: {}, activatedPluginIds: new Set<string>(),
    resolveCaptureSource: unexpectedCaptureSourceResolution,
    resolveProjectNativeAdapter: unexpectedProjectNativeAdapterResolution,
    activateContributionsOnDemand: async () => [], resolvePromptAssetBlocks: async () => [],
    createAgentInvocationServices: async () => { throw new Error('No plugin invocation in this spawn fixture'); },
    retireConsumers: () => {}, dispose: async () => {},
  } satisfies ResolvedExecutablePluginRuntimeRegistry;
}

describe('daemon Agent preconditions', () => {
  it('uses the activated native auth probe for an OAuth-only connected home and still rejects a missing credential', async () => {
    const home = await createTempDir('happier-spawn-activated-auth-', tmpdir());
    const fixture = await createAdmittedPluginRuntimeFixture({
      runtimeOptions: { pluginIds: [] },
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
      const params: Parameters<typeof resolveSpawnChildEnvironment>[0] = {
        happyHomeDir: fixture.happyHomeDir,
        pluginRuntimeRegistry: fixture.registry,
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } },
        profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        processEnv: { PATH: '', HOME: home, USERPROFILE: home, CODEX_HOME: join(home, 'signed-out'),
          HAPPIER_HOME_DIR: fixture.happyHomeDir, HAPPIER_CODEX_PATH: cli, HAPPIER_JS_RUNTIME_PATH: process.execPath },
        connectedServiceAuth: { env: { CODEX_HOME: connectedHome }, cleanupOnFailure: null, cleanupOnExit: null },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
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
      await expect(resolveSpawnChildEnvironment({ ...params, allowNativeAccountCredentials: false,
        connectedServiceAuth: { ...params.connectedServiceAuth!, targetMaterializedRoot: connectedHome },
        profileEnvironmentVariables: { OPENAI_API_KEY: '${CUSTODIAN_PRIVATE_KEY}' },
        processEnv: { ...params.processEnv, CUSTODIAN_PRIVATE_KEY: 'alice-private-key' },
      })).resolves.toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.AUTH_ENV_UNEXPANDED });
      await rm(join(connectedHome, 'auth.json'));
      await expect(resolveSpawnChildEnvironment(params)).resolves.toMatchObject({
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
        pluginRuntimeRegistry: createPinnedSpawnAgentRegistry(),
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
        pluginRuntimeRegistry: createPinnedSpawnAgentRegistry(),
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
        pluginRuntimeRegistry: createPinnedSpawnAgentRegistry(),
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
        pluginRuntimeRegistry: createPinnedSpawnAgentRegistry(),
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

  it.each(['profile', 'connected', 'provider'] as const)('admits credentials from the effective %s environment', async (source) => {
    const home = await createTempDir('happier-spawn-effective-auth-', tmpdir());
    try {
      const cli = writeExecutableShimSync({
        dir: home,
        fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n',
      });
      const result = await resolveSpawnChildEnvironment({
        pluginRuntimeRegistry: createPinnedSpawnAgentRegistry(),
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
        pluginRuntimeRegistry: createPinnedSpawnAgentRegistry(),
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
