import {
  derivePluginDaemonContributionRegistrationRights,
  ingestPluginManifestV2,
  resolvePluginManifestSetReferencesV2,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractGitHubReleaseAsset } from '../../../cli-common/src/agents/extractGitHubReleaseAsset.js';
import { PLUGIN_MANIFEST as KIMI_PLUGIN_MANIFEST } from '../../kimi/src/manifest.js';
import { PLUGIN_MANIFEST as OPENAI_PLUGIN_MANIFEST } from '../../openai/src/manifest.js';
import { PLUGIN_MANIFEST as MUSE_PLUGIN_MANIFEST } from '../../muse/src/manifest.js';
import { CODEX_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { CODEX_ACCOUNT_USAGE_PLAN_METADATA } from './connectedAccounts/planLabels.js';
import { CODEX_PLUGIN, PLUGIN_MANIFEST } from './manifest.js';

describe('Codex plugin manifest', () => {
  it('offers the Muse account through the shared managed Responses endpoint', async () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.connectedAccounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: 'meta-inference',
        service: { pluginId: 'happier.agent.muse', localId: 'muse-account' },
        credentialKinds: ['token', 'oauth'], managedProviderEndpoint: {
          provider: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
          purpose: 'meta-upstream', modelIdPrefix: 'meta/',
        } }),
    ]));
    const { CODEX_PROVIDER_BINDING_ADAPTER_V1 } = await import('./agent/providerBinding/adapter.js');
    const agentTargetKey = 'backend:codex:built_in';
    const bindingKey = 'connected_account:muse';
    const transport = { id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } } as const;
    const materialized = await CODEX_PROVIDER_BINDING_ADAPTER_V1.materialize({ v: 1,
      prepared: CODEX_PROVIDER_BINDING_ADAPTER_V1.prepare({ v: 1, agentTargetKey, bindingKey }),
      binding: { v: 1, agentTargetKey,
        selection: { bindingKey, model: { id: 'muse-spark-1.3-contributor', name: 'Muse Spark', capabilities: {} } },
        contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
        endpoint: { endpointTemplateId: 'cliproxyapi-openai-responses',
          normalizedUrl: 'http://127.0.0.1:5100/v1', protocol: 'openai-responses', publicHeaders: {} },
        runtimeCredentialTransport: transport, compatibilityFingerprint: 'pcf1:muse' },
      credential: { kind: 'apiKey', transport, value: 'fixture-downstream-bearer' },
    });
    expect(materialized).toMatchObject({ kind: 'engineConfig', engineConfig: { config: {
      [`model_providers.${materialized.kind === 'engineConfig' ? materialized.engineConfig.modelProvider : ''}`]: {
        base_url: 'http://127.0.0.1:5100/v1', wire_api: 'responses',
        env_key: 'HAPPIER_CODEX_PROVIDER_API_KEY', requires_openai_auth: false,
      },
    } } });
  });
  it('leaves managed Muse source credentials and listing to the Provider catalog owner', async () => {
    const { prepareCodexConnectedAccountKeyPreflight } = await import('./agent/runtime/connectedAccountKeys.js');
    const service = { pluginId: 'happier.agent.muse', localId: 'muse-account' };
    const prepared = await prepareCodexConnectedAccountKeyPreflight({ environment: {},
      modelId: 'meta/muse-spark-1.3-contributor', signal: new AbortController().signal,
      connectedAccounts: {
        async getBinding(purpose) { return purpose === 'meta-inference' ? { purpose, service,
          account: { service, accountId: 'selected-muse' }, target: { kind: 'account', displayName: 'Muse' } } : null; },
        async materialize() { throw new Error('Managed Muse credentials must stay with the Provider owner'); },
        watch(_purpose, listener) { void listener({ kind: 'resync', authorityChanged: false }); return { dispose() {} }; },
      },
    });
    try { expect(prepared.environment).toEqual({}); }
    finally { await prepared.dispose(); }
  });
  it('declares the plugin-cache skill pattern through canonical manifest ingestion', () => {
    const result = ingestPluginManifestV2(PLUGIN_MANIFEST);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.manifest.contributes.agents[0]?.capabilities.skills?.nativeRoots?.plugin)
      .toEqual([['.codex', 'plugins', 'cache', '*', '{plugin}', '*', 'skills']]);
  });
  it('declares detected native MCP servers as unloaded in Happier sessions', () => {
    expect(PLUGIN_MANIFEST.contributes.mcp.discoverySources).toEqual([
      expect.objectContaining({ id: 'config', loadedInHappierSessions: false }),
    ]);
  });
  it.skipIf(process.platform !== 'linux')('installs the current Codex package size through the real bounded extractor', async () => {
    // Digest-verified rust-v0.161.0 Linux x64 package: main executable,
    // code-mode host, and an undeclared voice sidecar already exceed 384 MiB.
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-package-size-'));
    try {
      const source = join(root, 'source');
      await mkdir(join(source, 'bin'), { recursive: true });
      // rust-v0.162.1 ships this helper outside bin; Codex resolves it from
      // the package root when the host has no system bubblewrap.
      await mkdir(join(source, 'codex-resources'), { recursive: true });
      await writeFile(join(source, 'codex-resources/bwrap'), 'bundled-bubblewrap', { mode: 0o644 });
      const members = [['bin/codex', 292_309_256], ['bin/codex-code-mode-host', 74_068_880], ['voice-host', 65_039_440]] as const;
      for (const [name, size] of members) {
        const file = await open(join(source, name), 'w');
        try {
          // Sparse payloads keep fixture preparation cheap. Random prefixes keep
          // the real compression-ratio guard valid for the observed total size.
          await file.write(randomBytes(2 * 1024 * 1024));
          await file.truncate(size);
        } finally { await file.close(); }
      }
      const archive = join(root, 'codex-package.tar.gz');
      const packed = spawnSync('tar', ['-czf', archive, '-C', source, ...members.map(([name]) => name), 'codex-resources/bwrap'], { encoding: 'utf8' });
      if (packed.error) throw packed.error;
      expect(packed.status, packed.stderr).toBe(0);
      const recipe = PLUGIN_MANIFEST.contributes.agents[0]?.cli.install.managed;
      if (recipe?.kind !== 'github_release_binary') throw new Error('Expected the declared Codex release recipe');
      const outputDir = join(root, 'installed');
      await extractGitHubReleaseAsset({ archivePath: archive, archiveName: 'codex-package.tar.gz',
        extractDir: join(root, 'extract'), outputDir, outputPath: join(outputDir, 'bin/codex'),
        archiveEntries: recipe.archiveEntriesByPlatform?.linux, archiveExtractionLimits: recipe.archiveExtractionLimits });
      expect((await stat(join(outputDir, 'bin/codex'))).size).toBe(members[0][1]);
      expect((await stat(join(outputDir, 'bin/codex-code-mode-host'))).size).toBe(members[1][1]);
      expect(await readFile(join(outputDir, 'codex-resources/bwrap'), 'utf8')).toBe('bundled-bubblewrap');
      expect((await stat(join(outputDir, 'codex-resources/bwrap'))).mode & 0o111).not.toBe(0);
      await expect(stat(join(outputDir, 'voice-host'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120_000);

  it('does not impose repository tool-execution policy on Codex sessions', () => {
    const result = ingestPluginManifestV2(PLUGIN_MANIFEST);
    if (!result.ok) {
      throw new Error(`Expected the Codex plugin manifest to ingest: ${JSON.stringify(result.diagnostics)}`);
    }

    expect(result.manifest.contributes.agents[0]?.catalog?.codingPromptBehavior).toBeUndefined();
    expect(result.manifest.contributes.agents[0]?.capabilities.sessions.executionRunContext).toEqual({
      versions: [1],
    });
  });

  it('is canonical data and preserves declared runtime prerequisites', () => {
    const result = ingestPluginManifestV2(PLUGIN_MANIFEST);
    if (!result.ok) {
      throw new Error(`Expected the Codex plugin manifest to ingest: ${JSON.stringify(result.diagnostics)}`);
    }
    expect(result).toMatchObject({ ok: true });
    const openAiResult = ingestPluginManifestV2(OPENAI_PLUGIN_MANIFEST);
    if (!openAiResult.ok) {
      throw new Error(`Expected the OpenAI plugin manifest to ingest: ${JSON.stringify(openAiResult.diagnostics)}`);
    }
    const kimiResult = ingestPluginManifestV2(KIMI_PLUGIN_MANIFEST);
    if (!kimiResult.ok) {
      throw new Error(`Expected the Kimi plugin manifest to ingest: ${JSON.stringify(kimiResult.diagnostics)}`);
    }
    const museResult = ingestPluginManifestV2(MUSE_PLUGIN_MANIFEST);
    if (!museResult.ok) {
      throw new Error(`Expected the Muse plugin manifest to ingest: ${JSON.stringify(museResult.diagnostics)}`);
    }
    // Resolve each declared connected-account service against its descriptor owner.
    expect(resolvePluginManifestSetReferencesV2([
      result.manifest,
      openAiResult.manifest,
      kimiResult.manifest,
      museResult.manifest,
    ])).toEqual({ ok: true });
    expect(ingestPluginManifestV2(JSON.stringify(PLUGIN_MANIFEST))).toEqual(result);
    const missingAgentResult = ingestPluginManifestV2({
      ...PLUGIN_MANIFEST,
      contributes: {
        ...PLUGIN_MANIFEST.contributes,
        agents: [],
      },
    });
    expect(missingAgentResult).toEqual({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: 'plugin_manifest_dangling_reference',
          path: ['contributes', 'settings', 0, 'target', 'agent'],
        }),
        expect.objectContaining({
          code: 'plugin_manifest_dangling_reference',
          path: ['contributes', 'voiceProviders', 0, 'execution', 'agent'],
        }),
      ],
    });
    expect(PLUGIN_MANIFEST.contributes.settings).toEqual([
      CODEX_AGENT_SETTINGS_CONTRIBUTION,
    ]);
    expect(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors).toMatchObject([{
      id: 'openai-codex',
      title: 'ChatGPT',
      // 2b5d853ffbb2: this service owns the Codex account usage identity.
      usageIdentity: { providerId: 'openai-codex' },
      metadata: CODEX_ACCOUNT_USAGE_PLAN_METADATA,
      recoveryCredits: { supported: true },
      authentication: {
        account: { artifactId: 'connected-account-authentication', exportName: 'activate' },
        defaultModeId: 'oauth',
        modes: [{
          id: 'oauth',
          kind: 'oauthAuthorizationCode',
          callbackUrl: expect.any(String),
          scopes: ['openid', 'profile', 'email', 'offline_access'],
          pkce: 'required',
          outcomeReconciliation: 'none',
        }, {
          id: 'device',
          kind: 'oauthDeviceCode',
          scopes: ['openid', 'profile', 'email', 'offline_access'],
          outcomeReconciliation: 'none',
        }, expect.objectContaining({
          id: 'native-import',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [expect.objectContaining({
            id: 'source', secret: false, default: 'native',
            schema: { type: 'string', enum: ['native'] },
          })],
        })],
      },
    }]);
    expect(derivePluginDaemonContributionRegistrationRights(
      result.manifest.contributes,
    )).toContainEqual(expect.objectContaining({
      family: 'connectedAccountDescriptors',
      localId: 'openai-codex',
    }));
    expect(PLUGIN_MANIFEST.hostAccess.required).toContainEqual(expect.objectContaining({
      id: 'openai-codex-oauth',
      capability: 'network',
      scope: {
        targets: [
          { kind: 'fixedOrigin', origin: 'https://auth.openai.com' },
          { kind: 'connectedAccountOrigin', service: 'openai-codex' },
        ],
        methods: ['POST'],
      },
    }));
    expect(PLUGIN_MANIFEST.contributes.managedDependencies).toEqual([
      expect.objectContaining({ id: 'codex-acp', executable: 'codex-acp' }),
    ]);
    expect(PLUGIN_MANIFEST.hostAccess.required.find(
      (request) => request.id === 'codex-process',
    )?.scope).toMatchObject({
      envKeys: expect.arrayContaining(['CODEX_HOME', 'CODEX_SQLITE_HOME']),
    });
    expect(PLUGIN_MANIFEST.contributes.hooks?.map((hook) => hook.on)).toEqual([
      'agent.resolvePrerequisites', 'agent.spawnEnv.augment',
    ]);
    expect(result.manifest.contributes.agents[0]?.connectedAccounts).toEqual([{
      purpose: 'primary',
      service: 'openai-codex',
      required: false,
      credentialKinds: ['oauth'],
      materializationKinds: ['files'],
    },
    expect.objectContaining({ purpose: 'meta-inference', service: { pluginId: 'happier.agent.muse', localId: 'muse-account' } }),
    expect.objectContaining({ purpose: 'kimi-code-api-key', credentialKinds: ['token'], materializationKinds: ['environment'] }),
    expect.objectContaining({ purpose: 'openai-api-key', credentialKinds: ['token'], materializationKinds: ['environment'] }),
    ]);
    expect(result.manifest.contributes.agents[0]?.capabilities.sessions.startupInstructions).toEqual({
      versions: [1],
      revisionChanges: 'resume',
    });
    expect(result.manifest.contributes.agents[0]?.catalog?.codingPromptBehavior).toBeUndefined();
    expect(result.manifest.contributes.agents[0]?.catalog?.resumeChecklist).toEqual({
      includeLoginStatus: true,
    });
    expect(result.manifest.contributes.agents[0]?.cli.auth.nonInteractiveStatusProbe).toBe(true);
    expect(PLUGIN_MANIFEST.contributes.voiceProviders).toEqual([{
      id: 'realtime-codex',
      title: 'Codex Realtime Voice',
      // The canonical Voice declaration has carried this description since 03cfeee1e8.
      description: { key: 'settingsVoice.mode.codexRealtimeSubtitle', fallback: 'Speak directly with the active Codex agent session.' },
      mark: { kind: 'agent', agentId: 'codex' },
      kind: 'conversation',
      roles: [
        'conversation_stt',
        'conversation_tts',
        'realtime_conversation',
        'turn_control',
      ],
      platforms: ['web', 'ios', 'android'],
      capabilities: {
        turn: { cancelResponse: false, bargeIn: false },
        tools: { effectCalls: 'none' },
      },
      execution: {
        kind: 'experimental_agent_session_realtime',
        agent: 'codex',
      },
      settings: {
        schemaVersion: 2,
        fields: [],
        privacyDisclosure: {
          key: 'settingsVoice.realtimeProviders.codex.privacyDisclosure',
          fallback: 'Audio and the Codex Live conversation are sent from this device to OpenAI using WebRTC. The selected Codex session and Connected Services account run through the selected machine. OpenAI may receive bounded startup and session context and delegated Codex results so the conversation can continue and responses can be spoken. Happier’s server and relay do not carry Codex Live audio; the Happier daemon/app-server still carries signaling, session lifecycle, delegation, tools, and permission control. Provider-operated network relays may participate. Codex or OpenAI may retain developer instructions, realtime conversation material, and related diagnostics in provider-native runtime storage according to the selected account and provider policies; Happier does not delete or rewrite that provider-native data.',
        },
        privacyFacts: {
          audioDestination: 'OpenAI',
          processor: 'Codex Live · OpenAI',
          retention: {
            key: 'settingsVoice.pages.privacy.servicePolicy',
            fallback: 'Follows your service account settings and terms.',
          },
        },
        connectedServicesBinding: {
          id: 'globalConnectedServices',
          title: 'Codex account',
          description: 'Connected Service account used by global Codex Voice sessions.',
          agent: 'codex',
          serviceIds: ['openai-codex'],
        },
      },
      client: {
        artifactId: 'voice-runtime-web',
        exportName: 'activate',
      },
    }]);
    const disclosure = PLUGIN_MANIFEST.contributes.voiceProviders[0]?.settings?.privacyDisclosure;
    const fallback = typeof disclosure === 'string' ? disclosure : disclosure?.fallback ?? '';
    expect(fallback).toMatch(/selected .*account/iu);
    expect(fallback).toMatch(/provider-native runtime storage/iu);
    expect(fallback).toMatch(/may retain/iu);
    expect(fallback).toMatch(/does not delete or rewrite/iu);
  });

  it('registers focused startup and experimental resume callbacks without a cache flag', async () => {
    const register = vi.fn();
    const ignoreRegistration = vi.fn();
    const agents = new Proxy({ register }, {
      get(target, property) {
        return Reflect.get(target, property) ?? ignoreRegistration;
      },
    });
    const api = new Proxy({ agents }, {
      get(target, property) {
        return Reflect.get(target, property) ?? new Proxy({}, {
          get: () => ignoreRegistration,
        });
      },
    });

    await CODEX_PLUGIN.activate(api as never);

    expect(register).toHaveBeenCalledWith('codex', expect.any(Function), expect.objectContaining({
      sessionStartup: {
        shouldUseDeferredBootstrap: expect.any(Function),
      },
      vendorResumeSupport: {
        supportsVendorResume: expect.any(Function),
      },
    }));
    const [, , options] = register.mock.calls[0] ?? [];
    expect(options).not.toHaveProperty('releasedOverridesCacheV1');
    expect(options.sessionStartup).not.toHaveProperty('releasedOverridesCacheV1');
  });
});
