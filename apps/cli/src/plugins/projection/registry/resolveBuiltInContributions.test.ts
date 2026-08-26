import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

const runBackendSessionCliCommandMock = vi.fn(async (_params: unknown) => undefined);

vi.mock('@/cli/runBackendSessionCliCommand', () => ({
  runBackendSessionCliCommand: runBackendSessionCliCommandMock,
}));

import {
  AGENT_IDS,
  getAllAgentDefinitionContracts,
  getAgentCliRuntimeSpec,
} from '@happier-dev/agents';
import { ConversationProvidersContributionProtocolV1 } from '@happier-dev/channels-protocol/v1';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { rehydrateCanonicalProtocolComposableSchema } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';

import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { resolveBuiltInContributions } from './resolveBuiltInContributions';
import * as generatedBundledPluginManifests from './sources/generatedBundledPluginManifests';
import * as generatedBundledPlugins from './sources/generatedBundledPlugins';

function readResolverSource(): string {
  return readFileSync(new URL('./resolveBuiltInContributions.ts', import.meta.url), 'utf8');
}

function readPluginContributionResolverSource(): string {
  return readFileSync(new URL('./resolvePluginContributions.ts', import.meta.url), 'utf8');
}

function readGeneratedBundledPluginsSource(): string {
  return [
    readFileSync(new URL('./sources/generatedBundledPlugins.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('./sources/generatedBundledPluginManifests.ts', import.meta.url), 'utf8'),
  ].join('\n');
}

describe('resolveBuiltInContributions', () => {
  it('keeps cold manifest discovery off the executable bindings aggregate', () => {
    const resolverSource = readResolverSource();
    const pluginContributionResolverSource = readPluginContributionResolverSource();

    expect(resolverSource).toContain(
      "import { BUNDLED_FIRST_PARTY_IMPLEMENTATION_BINDINGS } from './sources/generatedBundledPlugins';",
    );
    expect(resolverSource).toContain(
      "import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from './sources/generatedBundledPluginManifests';",
    );
    expect(pluginContributionResolverSource).toContain(
      "import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from './sources/generatedBundledPluginManifests';",
    );
    expect(pluginContributionResolverSource).not.toContain(
      "import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from './sources/generatedBundledPlugins';",
    );
    expect(resolverSource).not.toMatch(/BUNDLED_FIRST_PARTY_PLUGIN_MANIFEST_BINDINGS/);
    expect(resolverSource).not.toMatch(/@\/backends\//);
    expect(resolverSource).not.toMatch(/\.\/bundled\/catalogEntries/);
    expect(resolverSource).not.toMatch(/\bBUILT_IN_AGENT_CATALOG_ENTRIES\b/);
    expect(resolverSource).not.toMatch(/\bOPENCODE_BUNDLED_ACTIVATION_TARGET\b/);
    expect(resolverSource).not.toMatch(/from ['"][^'"]*@happier-dev\/plugins-/);
    expect(resolverSource).not.toMatch(/require\(['"]@happier-dev\/plugins-/);
    expect(resolverSource).not.toMatch(/@happier-dev\/extensions-/);
  });

  it('keeps generated bundled manifest locators data-only at daemon cold start', () => {
    const generatedSource = readGeneratedBundledPluginsSource();

    // The generator has already normalized these manifests from the bundled
    // artifact. Re-importing authored `/manifest` modules here pulls plugin
    // runtime graphs into every registry construction before any demand path.
    expect(generatedSource).not.toMatch(
      /from ['"]@happier-dev\/plugins-[^'"]+\/manifest['"]/u,
    );
    expect(generatedSource).not.toMatch(
      /@happier-dev\/plugins-(?:channels|triage)\/targeted-contributions/u,
    );
    expect(generatedSource).not.toMatch(
      /from ['"]@happier-dev\/plugins-(?:channels|triage)\/(?:runtime|daemon)['"]/u,
    );
    expect(generatedSource).toMatch(/manifest:\s*\{\s*"contributes":/u);
  });

  it('keeps the cold bundled registry trace off Protocol and Agent root barrels', () => {
    const generatedSource = readGeneratedBundledPluginsSource();
    const resolverSource = readResolverSource();
    const catalogEntryHooksSource = readFileSync(
      new URL('./agentCatalogEntryHooks.ts', import.meta.url),
      'utf8',
    );

    for (const source of [
      generatedSource,
      resolverSource,
      catalogEntryHooksSource,
    ]) {
      expect(source).not.toMatch(/from ['"]@happier-dev\/protocol['"]/u);
      expect(source).not.toMatch(/from ['"]@happier-dev\/agents['"]/u);
    }
  });

  it('admits generated bundled Channels and Triage target semantics without activating their manifests', () => {
    const channelsLocator = generatedBundledPluginManifests.BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS
      .find((locator) => locator.pluginId === 'happier.channels');
    const channelsManifest = PluginManifestV2Schema.parse(channelsLocator?.manifest);
    const channelsPoint = channelsManifest.contributes.pluginContributionPoints
      ?.find((point) => point.id === 'providers');
    const canonicalSchemaFailures = channelsPoint?.protocols.flatMap((protocol) => [
      ...(protocol.descriptor !== undefined
        && rehydrateCanonicalProtocolComposableSchema(protocol.descriptor) === null
        ? [`${protocol.id}@${protocol.version}/descriptor`]
        : []),
      ...Object.entries(protocol.operations).flatMap(([role, operation]) => [
        ...(operation.input.kind === 'protocolDefined'
          && rehydrateCanonicalProtocolComposableSchema(operation.input.schema) === null
          ? [`${protocol.id}@${protocol.version}/operations/${role}/input`]
          : []),
        ...(rehydrateCanonicalProtocolComposableSchema(operation.resultSchema) === null
          ? [`${protocol.id}@${protocol.version}/operations/${role}/result`]
          : []),
      ]),
      ...Object.entries(protocol.surfaces ?? {}).flatMap(([role, surface]) => (
        rehydrateCanonicalProtocolComposableSchema(surface.inputSchema) === null
          ? [`${protocol.id}@${protocol.version}/surfaces/${role}/input`]
          : []
      )),
    ]);

    expect(channelsPoint).toBeDefined();
    expect(canonicalSchemaFailures).toEqual([]);

    const contributes = resolveBuiltInContributions();
    const immutableGenerationIdsByPluginId = Object.freeze(Object.fromEntries(
      generatedBundledPluginManifests.BUNDLED_FIRST_PARTY_PLUGIN_METADATA.map((entry) => [
        entry.pluginId,
        `generation:${entry.pluginId}`,
      ]),
    ));
    const registry = createResolvedContributionRegistry({
      ...contributes,
      immutableGenerationIdsByPluginId,
    });
    const readAdmittedTargetedContributions = registry.readAdmittedTargetedContributions;
    if (!readAdmittedTargetedContributions) {
      throw new Error('Resolved contribution registry must expose targeted-contribution admission');
    }

    const channels = readAdmittedTargetedContributions({
      targetPluginId: 'happier.channels',
      pointId: 'providers',
      protocol: {
        id: ConversationProvidersContributionProtocolV1.id,
        version: ConversationProvidersContributionProtocolV1.version,
      },
    });
    const triage = readAdmittedTargetedContributions({
      targetPluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
      pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
      protocol: {
        id: TriageSourcesContributionProtocolV1.id,
        version: TriageSourcesContributionProtocolV1.version,
      },
    });
    const channelsAdmissionDiagnostics = Object.entries(registry.pluginDiagnosticsByPluginId)
      .flatMap(([pluginId, diagnostics]) => diagnostics.map((diagnostic) => ({ pluginId, diagnostic })))
      .filter(({ diagnostic }) => {
        const details = diagnostic.details;
        return typeof details === 'object'
          && details !== null
          && !Array.isArray(details)
          && details.targetPluginId === 'happier.channels';
      });

    expect(channelsAdmissionDiagnostics).toEqual([]);
    expect(channels?.contributions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        contributor: expect.objectContaining({
          pluginId: 'happier.channel.telegram',
          contributionId: 'telegram-provider',
        }),
      }),
      expect.objectContaining({
        contributor: expect.objectContaining({
          pluginId: 'happier.channel.discord',
          contributionId: 'discord-provider',
        }),
      }),
      expect.objectContaining({
        contributor: expect.objectContaining({
          pluginId: 'happier.scm.forge.github',
          contributionId: 'github-repository',
        }),
      }),
    ]));
    expect(triage?.contributions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        contributor: expect.objectContaining({
          pluginId: 'happier.scm.forge.github',
          contributionId: 'github-forge',
        }),
      }),
    ]));
    expect(Object.values(registry.pluginDiagnosticsByPluginId).flat())
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'target_semantics_unavailable' }),
      ]));
  });

  it('binds every statically projected first-party Agent runtime contribution from its lightweight catalog leaf', () => {
    const generatedSource = readFileSync(
      new URL('./sources/generatedBundledPlugins.ts', import.meta.url),
      'utf8',
    );

    const agentPackages = [
      'antigravity',
      'auggie',
      'claude',
      'codex',
      'cursor',
      'gemini',
      'grok',
      'kilo',
      'kimi',
      'kiro',
      'ohmypi',
      'opencode',
      'pi',
    ] as const;

    for (const packageId of agentPackages) {
      expect(generatedSource).toContain(
        `@happier-dev/plugins-${packageId}/agent/contributions/catalog`,
      );
      expect(generatedSource).not.toContain(
        `@happier-dev/plugins-${packageId}/agent/contributions/runtime`,
      );
    }
  });

  it('does not project Codex external-session factories from app-local host adapters', () => {
    const generatedSource = readFileSync(
      new URL('./sources/generatedBundledPlugins.ts', import.meta.url),
      'utf8',
    );

    expect(generatedSource).not.toMatch(/@\/session\/external\/hostAdapters\/codex/);
    expect(generatedSource).not.toMatch(/CODEX_EXTERNAL_SESSION_CREATE_CANDIDATE_HOST_ADAPTER/);
    expect(generatedSource).not.toMatch(/CODEX_EXTERNAL_SESSION_CREATE_TRANSCRIPT_STORE_ADAPTER/);
  });

  it('does not export raw pre-hook catalog entries from generated bundled plugin metadata', () => {
    expect(generatedBundledPlugins).not.toHaveProperty('BUNDLED_FIRST_PARTY_CATALOG_ENTRIES');
  });

  it('keeps generated bundled metadata free of behavior declarations', () => {
    const forbiddenBehaviorExports = [
      'BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS',
      'BUNDLED_FIRST_PARTY_AGENT_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_INSTALLABLE_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_MCP_DISCOVERY_SOURCE_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_SCM_BACKEND_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_CONNECTED_ACCOUNT_DESCRIPTOR_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_AGENT_RUNTIME_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_PLUGIN_AGENT_RUNTIME_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_EXECUTION_RUN_PROFILE_CONTRIBUTIONS',
    ] as const;

    for (const exportName of forbiddenBehaviorExports) {
      expect(generatedBundledPlugins).not.toHaveProperty(exportName);
    }
    for (const metadata of generatedBundledPluginManifests.BUNDLED_FIRST_PARTY_PLUGIN_METADATA) {
      expect(metadata).not.toHaveProperty('activationEvents');
    }
  });

  it('projects manifest-owned MCP discovery sources into the built-in contribution registry', () => {
    const contributes = resolveBuiltInContributions();

    expect(contributes.mcpDiscoverySources?.map((entry) => ({
      pluginId: entry.pluginId,
      id: entry.definition.id,
      agentId: entry.definition.metadata?.agentId,
    }))).toEqual([
      {
        pluginId: 'happier.agent.claude',
        id: 'config',
        agentId: 'claude',
      },
      {
        pluginId: 'happier.agent.codex',
        id: 'config',
        agentId: 'codex',
      },
      {
        pluginId: 'happier.agent.opencode',
        id: 'config',
        agentId: 'opencode',
      },
    ]);
  });

  it('projects built-in Provider-domain contributions with canonical owner identity', () => {
    const contributes = resolveBuiltInContributions();

    expect(contributes.providers.map((entry) => ({
      pluginId: entry.pluginId,
      localId: entry.identity.localId,
      providerId: entry.definition.id,
    }))).toEqual(expect.arrayContaining([
      { pluginId: 'happier.agent.claude', localId: 'anthropic', providerId: 'anthropic' },
      { pluginId: 'happier.provider.deepseek', localId: 'deepseek', providerId: 'deepseek' },
      { pluginId: 'happier.provider.lmstudio', localId: 'lmstudio', providerId: 'lmstudio' },
      { pluginId: 'happier.provider.ollama', localId: 'ollama', providerId: 'ollama' },
      { pluginId: 'happier.provider.openai', localId: 'openai', providerId: 'openai' },
      { pluginId: 'happier.provider.openrouter', localId: 'openrouter', providerId: 'openrouter' },
      { pluginId: 'happier.provider.zai', localId: 'zai', providerId: 'zai' },
    ]));

    const cliProxyApi = contributes.providers.find((entry) => (
      entry.identity.pluginId === 'happier.provider.cliproxyapi'
      && entry.identity.localId === 'cliproxyapi'
    ));
    expect(cliProxyApi).toMatchObject({
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: {
        managedRuntime: {
          kind: 'managed',
          endpointTemplateIds: [
            'cliproxyapi-openai-responses',
            'cliproxyapi-openai-chat',
            'cliproxyapi-anthropic',
          ],
          connectedAccounts: [{
            purpose: 'openai-upstream',
            materializationKinds: ['httpHeaders'],
          }, {
            purpose: 'anthropic-upstream',
            materializationKinds: ['httpHeaders'],
          }],
          requestAuthUses: [{
            purpose: 'openai-upstream',
            materialization: {
              kind: 'httpHeaders',
              origin: 'https://chatgpt.com',
              headerNames: ['authorization', 'chatgpt-account-id'],
            },
          }, {
            purpose: 'anthropic-upstream',
            materialization: {
              kind: 'httpHeaders',
              origin: 'https://api.anthropic.com',
              headerNames: ['authorization'],
            },
          }],
        },
      },
    });
    expect(cliProxyApi).not.toHaveProperty('managed');
    expect(cliProxyApi).not.toHaveProperty('managedRuntimeAdapter');
    expect(generatedBundledPluginManifests.BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES)
      .toContain('@happier-dev/plugins-cliproxyapi');
  });

  it('projects each canonical built-in Agent exactly once with first-party rich catalog facts', () => {
    const contributes = resolveBuiltInContributions();

    for (const agentId of AGENT_IDS) {
      const matches = contributes.agents.filter((entry) => entry.id === agentId);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.richDefinition).toMatchObject({
        provenance: 'first_party',
        definition: { id: agentId },
      });
    }

    expect(contributes.agents.find((entry) => entry.id === 'codex')?.richDefinition).toMatchObject({
      provenance: 'first_party',
      definition: {
        capabilities: { surfaces: ['terminal', 'externalSessions'] },
      },
    });
  });

    it('assembles built-in Agents without a parallel runtime contribution table', async () => {
        const contributes = resolveBuiltInContributions();
    const agentDefinitionIds = getAllAgentDefinitionContracts().map((entry) => entry.id).slice().sort();

    expect(contributes.agents.map((entry) => entry.id).slice().sort()).toEqual(agentDefinitionIds);
    expect(contributes).not.toHaveProperty('agentRuntimes');
    expect((contributes.catalogEntries ?? []).map((entry) => entry.id)).toEqual([]);
    expect(contributes.agents.map((entry) => entry.id).slice().sort()).toEqual([...AGENT_IDS].slice().sort());
    expect(contributes.agents.map((entry) => entry.id).slice().sort()).toEqual([...AGENT_IDS].slice().sort());

    for (const agent of contributes.agents) {
      expect(agent.definition).toEqual(
        expect.objectContaining({
          kindVersion: 1,
          id: agent.id,
        }),
      );
      expect(agent.catalogEntry?.id).toBe(agent.id);
      expect(agent.catalogEntry?.cliSubcommand).toBe(agent.id);
      expect(agent.catalogEntry).not.toHaveProperty('getRuntimeCore');
    }

    const opencodeAgent = contributes.agents.find((agent) => agent.id === 'opencode');
    expect(opencodeAgent?.catalogEntry).not.toHaveProperty('getManagedServerShutdownCleanup');
    expect(opencodeAgent?.catalogEntry?.resolveHostAgentRuntimeSurfaces).toBeUndefined();
    expect(opencodeAgent?.catalogEntry?.resolveSessionRuntimePreferences).toBeTypeOf('function');
    expect(opencodeAgent?.catalogEntry?.getSessionHandoffAgentBundleRecordExtractor).toBeTypeOf('function');
    const opencodeRecordExtractor = await opencodeAgent?.catalogEntry?.getSessionHandoffAgentBundleRecordExtractor?.();
    expect(opencodeRecordExtractor?.({
      agentId: 'opencode',
      remoteSessionId: 'oc-session-1',
      exportJsonBase64: Buffer.from(JSON.stringify({ id: 'oc-session-1' }), 'utf8').toString('base64'),
    })).toEqual([{ id: 'oc-session-1' }]);

    const claudeAgent = contributes.agents.find((agent) => agent.id === 'claude');
    expect(claudeAgent?.catalogEntry?.getConnectedServicesMaterializer).toBeTypeOf('function');
    expect(claudeAgent?.catalogEntry?.getConnectedServiceStateSharingDescriptor).toBeTypeOf('function');
    expect(claudeAgent?.catalogEntry?.getConnectedServiceRuntimeAuthAdapter).toBeTypeOf('function');
    expect(claudeAgent?.catalogEntry?.resolveConnectedServiceSwitchContinuity).toBeTypeOf('function');

    const qwenAgent = contributes.agents.find((agent) => agent.id === 'qwen');
    expect(qwenAgent?.catalogEntry?.getCliCommandHandler).toBeTypeOf('function');

    const kimiAgent = contributes.agents.find((agent) => agent.id === 'kimi');
    const resolveKimiSessionPreferences = kimiAgent?.catalogEntry?.resolveSessionRuntimePreferences;
    expect(resolveKimiSessionPreferences).toBeTypeOf('function');
    expect(await resolveKimiSessionPreferences?.({
      settings: { kimiAcpPythonSelector: 'poll' },
      environment: {},
      startOrigin: 'terminal',
      isExplicitCliSubcommand: true,
      parsed: { agentArgs: [] },
    })).toEqual({ environmentVariables: { HAPPIER_KIMI_ACP_SELECTOR: 'poll' } });
    expect(await resolveKimiSessionPreferences?.({
      settings: { kimiAcpPythonSelector: 'poll' },
      environment: { HAPPIER_KIMI_ACP_SELECTOR: 'auto' },
      startOrigin: 'terminal',
      isExplicitCliSubcommand: true,
      parsed: { agentArgs: [] },
    })).toEqual({ environmentVariables: { HAPPIER_KIMI_ACP_SELECTOR: 'auto' } });

    const activationTargets = contributes.activationTargets;
    expect(activationTargets).toBeDefined();
    if (!activationTargets) {
      throw new Error('Expected built-in activation target contributions');
    }
    expect(activationTargets.map((target) => [target.pluginId, target.daemonEntryPath])).toContainEqual([
      'happier.agent.gemini',
      '@happier-dev/plugins-gemini',
    ]);
    });

    it('projects first-party lazy activation events for agent, SCM, and review plugin families', () => {
        const contributes = resolveBuiltInContributions();
        const activationEventsByPluginId = new Map(
            (contributes.activationTargets ?? []).map((target) => [
                target.pluginId,
                (target as typeof target & Readonly<{ activationEvents?: readonly string[] }>).activationEvents,
            ]),
        );

        expect(activationEventsByPluginId.get('happier.agent.codex')).toEqual([]);
        expect(activationEventsByPluginId.get('happier.scm.forge.github')).toEqual([]);
        expect(activationEventsByPluginId.get('happier.scm.backend.git')).toEqual([]);
        expect(activationEventsByPluginId.get('happier.review.coderabbit')).toEqual([]);
    });

    it('projects Codex connected-service runtime control hooks from the plugin contribution', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-runtime-contribution-'));
        try {
            const contributes = resolveBuiltInContributions();
            const codexAgent = contributes.agents.find((agent) => agent.id === 'codex');
            const codexOauthRecord = buildConnectedServiceCredentialRecord({
                now: 1,
                serviceId: 'openai-codex',
                profileId: 'work',
                kind: 'oauth',
                oauth: {
                    accessToken: 'access-token',
                    refreshToken: 'refresh-token',
                    idToken: 'id-token',
                    providerAccountId: 'account-1',
                    providerEmail: 'codex@example.com',
                    scope: 'openid profile',
                    tokenType: 'Bearer',
                },
            });
            const openAiTokenRecord = buildConnectedServiceCredentialRecord({
                now: 1,
                serviceId: 'openai',
                profileId: 'api',
                kind: 'token',
                token: {
                    token: 'sk-test',
                    providerAccountId: null,
                    providerEmail: null,
                },
            });

            expect(codexAgent?.catalogEntry?.getConnectedServicesMaterializer).toBeTypeOf('function');
            expect(codexAgent?.catalogEntry?.getConnectedServiceStateSharingDescriptor).toBeTypeOf('function');
            expect(codexAgent?.catalogEntry?.getConnectedServiceRuntimeAuthAdapter).toBeTypeOf('function');
            expect(codexAgent?.catalogEntry).not.toHaveProperty('materializeConnectedServiceRuntimeAuthSelection');
            expect(codexAgent?.catalogEntry?.resolveConnectedServiceSwitchContinuity).toBeTypeOf('function');
            expect(codexAgent?.catalogEntry?.verifyResumeReachable).toBeTypeOf('function');
            expect(codexAgent?.catalogEntry?.resolveConnectedServiceCandidatePersistedSessionFile).toBeTypeOf('function');
            expect(codexAgent?.catalogEntry).not.toHaveProperty('getSessionGoalControlAdapter');
            expect(codexAgent?.catalogEntry).not.toHaveProperty('getSessionCatalogControlAdapter');
            expect(codexAgent?.catalogEntry).not.toHaveProperty('getSessionUsageLimitRecoveryControlAdapter');
            expect(codexAgent?.catalogEntry?.getVendorResumeSupport).toBeTypeOf('function');
            const codexVendorResumeSupport = await codexAgent?.catalogEntry?.getVendorResumeSupport?.();
            expect(codexVendorResumeSupport?.({ codexBackendMode: 'appServer' })).toBe(true);
    const supportsRawCodexVendorResumeInput = codexVendorResumeSupport as
        | ((params: Readonly<{ codexBackendMode?: unknown }>) => boolean)
        | undefined;
    expect(supportsRawCodexVendorResumeInput?.({ codexBackendMode: 'unknown' })).toBe(false);
    const materializer = await codexAgent?.catalogEntry?.getConnectedServicesMaterializer?.();
            const oauthResult = await materializer?.({
                materializationKey: 'mat-1',
                activeServerDir: root,
                baseDir: root,
                rootDir: root,
                connectedAccountMaterializationAuthority: {
                    kind: 'legacy_unfenced_one_shot',
                },
                recordsByServiceId: new Map([['openai-codex', codexOauthRecord]]),
                processEnv: { HOME: join(root, 'home') },
            });
            expect(oauthResult?.env).toEqual({
                CODEX_HOME: expect.stringContaining('codex-home'),
                CODEX_SQLITE_HOME: expect.stringContaining(join('home', '.codex')),
            });
            await expect(readFile(join(String(oauthResult?.env.CODEX_HOME), 'auth.json'), 'utf8')).resolves.toContain('access-token');

            const tokenResult = await materializer?.({
                materializationKey: 'mat-2',
                activeServerDir: root,
                baseDir: root,
                rootDir: root,
                connectedAccountMaterializationAuthority: {
                    kind: 'legacy_unfenced_one_shot',
                },
                recordsByServiceId: new Map([['openai', openAiTokenRecord]]),
                processEnv: { HOME: join(root, 'home') },
            });
            expect(tokenResult?.env).toEqual({
                OPENAI_API_KEY: 'sk-test',
                CODEX_SQLITE_HOME: expect.stringContaining(join('home', '.codex')),
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('projects Codex CLI auth through the plugin runtime contribution', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-cli-auth-contribution-'));
        const originalEnv = {
            CAPTURE_PATH: process.env.CAPTURE_PATH,
            CODEX_HOME: process.env.CODEX_HOME,
            HAPPIER_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS: process.env.HAPPIER_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS,
            HOME: process.env.HOME,
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            USERPROFILE: process.env.USERPROFILE,
        };
        try {
            const capturePath = join(root, 'capture.json');
            const scriptPath = join(root, 'fake-codex.cjs');
            await writeFile(
                scriptPath,
                [
                    '#!/usr/bin/env node',
                    'const fs = require("node:fs");',
                    'const args = process.argv.slice(2);',
                    'fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({ args }), "utf8");',
                    'if (args[0] === "login" && args[1] === "status") {',
                    '  process.exit(0);',
                    '}',
                    'process.exit(2);',
                ].join('\n'),
                'utf8',
            );
            await chmod(scriptPath, 0o755);

            const codexHome = join(root, '.codex');
            await mkdir(codexHome, { recursive: true });
            await writeFile(
                join(codexHome, 'auth.json'),
                JSON.stringify({
                    tokens: {
                        id_token: [
                            Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
                            Buffer.from(JSON.stringify({ email: 'projected-codex@example.test' })).toString('base64url'),
                            'signature',
                        ].join('.'),
                    },
                }),
                'utf8',
            );

            process.env.CAPTURE_PATH = capturePath;
            process.env.CODEX_HOME = codexHome;
            process.env.HAPPIER_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS = '3000';
            process.env.HOME = root;
            process.env.USERPROFILE = root;
            delete process.env.OPENAI_API_KEY;

            const contributes = resolveBuiltInContributions();
            const codexAgent = contributes.agents.find((agent) => agent.id === 'codex');
            const spec = await codexAgent?.catalogEntry?.getCliAuthSpec?.();

            expect(spec?.binaryNames).toEqual(['codex']);
            await expect(spec?.detectAuthStatus?.({ resolvedPath: scriptPath })).resolves.toMatchObject({
                state: 'logged_in',
                method: 'oauth_cli',
                source: 'command',
                accountLabel: 'projected-codex@example.test',
            });
            await expect(readFile(capturePath, 'utf8')).resolves.toBe(JSON.stringify({ args: ['login', 'status'] }));
        } finally {
            for (const [key, value] of Object.entries(originalEnv)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
            await rm(root, { recursive: true, force: true });
        }
    });

    it('projects Codex runtime facts from the bundled plugin-authored agent definition', () => {
        const contributes = resolveBuiltInContributions();
        const codexAgent = contributes.agents.find((agent) => agent.id === 'codex');
        const hostRuntimeSpec = getAgentCliRuntimeSpec('codex');

        expect(codexAgent?.catalogEntry).not.toHaveProperty('runtimeActivityApplicability');
        expect(codexAgent?.runtimeSpec).toEqual(expect.objectContaining({
          id: 'codex',
          title: 'OpenAI Codex CLI',
          binaryName: 'codex',
          managedInstall: expect.objectContaining({
            kind: 'github_release_binary',
            githubRepo: 'openai/codex',
            binaryName: 'codex',
          }),
          manualInstallKind: 'command',
          manualInstallRecipes: null,
        }));
        expect(codexAgent?.runtimeSpec).toEqual(hostRuntimeSpec);
    });

    it('projects OpenCode runtime ownership through the canonical Agent catalog', () => {
        const contributes = resolveBuiltInContributions();
        const opencodeAgent = contributes.agents.find((agent) => agent.id === 'opencode');
        expect(opencodeAgent?.catalogEntry).not.toHaveProperty('runtimeActivityApplicability');
        expect(opencodeAgent?.richDefinition).toMatchObject({
          provenance: 'first_party',
          definition: { id: 'opencode' },
        });
        expect(opencodeAgent?.runtimeSpec).toMatchObject({
          id: 'opencode',
          managedInstall: {
            kind: 'managed_package',
            packageName: 'opencode-ai',
            binaryName: 'opencode',
            packageBinarySetup: { kind: 'opencode_platform_binary' },
          },
          manualInstallKind: 'command',
          manualInstallRecipes: null,
        });
    });

    // Claude is the only bundled Agent that emits `runtime-activity-snapshot`
    // runtime events, and it now declares that fact only through the public
    // `capabilities.sessions.runtimeActivitySnapshots` manifest capability an
    // external author can type. Nothing else may claim the Activity slot: an
    // Agent that never emits a snapshot would leave `runtime.activity` pinned
    // at `unknown` for the whole Session instead of settling at `idle`.
    it('binds the Runtime Activity slot to exactly the bundled Agents that emit snapshots', () => {
        const contributes = resolveBuiltInContributions();

        expect(contributes.agents
            .filter((agent) => agent.catalogEntry?.runtimeActivityApplicability !== undefined)
            .map((agent) => [agent.id, agent.catalogEntry?.runtimeActivityApplicability]))
            .toEqual([['claude', 'supported']]);
    });

    it('projects bundled SCM hosting providers from canonical manifests', () => {
        const contributes = resolveBuiltInContributions();

        expect((contributes.scmHostingProviders ?? []).map((provider) => [
            provider.id,
            provider.pluginId,
            provider.definition.kind,
            provider.definition.capabilities,
        ]).sort()).toEqual([
            ['azure-devops', 'happier.scm.forge.azure-devops', 'azure-devops', ['detect', 'clone', 'fetch', 'push', 'pullRequest']],
            ['bitbucket', 'happier.scm.forge.bitbucket', 'bitbucket', ['detect', 'clone', 'fetch', 'push', 'pullRequest']],
            ['github', 'happier.scm.forge.github', 'github', ['detect', 'clone', 'fetch', 'push', 'pullRequest']],
            ['gitlab', 'happier.scm.forge.gitlab', 'gitlab', ['detect', 'clone', 'fetch', 'push', 'pullRequest']],
        ]);
    });

    it('projects bundled connected-account descriptors exactly once with qualified identities', () => {
        const contributes = resolveBuiltInContributions();
        const descriptors = contributes.connectedAccountDescriptors ?? [];

        expect(descriptors.map((descriptor) => [
            descriptor.pluginId,
            descriptor.definition.id,
            descriptor.definition.authentication.defaultModeId,
            descriptor.definition.authentication.modes.map(({ id, kind }) => [id, kind]),
        ])).toEqual(expect.arrayContaining([
            ['happier.agent.codex', 'openai-codex', 'oauth', [['oauth', 'oauthAuthorizationCode'], ['device', 'oauthDeviceCode']]],
            ['happier.agent.claude', 'anthropic', 'api-key', [['api-key', 'manual']]],
            ['happier.voice.openai', 'openai', 'api-key', [['api-key', 'manual']]],
        ]));
        expect(descriptors.filter((descriptor) =>
            descriptor.pluginId === 'happier.agent.codex'
            && descriptor.definition.id === 'openai-codex'
        )).toHaveLength(1);
    });

    it('projects bundled SCM backend and managed dependency contributions from canonical manifests', () => {
        const contributes = resolveBuiltInContributions();
        expect((contributes.scmBackends ?? []).map((backend) => [
            backend.id,
            backend.pluginId,
            backend.definition.kind,
        ])).toEqual(expect.arrayContaining([
            [
                'git',
                'happier.scm.backend.git',
                'git',
            ],
            [
                'sapling',
                'happier.scm.backend.sapling',
                'sapling',
            ],
        ]));
        expect((contributes.managedDependencies ?? []).map((installable) => [
            installable.pluginId,
            installable.definition.id,
        ])).toEqual(expect.arrayContaining([
            [
                'happier.scm.backend.git',
                'git-cli',
            ],
            [
                'happier.scm.backend.sapling',
                'sapling-cli',
            ],
        ]));
    });

    it('does not publish a parallel runtime registry for canonical built-in Agents', () => {
        const contributes = resolveBuiltInContributions();
    expect(contributes).not.toHaveProperty('agentRuntimes');
    expect(contributes.agents.map((agent) => agent.id).sort()).toEqual([...AGENT_IDS].sort());
  });

  it('does not project host-local runtimeCore hooks onto canonical built-in Agents', () => {
    const contributes = resolveBuiltInContributions();

    for (const agent of contributes.agents) {
      expect(agent).not.toHaveProperty('getRuntimeCore');
    }
  });

  it('projects bundled first-party source specs with protocol-visible bundled provenance', () => {
    const contributes = resolveBuiltInContributions();
    const qwenAgent = contributes.agents.find((agent) => agent.id === 'qwen');
    const qwenActivationTarget = contributes.activationTargets?.find((target) => target.pluginId === 'happier.agent.qwen');

    expect(qwenAgent?.sourceSpec?.kind).toBe('bundled');
    expect(qwenActivationTarget?.sourceSpec?.kind).toBe('bundled');
  });

  it('emits bundled source specs for every manifest-projected first-party family', () => {
    const contributes = resolveBuiltInContributions();
    const families = [
      contributes.agents,
      contributes.scmHostingProviders ?? [],
      contributes.scmBackends ?? [],
      (contributes.managedDependencies ?? []).filter((entry) => entry.pluginId !== 'happier.core'),
    ];

    for (const family of families) {
      expect(family.length).toBeGreaterThan(0);
      expect(family.every((entry) => entry.sourceSpec?.kind === 'bundled')).toBe(true);
    }
  });

  it('projects Qwen through bundled plugin metadata and routes its command through the common backend session launcher', async () => {
    runBackendSessionCliCommandMock.mockClear();
    const contributes = resolveBuiltInContributions();
    const qwenAgent = contributes.agents.find((agent) => agent.id === 'qwen');
    const qwenActivationTarget = contributes.activationTargets?.find((target) => target.pluginId === 'happier.agent.qwen');
    const handler = await qwenAgent?.catalogEntry?.getCliCommandHandler?.();

    expect(qwenAgent).toMatchObject({
      id: 'qwen',
      provenance: 'first_party',
      pluginId: 'happier.agent.qwen',
      manifestPath: 'bundled:happier.agent.qwen',
      daemonEntryPath: '@happier-dev/plugins-qwen',
      sourceSpec: {
        kind: 'bundled',
        locator: '@happier-dev/plugins-qwen',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      definition: {
        ownedBackendIds: ['qwen'],
      },
      runtimeSpec: {
        id: 'qwen',
        title: 'Qwen CLI',
        binaryName: 'qwen',
        sourcePreferenceDefault: 'system-first',
        managedInstall: {
          kind: 'managed_package',
          packageName: '@qwen-code/qwen-code',
          binaryName: 'qwen',
        },
        manualInstallKind: 'command',
      },
    });
    expect(qwenActivationTarget).toMatchObject({
      pluginId: 'happier.agent.qwen',
      manifestPath: 'bundled:happier.agent.qwen',
      daemonEntryPath: '@happier-dev/plugins-qwen',
      sourceSpec: {
        kind: 'bundled',
        locator: '@happier-dev/plugins-qwen',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
    });
    expect(handler).toBeTypeOf('function');
    await handler?.({
      args: ['qwen', '--model', 'qwen3-coder'],
      rawArgv: ['happier', 'qwen', '--model', 'qwen3-coder'],
      terminalRuntime: null,
    });

    expect(runBackendSessionCliCommandMock).toHaveBeenCalledWith(expect.objectContaining({
      backendIdForSessionRuntime: 'qwen',
      agentIdForAccountSettings: 'qwen',
    }));
  });

  it('projects Kiro through bundled plugin metadata and routes its command through the common backend session launcher', async () => {
    runBackendSessionCliCommandMock.mockClear();
    const dir = await mkdtemp(join(tmpdir(), 'happier-kiro-plugin-auth-'));
    const scriptPath = join(dir, process.platform === 'win32' ? 'kiro-cli.cmd' : 'kiro-cli');
    await writeFile(
      scriptPath,
      process.platform === 'win32'
        ? '@echo off\r\nif "%1"=="whoami" if "%2"=="--format" if "%3"=="json" echo {"email":"plugin-kiro@example.com"}\r\n'
        : '#!/bin/sh\nif [ "$1" = "whoami" ] && [ "$2" = "--format" ] && [ "$3" = "json" ]; then printf \'{"email":"plugin-kiro@example.com"}\'; fi\n',
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    const contributes = resolveBuiltInContributions();
    const kiroAgent = contributes.agents.find((agent) => agent.id === 'kiro');
    const kiroActivationTarget = contributes.activationTargets?.find((target) => target.pluginId === 'happier.agent.kiro');
    const handler = await kiroAgent?.catalogEntry?.getCliCommandHandler?.();
    const authSpec = await kiroAgent?.catalogEntry?.getCliAuthSpec?.();

    expect(kiroAgent).toMatchObject({
      id: 'kiro',
      provenance: 'first_party',
      pluginId: 'happier.agent.kiro',
      manifestPath: 'bundled:happier.agent.kiro',
      daemonEntryPath: '@happier-dev/plugins-kiro',
      sourceSpec: {
        kind: 'bundled',
        locator: '@happier-dev/plugins-kiro',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      definition: {
        ownedBackendIds: ['kiro'],
      },
      runtimeSpec: {
        id: 'kiro',
        title: 'Kiro CLI',
        binaryName: 'kiro-cli',
        sourcePreferenceDefault: 'system-first',
        managedInstall: null,
        manualInstallKind: 'command',
        docsUrl: 'https://kiro.dev/docs/cli/acp/',
      },
      catalogEntry: {
        vendorResumeSupport: 'experimental',
      },
    });
    expect(kiroActivationTarget).toMatchObject({
      pluginId: 'happier.agent.kiro',
      manifestPath: 'bundled:happier.agent.kiro',
      daemonEntryPath: '@happier-dev/plugins-kiro',
      sourceSpec: {
        kind: 'bundled',
        locator: '@happier-dev/plugins-kiro',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
    });
    expect(handler).toBeTypeOf('function');
    expect(authSpec?.detectAuthStatus).toBeTypeOf('function');
    await expect(authSpec?.detectAuthStatus?.({ resolvedPath: scriptPath })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
      accountLabel: 'plugin-kiro@example.com',
    });

    await handler?.({
      args: ['kiro', '--model', 'default'],
      rawArgv: ['happier', 'kiro', '--model', 'default'],
      terminalRuntime: null,
    });

    expect(runBackendSessionCliCommandMock).toHaveBeenCalledWith(expect.objectContaining({
      backendIdForSessionRuntime: 'kiro',
      agentIdForAccountSettings: 'kiro',
    }));

    await rm(dir, { recursive: true, force: true });
  });

  it('projects Codex CLI session command descriptors from the plugin runtime contribution', async () => {
    runBackendSessionCliCommandMock.mockClear();
    const contributes = resolveBuiltInContributions();
    const codexAgent = contributes.agents.find((agent) => agent.id === 'codex');
    const handler = await codexAgent?.catalogEntry?.getCliCommandHandler?.();

    expect(handler).toBeTypeOf('function');
    await handler?.({
      args: ['codex', '-C', '/workspace', '--model', 'gpt-5.1-codex-max', '--happy-starting-mode', 'remote', 'exec'],
      rawArgv: ['happier', 'codex', '-C', '/workspace', '--model', 'gpt-5.1-codex-max', '--happy-starting-mode', 'remote', 'exec'],
      terminalRuntime: null,
    });

    expect(runBackendSessionCliCommandMock).toHaveBeenCalledWith(expect.objectContaining({
      backendIdForSessionRuntime: 'codex',
      agentIdForAccountSettings: 'codex',
      directoryFlags: ['-C', '--cd'],
      forwardModelFlag: true,
      versionFlags: ['-V', '--version'],
      isExplicitCliSubcommand: true,
    }));
    const call = runBackendSessionCliCommandMock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
    expect(call).not.toHaveProperty('resolveExtraOptions');
    expect(codexAgent?.catalogEntry?.resolveSessionRuntimePreferences?.({
      isExplicitCliSubcommand: true,
      parsed: {
        startingMode: 'remote',
        directory: '/workspace',
        agentArgs: ['exec', '--model', 'gpt-5.1-codex-max'],
      },
      settings: { codexBackendMode: 'appServer' },
      environment: {},
      startOrigin: 'terminal',
    })).toEqual({
      startingMode: 'remote',
      directory: '/workspace',
      codexArgs: ['exec', '--model', 'gpt-5.1-codex-max'],
      codexBackendMode: 'appServer',
    });
  });

  it('projects Claude CLI session command descriptors from the canonical Agent registration', async () => {
    runBackendSessionCliCommandMock.mockClear();
    const contributes = resolveBuiltInContributions();
    const claudeAgent = contributes.agents.find((agent) => agent.id === 'claude');
    const handler = await claudeAgent?.catalogEntry?.getCliCommandHandler?.();

    expect(handler).toBeTypeOf('function');
    await handler?.({
      args: ['claude', '--js-runtime', 'bun', '--happy-starting-mode', 'terminal', '--resume', 'vendor-session-1'],
      rawArgv: ['happier', 'claude', '--js-runtime', 'bun', '--happy-starting-mode', 'terminal', '--resume', 'vendor-session-1'],
      terminalRuntime: null,
    });

    expect(runBackendSessionCliCommandMock).toHaveBeenCalledWith(expect.objectContaining({
      backendIdForSessionRuntime: 'claude',
      agentIdForAccountSettings: 'claude',
      directoryFlags: ['-C', '--cd'],
      forwardModelFlag: true,
      yoloProviderArgs: ['--dangerously-skip-permissions'],
      versionFlags: ['-v', '--version'],
      isExplicitCliSubcommand: true,
    }));
    const call = runBackendSessionCliCommandMock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
    expect(call).not.toHaveProperty('resolveExtraOptions');
    expect(claudeAgent?.catalogEntry?.resolveSessionRuntimePreferences?.({
      isExplicitCliSubcommand: true,
      parsed: {
        startingMode: 'terminal',
        directory: '/workspace',
        resume: 'vendor-session-1',
        agentArgs: ['--model', 'claude-opus-4-6', '--js-runtime', 'bun'],
      },
      settings: { claudeUnifiedTerminalResumeChoice: 'ask_every_time' },
      environment: {},
      startOrigin: 'terminal',
    })).toEqual({
      startingMode: 'terminal',
      directory: '/workspace',
      jsRuntime: 'bun',
      resume: undefined,
      claudeArgs: ['--model', 'claude-opus-4-6', '--resume', 'vendor-session-1'],
      claudeUnifiedTerminalResumeChoice: 'ask_every_time',
    });

    expect(claudeAgent?.catalogEntry?.resolveSessionRuntimePreferences?.({
      isExplicitCliSubcommand: false,
      parsed: {
        resume: 'session_happy_123',
        agentArgs: ['--model', 'claude-opus-4-6'],
      },
      settings: {},
      environment: {},
      startOrigin: 'terminal',
    })).toEqual({
      claudeArgs: ['--model', 'claude-opus-4-6'],
      claudeUnifiedTerminalResumeChoice: 'ask_every_time',
    });
  });

  it('projects OpenCode Agent-native info command prefixes from the plugin runtime contribution', async () => {
    runBackendSessionCliCommandMock.mockClear();
    const contributes = resolveBuiltInContributions();
    const opencodeAgent = contributes.agents.find((agent) => agent.id === 'opencode');
    const handler = await opencodeAgent?.catalogEntry?.getCliCommandHandler?.();

    expect(handler).toBeTypeOf('function');
    await handler?.({
      args: ['opencode', 'providers', 'list'],
      rawArgv: ['happier', 'opencode', 'providers', 'list'],
      terminalRuntime: null,
    });

    expect(runBackendSessionCliCommandMock).toHaveBeenCalledWith(expect.objectContaining({
      backendIdForSessionRuntime: 'opencode',
      agentIdForAccountSettings: 'opencode',
      providerInfoCommandPrefixes: [['providers', 'list']],
    }));
  });

  it('projects Antigravity Agent-native model info command prefix from the plugin runtime contribution', async () => {
    runBackendSessionCliCommandMock.mockClear();
    const contributes = resolveBuiltInContributions();
    const antigravityAgent = contributes.agents.find((agent) => agent.id === 'antigravity');
    const handler = await antigravityAgent?.catalogEntry?.getCliCommandHandler?.();

    expect(handler).toBeTypeOf('function');
    await handler?.({
      args: ['antigravity', 'models'],
      rawArgv: ['happier', 'antigravity', 'models'],
      terminalRuntime: null,
    });

    expect(runBackendSessionCliCommandMock).toHaveBeenCalledWith(expect.objectContaining({
      backendIdForSessionRuntime: 'antigravity',
      agentIdForAccountSettings: 'antigravity',
      providerInfoCommandPrefixes: [['models']],
    }));
  });

  it.each([
    {
      agentId: 'kilo',
      pluginId: 'happier.agent.kilo',
      packageName: '@happier-dev/plugins-kilo',
      title: 'Kilo CLI',
      binaryName: 'kilo',
      managedPackageName: '@kilocode/cli',
    },
    {
      agentId: 'copilot',
      pluginId: 'happier.agent.copilot',
      packageName: '@happier-dev/plugins-copilot',
      title: 'GitHub Copilot CLI',
      binaryName: 'copilot',
      managedPackageName: '@github/copilot',
    },
  ])('projects $agentId through bundled plugin metadata and routes command through the common launcher', async ({
    agentId,
    pluginId,
    packageName,
    title,
    binaryName,
    managedPackageName,
  }) => {
    runBackendSessionCliCommandMock.mockClear();
    const contributes = resolveBuiltInContributions();
    const agent = contributes.agents.find((entry) => entry.id === agentId);
    const activationTarget = contributes.activationTargets?.find((target) => target.pluginId === pluginId);
    const handler = await agent?.catalogEntry?.getCliCommandHandler?.();

    expect(agent).toMatchObject({
      id: agentId,
      provenance: 'first_party',
      pluginId,
      manifestPath: `bundled:${pluginId}`,
      daemonEntryPath: packageName,
      definition: {
        ownedBackendIds: [agentId],
      },
      runtimeSpec: {
        id: agentId,
        title,
        binaryName,
        sourcePreferenceDefault: 'system-first',
        managedInstall: {
          kind: 'managed_package',
          packageName: managedPackageName,
          binaryName,
        },
        manualInstallKind: 'command',
      },
    });
    expect(activationTarget).toMatchObject({
      pluginId,
      manifestPath: `bundled:${pluginId}`,
      daemonEntryPath: packageName,
    });
    expect(handler).toBeTypeOf('function');
    await handler?.({
      args: [agentId, '--flag'],
      rawArgv: ['happier', agentId, '--flag'],
      terminalRuntime: null,
    });

    expect(runBackendSessionCliCommandMock).toHaveBeenCalledWith(expect.objectContaining({
      backendIdForSessionRuntime: agentId,
      runtimeAuthorityAgentId: agentId,
      agentIdForAccountSettings: agentId,
    }));
  });

  it('routes every bundled Agent session command through one projected builder carrying runtime authority and account-settings identity', async () => {
    const contributes = resolveBuiltInContributions();
    const bundledAgentIds = getAllAgentDefinitionContracts().map((definition) => definition.id);

    expect(bundledAgentIds.length).toBeGreaterThanOrEqual(17);

    for (const agentId of bundledAgentIds) {
      runBackendSessionCliCommandMock.mockClear();
      const agent = contributes.agents.find((entry) => entry.id === agentId);
      const handler = await agent?.catalogEntry?.getCliCommandHandler?.();

      expect(handler, `expected a session command handler for bundled Agent '${agentId}'`).toBeTypeOf('function');
      await handler?.({
        args: [agentId],
        rawArgv: ['happier', agentId],
        terminalRuntime: null,
      });

      expect(
        runBackendSessionCliCommandMock,
        `expected bundled Agent '${agentId}' to keep its session command identity`,
      ).toHaveBeenCalledWith(expect.objectContaining({
        backendIdForSessionRuntime: agentId,
        runtimeAuthorityAgentId: agentId,
        agentIdForAccountSettings: agentId,
      }));
    }
  });

  it('keeps Kilo preflight behavior out of the cold static catalog while projecting Copilot auth', async () => {
    const contributes = resolveBuiltInContributions();
    const kiloAgent = contributes.agents.find((entry) => entry.id === 'kilo');
    const copilotAgent = contributes.agents.find((entry) => entry.id === 'copilot');

    expect(kiloAgent?.catalogEntry?.getPreflightSessionControlsProbeAdapter).toBeUndefined();

    const copilotAuthSpec = await copilotAgent?.catalogEntry?.getCliAuthSpec?.();
    expect(copilotAuthSpec?.detectAuthStatus).toBeTypeOf('function');
  });

  it('leaves selected-account preflight materialization to the activation-time host projection', () => {
    const contributes = resolveBuiltInContributions();
    const preflightGetters = ['codex', 'opencode', 'pi'].map((agentId) => {
      const agent = contributes.agents.find((entry) => entry.id === agentId);
      return agent?.catalogEntry?.getPreflightSessionControlsProbeAdapter;
    });

    expect(preflightGetters).toEqual([undefined, undefined, undefined]);
  });

  it('projects Pi through bundled plugin metadata without ACP or MCP ownership', () => {
    const contributes = resolveBuiltInContributions();
    const piAgent = contributes.agents.find((agent) => agent.id === 'pi');
    const piActivationTarget = contributes.activationTargets?.find((target) => target.pluginId === 'happier.agent.pi');

    expect(piAgent).toMatchObject({
      id: 'pi',
      provenance: 'first_party',
      pluginId: 'happier.agent.pi',
      manifestPath: 'bundled:happier.agent.pi',
      daemonEntryPath: '@happier-dev/plugins-pi',
      sourceSpec: {
        kind: 'bundled',
        locator: '@happier-dev/plugins-pi',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      definition: {
        ownedBackendIds: ['pi'],
      },
      runtimeSpec: {
        id: 'pi',
        title: 'Pi Coding Agent CLI',
        binaryName: 'pi',
        sourcePreferenceDefault: 'system-first',
        managedInstall: {
          kind: 'managed_package',
          packageName: '@earendil-works/pi-coding-agent',
          binaryName: 'pi',
        },
        manualInstallKind: 'command',
      },
    });
    expect(piAgent).not.toHaveProperty('getRuntimeCore');
    expect(piAgent).not.toHaveProperty('acpDefinition');
    expect(piAgent).not.toHaveProperty('mcpDefinition');
    expect(piAgent?.catalogEntry?.getPreflightSessionControlsProbeAdapter).toBeTypeOf('function');
    expect(piActivationTarget).toMatchObject({
      pluginId: 'happier.agent.pi',
      manifestPath: 'bundled:happier.agent.pi',
      daemonEntryPath: '@happier-dev/plugins-pi',
      sourceSpec: {
        kind: 'bundled',
        locator: '@happier-dev/plugins-pi',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
    });
  });

  it('projects canonical runtime facts onto built-in Agent contributions', () => {
    const contributes = resolveBuiltInContributions();
    const codexAgent = contributes.agents.find((agent) => agent.id === 'codex');
    const piAgent = contributes.agents.find((agent) => agent.id === 'pi');

    expect(codexAgent?.richDefinition).toMatchObject({
      provenance: 'first_party',
      definition: { id: 'codex', runtime: { kind: 'custom' } },
    });
    expect(piAgent?.richDefinition).toMatchObject({
      provenance: 'first_party',
      definition: { id: 'pi', runtime: { kind: 'custom' } },
    });
  });

  it('projects OhMyPi through its manifest-local identity and canonical Agent owner', () => {
    const contributes = resolveBuiltInContributions();
    const ohMyPiAgent = contributes.agents.find((agent) => agent.id === 'ohMyPi');
    const ohMyPiActivationTarget = contributes.activationTargets?.find(
      (target) => target.pluginId === 'happier.agent.ohmypi',
    );

    expect(ohMyPiAgent).toMatchObject({
      id: 'ohMyPi',
      provenance: 'first_party',
      pluginId: 'happier.agent.ohmypi',
      manifestPath: 'bundled:happier.agent.ohmypi',
      daemonEntryPath: '@happier-dev/plugins-ohmypi',
      sourceSpec: {
        kind: 'bundled',
        locator: '@happier-dev/plugins-ohmypi',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      definition: {
        ownedBackendIds: ['ohMyPi'],
      },
      runtimeSpec: {
        id: 'ohMyPi',
        title: 'oh-my-pi CLI',
        binaryName: 'omp',
        sourcePreferenceDefault: 'system-first',
        managedInstall: {
          kind: 'github_release_binary',
          githubRepo: 'can1357/oh-my-pi',
          binaryName: 'omp',
        },
        manualInstallKind: 'vendor_recipe',
      },
    });
    expect(ohMyPiActivationTarget).toMatchObject({
      pluginId: 'happier.agent.ohmypi',
      manifestPath: 'bundled:happier.agent.ohmypi',
      daemonEntryPath: '@happier-dev/plugins-ohmypi',
      sourceSpec: {
        kind: 'bundled',
        locator: '@happier-dev/plugins-ohmypi',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
    });
  });

  it('projects every bundled Agent CLI detect and auth spec from its declared manifest CLI metadata', async () => {
    const resolved = resolveBuiltInContributions();
    const projected: Record<string, Readonly<{ loginStatusArgs: readonly string[] | null; binaryNames: readonly string[]; hasProbe: boolean }> | null> = {};
    for (const agent of resolved.agents) {
      const entry = agent.catalogEntry;
      if (!entry?.getCliDetect || !entry.getCliAuthSpec) {
        projected[agent.id] = null;
        continue;
      }
      const detect = await entry.getCliDetect();
      const authSpec = await entry.getCliAuthSpec();
      projected[agent.id] = {
        loginStatusArgs: detect.loginStatusArgs ?? null,
        binaryNames: authSpec.binaryNames,
        hasProbe: typeof authSpec.detectAuthStatus === 'function',
      };
    }

    // Every Session Agent — bundled or installed — reaches the same declared-CLI
    // projection. `coderabbit`/`deepsec` are execution-run Agents with no Session
    // CLI surface, so they carry no CLI detect/auth hooks at all.
    expect(projected).toEqual({
      antigravity: { loginStatusArgs: null, binaryNames: ['agy'], hasProbe: false },
      auggie: { loginStatusArgs: null, binaryNames: ['auggie'], hasProbe: true },
      claude: { loginStatusArgs: null, binaryNames: ['claude'], hasProbe: true },
      codex: { loginStatusArgs: ['login', 'status'], binaryNames: ['codex'], hasProbe: true },
      coderabbit: null,
      copilot: { loginStatusArgs: null, binaryNames: ['copilot'], hasProbe: true },
      cursor: {
        loginStatusArgs: ['about', '--format', 'json'],
        binaryNames: ['cursor-agent', 'agent'],
        hasProbe: true,
      },
      deepsec: null,
      gemini: { loginStatusArgs: null, binaryNames: ['gemini'], hasProbe: true },
      grok: { loginStatusArgs: null, binaryNames: ['grok'], hasProbe: true },
      kilo: { loginStatusArgs: null, binaryNames: ['kilo'], hasProbe: true },
      kimi: { loginStatusArgs: null, binaryNames: ['kimi'], hasProbe: true },
      kiro: {
        loginStatusArgs: ['whoami', '--format', 'json'],
        binaryNames: ['kiro-cli'],
        hasProbe: true,
      },
      ohMyPi: { loginStatusArgs: null, binaryNames: ['omp'], hasProbe: true },
      opencode: { loginStatusArgs: ['auth', 'list'], binaryNames: ['opencode'], hasProbe: true },
      pi: { loginStatusArgs: null, binaryNames: ['pi'], hasProbe: true },
      qwen: { loginStatusArgs: null, binaryNames: ['qwen'], hasProbe: true },
    });
  });
});
