import { PluginAgentContributionV2Schema, type PluginAgentCliMetadata } from '@happier-dev/protocol';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { createManifestAgentCatalogEntry, createNativeAgentCliAuthSpec } from './agentCliMetadata';
import { resolveAgentSkillsCapability } from '@/agent/skills/resolveAgentSkillsCapability';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-muse';
import { buildMuseNativeAuth } from '../../../../../../packages/plugins/muse/src/connectedAccounts/nativeAuth';
import { MUSE_NATIVE_HOME } from '../../../../../../packages/plugins/muse/src/connectedAccounts/declarations';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from './fullProjection';
import { activatePluginRuntimeRegistry } from '@/plugins/runtime/lifecycle/manager';
import { projectActivatedAgentContributions } from '@/plugins/runtime/composition/activatedContributions';
import { createBundledActivationSourceResolver } from '@/plugins/runtime/bundledActivationSource';
import { bindPluginRuntimeSourceAuthority } from '@/plugins/runtime/sourceAuthority';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';

function metadata(params: Readonly<{
  environmentVariables?: readonly string[];
  credentialPaths?: readonly string[];
  missingCredentialState?: 'logged_out' | 'unknown';
  nonInteractiveStatusProbe?: true;
}>): PluginAgentCliMetadata {
  return {
    executable: {
      binaryName: 'acme',
      sourcePreference: 'system-first',
    },
    install: {
      managed: null,
      manual: { kind: 'command' },
    },
    auth: {
      support: 'status_only',
      ...(params.environmentVariables ? { environmentVariables: [...params.environmentVariables] } : {}),
      ...(params.credentialPaths ? { credentialPaths: [...params.credentialPaths] } : {}),
      ...(params.missingCredentialState
        ? { missingCredentialState: params.missingCredentialState }
        : {}),
      ...(params.nonInteractiveStatusProbe ? { nonInteractiveStatusProbe: true } : {}),
      loginLaunches: [],
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('native Agent CLI auth metadata', () => {
  it('reads the actual Muse native login from its final configured home without borrowing another home', async () => {
    const directory = createTempDirSync('happier-muse-native-auth-');
    const manifest = normalizePluginManifestV2(PLUGIN_MANIFEST);
    const pluginRootPath = resolve('../../packages/plugins/muse');
    const loaded = { pluginId: manifest.id, manifest, pluginRootPath,
        manifestPath: join(pluginRootPath, 'plugin.json'), daemonEntryPath: '@happier-dev/plugins-muse',
        devDaemonEntryPath: null, sourceSpec: { kind: 'bundled', locator: '@happier-dev/plugins-muse',
          trustPolicy: 'local_trusted', installPolicy: 'copy' } } satisfies LoadedPlugin;
    const base = createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: { loadedPlugins: [loaded],
      diagnosticsByPluginId: {} }, provenance: 'first_party',
    }));
    const activated = await activatePluginRuntimeRegistry({ contributes: base, generation: 1, pluginIds: [manifest.id],
      resolveActivationSource: createBundledActivationSourceResolver({
        bundledPackageNames: ['@happier-dev/plugins-muse'], bundledDeclarations: [loaded],
        resolveDevelopmentSourceAuthority: ({ rootPath }) => {
          const authority = bindPluginRuntimeSourceAuthority({ custody: { kind: 'development', registeredRootId: rootPath },
            resolvedRoot: rootPath, observedRevision: 1 });
          return authority.kind === 'development' ? authority : null;
        },
      }),
    });
    try {
      const entry = projectActivatedAgentContributions(base, activated, () => true).agents[0]?.catalogEntry;
      expect({ nativeHome: entry?.connectedAccountNativeHome, diagnostics: activated.pluginDiagnosticsByPluginId })
        .toMatchObject({ nativeHome: MUSE_NATIVE_HOME });
      const spec = await entry?.getCliAuthSpec?.();
      const home = join(directory, 'session-home');
      const config = join(directory, 'selected-config');
      const env = { HOME: home, USERPROFILE: home };
      const auth = buildMuseNativeAuth({ access_token: 'fixture-access-token', api_key: 'fixture-inference-key',
        api_base_url: 'https://api.meta.ai', obtained_via: 'native-login', mechanism: 'oauth' });
      const writeAuth = (root: string, content = JSON.stringify(auth)) => {
        mkdirSync(join(root, 'muse'), { recursive: true });
        writeFileSync(join(root, 'muse', 'auth.json'), content);
      };
      writeAuth(join(home, '.config'));
      await expect(spec?.detectAuthStatus?.({ resolvedPath: '/unused', processEnv: env }))
        .resolves.toMatchObject({ state: 'logged_in', source: 'file' });
      const selected = { ...env, XDG_CONFIG_HOME: config };
      await expect(spec?.detectAuthStatus?.({ resolvedPath: '/unused', processEnv: selected }))
        .resolves.toMatchObject({ state: 'logged_out', reason: 'missing_credentials' });
      writeAuth(config, '{invalid');
      await expect(spec?.detectAuthStatus?.({ resolvedPath: '/unused', processEnv: selected }))
        .resolves.toMatchObject({ state: 'logged_out', reason: 'missing_credentials' });
      writeAuth(config);
      await expect(spec?.detectAuthStatus?.({ resolvedPath: '/unused', processEnv: selected }))
        .resolves.toMatchObject({ state: 'logged_in', source: 'file' });
      await expect(spec?.detectAuthStatus?.({ resolvedPath: '/unused', processEnv: { ...env, XDG_CONFIG_HOME: 'relative' } }))
        .resolves.toMatchObject({ state: 'unknown', reason: 'probe_failed' });
      await expect(spec?.detectAuthStatus?.({ resolvedPath: '/unused', processEnv: selected,
        nativeExecution: { agentIsolation: { read: () => undefined }, cwd: directory,
          processEnv: selected, signal: new AbortController().signal } }))
        .resolves.toMatchObject({ state: 'unknown', reason: 'unsupported' });
    } finally { await activated.dispose(); removeTempDirSync(directory); }
  });
  it('reads implicit credentials from each invoking Session while preserving explicit environments', async () => {
    vi.stubEnv('HAPPIER_AUTH_METADATA_KEY', 'host-key');
    const spec = createNativeAgentCliAuthSpec(metadata({ environmentVariables: ['HAPPIER_AUTH_METADATA_KEY'] }));
    const results = await Promise.all([true, false].map((present) => runAddedHostedSession({
      environment: present ? { NODE_ENV: 'test', HAPPIER_AUTH_METADATA_KEY: 'session-key' } : { NODE_ENV: 'test' },
      workingDirectory: process.cwd(), end() {},
    }, async () => {
      await Promise.resolve();
      return {
        scoped: await spec.detectAuthStatus?.({ resolvedPath: '/unused' }),
        explicit: await spec.detectAuthStatus?.({ resolvedPath: '/unused', processEnv: { NODE_ENV: 'test' } }),
      };
    })));
    expect(results).toEqual([
      { scoped: { state: 'logged_in', method: 'api_key_env', source: 'env' }, explicit: { state: 'logged_out', reason: 'missing_credentials' } },
      { scoped: { state: 'logged_out', reason: 'missing_credentials' }, explicit: { state: 'logged_out', reason: 'missing_credentials' } },
    ]);
  });

  it('projects the exact manifest skill delivery facts into the current Agent catalog', () => {
    const skills = { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported',
      usageEvidence: 'none', nativeRoots: { user: [['.agents', 'skills']] } } as const;
    const entry = createManifestAgentCatalogEntry({
      agentId: 'fixture', pluginId: 'fixture', provenance: 'first_party', cli: null,
      definition: { id: 'fixture', title: 'Fixture', primary: 'sessions', runtime: { kind: 'custom' },
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
          skills: { ...skills, nativeRoots: { user: [['.agents', 'skills']] } } } },
    });
    expect(entry).toHaveProperty('skills', skills);
    if (!entry) throw new Error('Expected an Agent catalog entry');
    expect(resolveAgentSkillsCapability('fixture', { catalogEntriesById: { fixture: entry } })).toEqual(skills);
    expect(resolveAgentSkillsCapability('fixture', { catalogEntriesById: {} })).toEqual({
      delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported',
    });
  });
  it('projects an external Agent command policy and leaves an undeclared policy absent', () => {
    const cli = metadata({});
    const declaration = {
      id: 'assistant', title: 'Assistant', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
    };
    const withPolicy = PluginAgentContributionV2Schema.parse({
      ...declaration, cli: { ...cli, commandPolicy: { daemonAutostartDefault: 'preferLocalTui' } },
    });
    const withoutPolicy = PluginAgentContributionV2Schema.parse({ ...declaration, cli });
    const project = (definition: typeof withPolicy) => createManifestAgentCatalogEntry({
      agentId: 'acme.assistant/assistant', pluginId: 'acme.assistant', definition,
      cli: definition.cli ?? null, provenance: 'external',
    });
    expect(project(withPolicy)?.cliCommandPolicy).toEqual({ daemonAutostartDefault: 'preferLocalTui' });
    expect(project(withoutPolicy)?.cliCommandPolicy).toBeUndefined();
    const withNativeCodeMode = PluginAgentContributionV2Schema.parse({
      ...declaration, cli, capabilities: { ...declaration.capabilities, tools: { delivery: 'native_mcp', nativeCodeMode: true } },
    });
    expect(project(withNativeCodeMode)?.nativeCodeMode).toBe(true);
    expect(project(withoutPolicy)?.nativeCodeMode).toBeUndefined();
  });
  it('reads credentials only from the supplied environment and home', async () => {
    const ambientHome = createTempDirSync('happier-auth-ambient-');
    const launchHome = createTempDirSync('happier-auth-launch-');
    try {
      vi.stubEnv('HOME', ambientHome);
      vi.stubEnv('USERPROFILE', ambientHome);
      vi.stubEnv('HAPPIER_AUTH_METADATA_KEY', 'ambient-key');
      writeFileSync(join(ambientHome, 'auth.json'), JSON.stringify({ token: 'ambient-token' }));
      const spec = createNativeAgentCliAuthSpec(metadata({
        environmentVariables: ['HAPPIER_AUTH_METADATA_KEY'], credentialPaths: ['~\\auth.json'],
      }));
      const args = { resolvedPath: '/unused', processEnv: {
        HOME: launchHome, USERPROFILE: launchHome, HAPPIER_AUTH_METADATA_KEY: undefined,
      } };
      await expect(spec.detectAuthStatus?.(args)).resolves.toMatchObject({ state: 'logged_out' });
      writeFileSync(join(launchHome, 'auth.json'), JSON.stringify({ token: 'launch-token' }));
      await expect(spec.detectAuthStatus?.(args)).resolves.toEqual({
        state: 'logged_in', method: 'credentials_file', source: 'file',
      });
      await expect(spec.detectAuthStatus?.({ ...args, processEnv: {
        ...args.processEnv, HAPPIER_AUTH_METADATA_KEY: 'launch-key',
      } })).resolves.toEqual({ state: 'logged_in', method: 'api_key_env', source: 'env' });
      expect(process.env.HAPPIER_AUTH_METADATA_KEY).toBe('ambient-key');
    } finally {
      removeTempDirSync(ambientHome);
      removeTempDirSync(launchHome);
    }
  });

  it('uses host-owned declared environment facts and preserves both absent-credential semantics', async () => {
    const loggedOutSpec = createNativeAgentCliAuthSpec(metadata({
      environmentVariables: ['HAPPIER_AUTH_METADATA_LOGGED_OUT'],
    }));
    const unknownSpec = createNativeAgentCliAuthSpec(metadata({
      environmentVariables: ['HAPPIER_AUTH_METADATA_UNKNOWN'],
      missingCredentialState: 'unknown',
    }));
    const manualOnlySpec = createNativeAgentCliAuthSpec(metadata({}));

    expect(loggedOutSpec.isSafeForBackgroundChecks).toBe(true);
    expect(unknownSpec.isSafeForBackgroundChecks).toBe(true);
    expect(manualOnlySpec.isSafeForBackgroundChecks).toBe(false);

    vi.stubEnv('HAPPIER_AUTH_METADATA_LOGGED_OUT', '');
    vi.stubEnv('HAPPIER_AUTH_METADATA_UNKNOWN', '');
    await expect(loggedOutSpec.detectAuthStatus?.({ resolvedPath: '/unused' })).resolves.toEqual({
      state: 'logged_out',
      reason: 'missing_credentials',
    });
    await expect(unknownSpec.detectAuthStatus?.({ resolvedPath: '/unused' })).resolves.toEqual({
      state: 'unknown',
      reason: 'unsupported',
    });

    vi.stubEnv('HAPPIER_AUTH_METADATA_LOGGED_OUT', 'present');
    vi.stubEnv('HAPPIER_AUTH_METADATA_UNKNOWN', 'present');
    await expect(loggedOutSpec.detectAuthStatus?.({ resolvedPath: '/unused' })).resolves.toEqual({
      state: 'logged_in',
      method: 'api_key_env',
      source: 'env',
    });
    await expect(unknownSpec.detectAuthStatus?.({ resolvedPath: '/unused' })).resolves.toEqual({
      state: 'logged_in',
      method: 'api_key_env',
      source: 'env',
    });
  });
});
