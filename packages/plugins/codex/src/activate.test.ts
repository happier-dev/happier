import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { activate } from './activate.js';
import { CODEX_PROVIDER_BINDING_ADAPTER_V1 } from './agent/providerBinding/adapter.js';
import { codexExternalSessionHooksContribution } from './agent/surfaces/sessions/external/externalSessionHooks.js';
import { codexExternalSessionTakeoverContribution } from './agent/surfaces/sessions/external/takeover.js';
import { codexExternalSessionsContribution } from './index.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('activate', () => {
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
      'agents',
      'connectedAccountDescriptors',
      'hooks',
      'managedDependencies',
      'mcp',
      'settings',
      'systemTools',
      'ui',
      'voiceProviders',
    ]);
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      CODEX_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  const previousCodexHome = process.env.CODEX_HOME;

  afterEach(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it('builds Codex Session preferences through the public CLI command declaration', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const buildSessionOptions = activation.registration('agents', 'codex')?.cliSessionCommand?.buildSessionOptions;
      expect(buildSessionOptions).toBeTypeOf('function');
      expect(await buildSessionOptions?.({
        isExplicitCliSubcommand: true,
        parsed: { agentArgs: [] },
        settings: { codexBackendMode: 'acp' },
        pluginSettings: { account: { codexBackendMode: 'acp' } },
        environment: { HAPPIER_CODEX_BACKEND_MODE: 'appServer' },
        startOrigin: 'daemon',
      })).toEqual({
        ok: true,
        options: { codexBackendMode: 'appServer' },
      });
    } finally {
      await activation.dispose();
    }
  });

  it('registers Codex MCP discovery through the plugin API', async () => {
      const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-mcp-'));
      let activation: Awaited<ReturnType<typeof createPluginTestkit>> | undefined;
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, 'config.toml'), [
        '[mcp_servers.docs]',
        'command = "codex-mcp"',
        'args = ["--project", "docs"]',
      ].join('\n'));
      process.env.CODEX_HOME = codexHome;

      activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
      const agent = activation.registration('agents', 'codex');

      expect(agent).toEqual(
        expect.objectContaining({
          providerBinding: {
            v: 1,
            adapterVersion: CODEX_PROVIDER_BINDING_ADAPTER_V1.adapterVersion,
            prepare: expect.any(Function),
            materialize: expect.any(Function),
          },
          factory: expect.any(Function),
          externalSessions: {
            resolveSource: expect.any(Function),
            listCandidates: expect.any(Function),
            resolveLinkIdentity: expect.any(Function),
            resolveLinkedIdentity: expect.any(Function),
            pageTranscript: expect.any(Function),
            readAfterTranscript: expect.any(Function),
          },
          externalSessionTakeover: { resolveLaunch: expect.any(Function) },
          externalSessionHooks: {
            installationVariants: codexExternalSessionHooksContribution.installationVariants,
            resolveInstallation: expect.any(Function),
            mapHookEvent: expect.any(Function),
          },
          externalSessionObservation: {
            describeResource: expect.any(Function),
            observeResource: expect.any(Function),
            reconcileResource: expect.any(Function),
          },
        }),
      );
      expect(agent?.providerBinding).not.toBe(CODEX_PROVIDER_BINDING_ADAPTER_V1);
      expect(agent?.externalSessions).not.toBe(codexExternalSessionsContribution);
      expect(agent?.externalSessionTakeover).not.toBe(
        codexExternalSessionTakeoverContribution,
      );
      expect(agent?.externalSessionHooks).not.toBe(codexExternalSessionHooksContribution);
      const prepareInput = {
        v: 1 as const,
        agentTargetKey: 'backend:codex:built_in',
        connectionId: 'pc_codex_activation_test',
      };
      expect(agent?.providerBinding?.prepare(prepareInput)).toEqual(
        CODEX_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput),
      );
      expect(Object.keys(agent?.externalSessions ?? {}).sort()).toEqual([
        'listCandidates',
        'pageTranscript',
        'readAfterTranscript',
        'resolveLinkIdentity',
        'resolveLinkedIdentity',
        'resolveSource',
      ]);
      expect(Object.keys(
        agent?.externalSessionHooks ?? {},
      ).sort()).toEqual([
        'installationVariants',
        'mapHookEvent',
        'resolveInstallation',
      ]);
      expect(Object.keys(
        agent?.externalSessionObservation ?? {},
      ).sort()).toEqual([
        'describeResource',
        'observeResource',
        'reconcileResource',
      ]);
      expect(activation.registrations()).toEqual(expect.arrayContaining([
        { family: 'connectedAccountDescriptors', localId: 'openai-codex' },
        { family: 'mcp.discoverySources', localId: 'config' },
        { family: 'hooks', localId: 'resolve-prerequisites' },
        { family: 'hooks', localId: 'augment-spawn-env' },
      ]));
      const discovery = activation.registration('mcp.discoverySources', 'config');
      if (!discovery) throw new Error('Missing Codex MCP discovery registration');
      await expect(Reflect.apply(discovery, undefined, [{}])).resolves.toEqual({
        items: [],
        endpoints: [],
        warnings: [],
      });
    } finally {
      await activation?.dispose();
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('passes direct activation-hook payloads through to Codex spawn hooks', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: false as const,
      errorMessage: 'codex-acp unavailable',
    }));

    const prerequisiteHook = activation.registration('hooks', 'resolve-prerequisites');
    const envHook = activation.registration('hooks', 'augment-spawn-env');

    await expect(prerequisiteHook?.({
      runtimeSelection: {
        agentRuntimeSelection: { codexBackendMode: 'acp' },
      },
    }, {
      tools: { resolveManagedInstallable },
    })).resolves.toMatchObject({
      decision: 'deny',
      reasonCode: 'codex_acp_unavailable',
    });
    expect(resolveManagedInstallable).toHaveBeenCalledWith(expect.objectContaining({
      installableId: 'codex-acp',
    }));

    await expect(Promise.resolve(envHook?.({
      runtimeSelection: {
        agentRuntimeSelection: { codexBackendMode: 'appServer' },
      },
    }))).resolves.toEqual({
      HAPPIER_CODEX_BACKEND_MODE: 'appServer',
    });
    await activation.dispose();
  });

  it('registers its provider-native Session factory and leaves finite Run derivation to the host', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });

    const factory = activation.registration('agents', 'codex')?.factory;
    if (!factory) throw new Error('Missing Codex Agent registration');
    const runtime = await factory({
      plugin: { id: 'codex', version: '0.0.0' },
      agent: { id: 'codex' },
      signal: new AbortController().signal,
    });

    expect(runtime.sessions?.open).toBeTypeOf('function');
    expect(runtime.executionRuns).toBeUndefined();
    await activation.dispose();
  });

  it('captures only its strict pre-open state-sharing declaration through Agent activation', async () => {
    let registrationOptions: Parameters<PluginApi['agents']['register']>[2];
    const noop = () => undefined;

    // The host API is the system boundary. Capture the Agent registration
    // directly so a concurrent manifest-ingestion change cannot mask this
    // activation contract.
    await activate({
      agents: {
        register: (_localId, _factory, options) => {
          registrationOptions = options;
        },
        registerCliAuth: noop,
        registerExternalSessions: noop,
        registerExternalSessionHooks: noop,
        registerExternalSessionObservation: noop,
        registerExternalSessionTakeover: noop,
      },
      connectedAccounts: { register: noop },
      hooks: { register: noop },
      mcp: { registerDiscoverySource: noop, registerServer: noop },
      voiceProviders: { register: noop },
    } as unknown as PluginApi);

    const launch = registrationOptions?.connectedAccountLaunch;

    expect(launch).toMatchObject({
      stateSharingDescriptor: {
        nativeHome: {
          environmentKey: 'CODEX_HOME',
          defaultRelativePath: '.codex',
        },
        providerSupportStatus: 'supported',
        config: {
          supported: true,
          modes: ['linked', 'copied', 'isolated'],
          entries: [
            { path: 'config.toml', mode: 'force_copied' },
            { path: 'environments.toml', mode: 'linked_or_copied' },
            { path: 'hooks.json', mode: 'linked_or_copied' },
            { path: 'AGENTS.md', mode: 'linked_or_copied' },
            { path: 'AGENTS.override.md', mode: 'linked_or_copied' },
            { path: 'instructions.md', mode: 'linked_or_copied' },
            { path: 'prompts', mode: 'linked_or_copied' },
            { path: 'agents', mode: 'linked_or_copied' },
            { path: 'skills', mode: 'linked_or_copied' },
            { path: 'rules', mode: 'linked_or_copied' },
          ],
        },
        state: {
          supported: true,
          modes: ['isolated', 'shared'],
          entries: [
            { path: 'sessions', mode: 'linked' },
            { path: 'archived_sessions', mode: 'linked' },
            { path: 'session_index.jsonl', mode: 'linked' },
            { path: 'history.jsonl', mode: 'linked' },
            { path: 'memories', mode: 'linked' },
          ],
          sharedStatePrivacyRiskAcknowledgementRequired: true,
          symlinkUnavailableDegradePolicy: 'degrade_to_isolated',
        },
        authIsolation: {
          mode: 'materialized_home',
          secretEntries: ['auth.json', 'accounts'],
        },
        transforms: [{
          entry: 'config.toml',
          kind: 'rewrite_toml',
          spec: {
            setStringValues: { cli_auth_credentials_store: 'file' },
          },
        }],
      },
    });
    expect(launch?.continuity).toEqual({
      runtimeAuthAdapter: expect.objectContaining({
        classifyRuntimeAuthFailure: expect.any(Function),
        materializeActiveProfile: expect.any(Function),
        canHotApply: expect.any(Function),
        hotApply: expect.any(Function),
        probeQuota: expect.any(Function),
      }),
      verifyResumeReachable: expect.any(Function),
    });
    expect(launch).not.toHaveProperty('serviceIds');
    expect(launch).not.toHaveProperty('requestAuthUses');
    expect(launch?.stateSharingDescriptor).not.toHaveProperty('providerId');
  });
});
