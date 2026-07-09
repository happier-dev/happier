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
  AGENT_PROVIDER_IDS,
  AGENT_IDS,
  getAllBackendDefinitionContracts,
  getAllProviderDefinitionContracts,
  getAgentCliRuntimeSpec,
} from '@happier-dev/agents';
import { BackendSurfaceOperationCatalogV1, buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { resolveBuiltInContributions } from './resolveBuiltInContributions';
import * as generatedBundledPlugins from './sources/generatedBundledPlugins';

function readResolverSource(): string {
  return readFileSync(new URL('./resolveBuiltInContributions.ts', import.meta.url), 'utf8');
}

function readGeneratedArray(name: string): readonly unknown[] {
  const value = (generatedBundledPlugins as Record<string, unknown>)[name];
  expect(Array.isArray(value)).toBe(true);
  return value as readonly unknown[];
}

function readGeneratedSourceSpecKinds(name: string): readonly unknown[] {
  const entries = readGeneratedArray(name);
  expect(entries.length).toBeGreaterThan(0);
  return entries.map((entry) => (entry as { sourceSpec?: { kind?: unknown } }).sourceSpec?.kind);
}

describe('resolveBuiltInContributions', () => {
  it('stays a thin reader without host backend or executable plugin imports', () => {
    const resolverSource = readResolverSource();

    expect(resolverSource).toMatch(/generatedBundledPlugins/);
    expect(resolverSource).toMatch(/BUNDLED_FIRST_PARTY_AGENT_CATALOG_ENTRY_HOOKS/);
    expect(resolverSource).not.toMatch(/@\/backends\//);
    expect(resolverSource).not.toMatch(/\.\/bundled\/catalogEntries/);
    expect(resolverSource).not.toMatch(/\bBUILT_IN_AGENT_CATALOG_ENTRIES\b/);
    expect(resolverSource).not.toMatch(/\bOPENCODE_BUNDLED_ACTIVATION_TARGET\b/);
    expect(resolverSource).not.toMatch(/from ['"][^'"]*@happier-dev\/plugins-/);
    expect(resolverSource).not.toMatch(/require\(['"]@happier-dev\/plugins-/);
    expect(resolverSource).not.toMatch(/@happier-dev\/extensions-/);
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

    it('assembles built-in providers and backends into separate contribution tables', async () => {
        const contributes = resolveBuiltInContributions();
    const backendDefinitionIds = getAllBackendDefinitionContracts().map((entry) => entry.id).slice().sort();
    const providerDefinitionIds = getAllProviderDefinitionContracts().map((entry) => entry.id).slice().sort();
    const generatedProviderIds = readGeneratedArray('BUNDLED_FIRST_PARTY_AGENT_CONTRIBUTIONS')
      .map((entry) => (entry as { id?: unknown }).id)
      .slice()
      .sort();
    const generatedBackendIds = readGeneratedArray('BUNDLED_FIRST_PARTY_AGENT_RUNTIME_CONTRIBUTIONS')
      .map((entry) => (entry as { id?: unknown }).id)
      .slice()
      .sort();
    const generatedPluginBackendIds = readGeneratedArray('BUNDLED_FIRST_PARTY_PLUGIN_AGENT_RUNTIME_CONTRIBUTIONS')
      .map((entry) => (entry as { id?: unknown }).id)
      .slice()
      .sort();
    const expectedBackendIds = [...backendDefinitionIds, ...generatedPluginBackendIds].slice().sort();

    expect(contributes.agents.map((entry) => entry.id).slice().sort()).toEqual(providerDefinitionIds);
    expect(contributes.agentRuntimes.map((entry) => entry.id).slice().sort()).toEqual(expectedBackendIds);
    expect(contributes.agents.map((entry) => entry.id).slice().sort()).toEqual(generatedProviderIds);
    expect(generatedBackendIds).toEqual(backendDefinitionIds);
    expect((contributes.catalogEntries ?? []).map((entry) => entry.id)).toEqual([]);
    expect(contributes.agents.map((entry) => entry.id).slice().sort()).toEqual([...AGENT_PROVIDER_IDS].slice().sort());
    expect(contributes.agents.map((entry) => entry.id).slice().sort()).toEqual([...AGENT_IDS].slice().sort());
    expect(contributes.agentRuntimes.find((entry) => entry.id === 'antigravity')?.runtimeOwner).toEqual({
      selectedOwner: 'plugin_engine',
      acceptedBy: '2026-06-19-antigravity-runtime-unification',
    });

    for (const provider of contributes.agents) {
      expect(provider.definition).toEqual(
        expect.objectContaining({
          kindVersion: 1,
          id: provider.id,
        }),
      );
      expect(provider.catalogEntry?.id).toBe(provider.id);
      expect(provider.catalogEntry?.cliSubcommand).toBe(provider.id);
      expect(provider.catalogEntry).not.toHaveProperty('getRuntimeCore');
    }

    const opencodeProvider = contributes.agents.find((provider) => provider.id === 'opencode');
    expect(opencodeProvider?.catalogEntry?.getManagedServerShutdownCleanup).toBeTypeOf('function');
    expect(opencodeProvider?.catalogEntry?.getProviderAttachOps).toBeTypeOf('function');
    expect(opencodeProvider?.catalogEntry?.resolveSessionRuntimePreferences).toBeTypeOf('function');
    expect(opencodeProvider?.catalogEntry?.getSessionHandoffProviderBundleRecordExtractor).toBeTypeOf('function');
    const opencodeRecordExtractor = await opencodeProvider?.catalogEntry?.getSessionHandoffProviderBundleRecordExtractor?.();
    expect(opencodeRecordExtractor?.({
      providerId: 'opencode',
      remoteSessionId: 'oc-session-1',
      exportJsonBase64: Buffer.from(JSON.stringify({ id: 'oc-session-1' }), 'utf8').toString('base64'),
    })).toEqual([{ id: 'oc-session-1' }]);

    const claudeProvider = contributes.agents.find((provider) => provider.id === 'claude');
    expect(claudeProvider?.catalogEntry?.getConnectedServicesMaterializer).toBeTypeOf('function');
    expect(claudeProvider?.catalogEntry?.getConnectedServiceStateSharingDescriptor).toBeTypeOf('function');
    expect(claudeProvider?.catalogEntry?.getConnectedServiceRuntimeAuthAdapter).toBeTypeOf('function');
    expect(claudeProvider?.catalogEntry?.resolveConnectedServiceSwitchContinuity).toBeTypeOf('function');

    const qwenProvider = contributes.agents.find((provider) => provider.id === 'qwen');
    expect(qwenProvider?.catalogEntry?.getCliCommandHandler).toBeTypeOf('function');

    const kimiProvider = contributes.agents.find((provider) => provider.id === 'kimi');
    const resolveKimiSessionPreferences = kimiProvider?.catalogEntry?.resolveSessionRuntimePreferences;
    expect(resolveKimiSessionPreferences).toBeTypeOf('function');
    expect(await resolveKimiSessionPreferences?.({
      settings: { kimiAcpPythonSelector: 'poll' },
      processEnv: {},
      startedBy: 'terminal',
    })).toEqual({ environmentVariables: { HAPPIER_KIMI_ACP_SELECTOR: 'poll' } });
    expect(await resolveKimiSessionPreferences?.({
      settings: { kimiAcpPythonSelector: 'poll' },
      processEnv: { HAPPIER_KIMI_ACP_SELECTOR: 'auto' },
      startedBy: 'terminal',
    })).toEqual({ environmentVariables: { HAPPIER_KIMI_ACP_SELECTOR: 'auto' } });

    for (const backend of contributes.agentRuntimes) {
      expect(backend.definition).toEqual(
        expect.objectContaining({
          kindVersion: 1,
          id: backend.id,
          agentId: backend.agentId,
        }),
      );
      expect(backend).not.toHaveProperty('getRuntimeCore');
    }

    expect(contributes.activationTargets).toEqual(readGeneratedArray('BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS'));
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

        expect(activationEventsByPluginId.get('happier.agent.codex')).toEqual(['onAgent:codex']);
        expect(activationEventsByPluginId.get('happier.scm.hosting.github')).toEqual(['onScmProvider:scm.github']);
        expect(activationEventsByPluginId.get('happier.scm.backend.git')).toEqual(['onScmProvider:git']);
        expect(activationEventsByPluginId.get('happier.review.coderabbit')).toEqual(['onReviewProvider:coderabbit']);
    });

    it('projects Codex connected-service runtime control hooks from the plugin contribution', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-runtime-contribution-'));
        try {
            const contributes = resolveBuiltInContributions();
            const codexProvider = contributes.agents.find((provider) => provider.id === 'codex');
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

            expect(codexProvider?.catalogEntry?.getConnectedServicesMaterializer).toBeTypeOf('function');
            expect(codexProvider?.catalogEntry?.getConnectedServiceStateSharingDescriptor).toBeTypeOf('function');
            expect(codexProvider?.catalogEntry?.getConnectedServiceRuntimeAuthAdapter).toBeTypeOf('function');
            expect(codexProvider?.catalogEntry?.materializeConnectedServiceRuntimeAuthSelection).toBeTypeOf('function');
            expect(codexProvider?.catalogEntry?.resolveConnectedServiceSwitchContinuity).toBeTypeOf('function');
            expect(codexProvider?.catalogEntry?.verifyResumeReachable).toBeTypeOf('function');
            expect(codexProvider?.catalogEntry?.resolveConnectedServiceCandidatePersistedSessionFile).toBeTypeOf('function');
            expect(codexProvider?.catalogEntry?.getSessionGoalControlAdapter).toBeTypeOf('function');
            expect(codexProvider?.catalogEntry?.getSessionCatalogControlAdapter).toBeTypeOf('function');
            expect(codexProvider?.catalogEntry?.getSessionUsageLimitRecoveryControlAdapter).toBeTypeOf('function');
            expect(codexProvider?.catalogEntry?.getVendorResumeSupport).toBeTypeOf('function');
            const codexVendorResumeSupport = await codexProvider?.catalogEntry?.getVendorResumeSupport?.();
            expect(codexVendorResumeSupport?.({ codexBackendMode: 'appServer' })).toBe(true);
    const supportsRawCodexVendorResumeInput = codexVendorResumeSupport as
        | ((params: Readonly<{ codexBackendMode?: unknown }>) => boolean)
        | undefined;
    expect(supportsRawCodexVendorResumeInput?.({ codexBackendMode: 'unknown' })).toBe(false);
    expect(codexProvider?.catalogEntry?.checklists?.['resume.codex']).toEqual([
        { id: 'cli.codex', params: { includeLoginStatus: true } },
    ]);

    const materializer = await codexProvider?.catalogEntry?.getConnectedServicesMaterializer?.();
            const oauthResult = await materializer?.({
                materializationKey: 'mat-1',
                activeServerDir: root,
                baseDir: root,
                rootDir: root,
                recordsByServiceId: new Map([['openai-codex', codexOauthRecord]]),
                processEnv: { HOME: join(root, 'home') },
            });
            expect(oauthResult?.env).toEqual({ CODEX_HOME: expect.stringContaining('codex-home') });
            await expect(readFile(join(String(oauthResult?.env.CODEX_HOME), 'auth.json'), 'utf8')).resolves.toContain('access-token');

            const tokenResult = await materializer?.({
                materializationKey: 'mat-2',
                activeServerDir: root,
                baseDir: root,
                rootDir: root,
                recordsByServiceId: new Map([['openai', openAiTokenRecord]]),
                processEnv: { HOME: join(root, 'home') },
            });
            expect(tokenResult?.env).toEqual({ OPENAI_API_KEY: 'sk-test' });
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
                    '  setTimeout(() => process.exit(0), 1600);',
                    '  return;',
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
            const codexProvider = contributes.agents.find((provider) => provider.id === 'codex');
            const spec = await codexProvider?.catalogEntry?.getCliAuthSpec?.();

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
        const codexProvider = contributes.agents.find((provider) => provider.id === 'codex');
        const hostRuntimeSpec = getAgentCliRuntimeSpec('codex');

        expect(codexProvider?.runtimeSpec).toEqual(expect.objectContaining({
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
        expect(codexProvider?.runtimeSpec).toEqual(hostRuntimeSpec);
    });

    it('projects OpenCode plugin-owned backend surface declarations onto the bundled backend contribution', () => {
        const contributes = resolveBuiltInContributions();
        const opencodeProvider = contributes.agents.find((provider) => provider.id === 'opencode');
        const opencodeBackend = contributes.agentRuntimes.find((backend) => backend.id === 'opencode');
        const operations = (opencodeBackend?.surfaceHandlers ?? [])
          .map((handler) => [handler.kind, handler.operation])
          .sort();
        const catalog = BackendSurfaceOperationCatalogV1;

        expect(operations).toEqual(expect.arrayContaining([
          ['externalSession', catalog.externalSession.resolveLinkIdentity],
          ['externalSession', catalog.externalSession.resolveLinkedIdentity],
          ['externalSession', catalog.externalSession.resolveSource],
          ['externalSession', catalog.externalSession.listCandidates],
          ['externalSession', catalog.externalSession.resolveTakeoverLaunch],
          ['handoff', catalog.handoff.exportBundle],
          ['handoff', catalog.handoff.importBundle],
          ['fork', catalog.fork.resolveReplayChildLaunch],
        ]));
        expect(opencodeProvider?.runtimeSpec).toMatchObject({
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

    it('projects bundled SCM hosting providers from generated built-in plugin metadata', () => {
        const contributes = resolveBuiltInContributions();

        expect((contributes.scmHostingProviders ?? []).map((provider) => [
            provider.id,
            provider.pluginId,
            provider.definition.kind,
            provider.definition.baseUrl,
        ]).sort()).toEqual([
            ['scm.azure-devops', 'happier.scm.hosting.azure-devops', 'azure-devops', 'https://dev.azure.com'],
            ['scm.bitbucket', 'happier.scm.hosting.bitbucket', 'bitbucket', 'https://bitbucket.org'],
            ['scm.github', 'happier.scm.hosting.github', 'github', 'https://github.com'],
            ['scm.gitlab', 'happier.scm.hosting.gitlab', 'gitlab', 'https://gitlab.com'],
        ]);
    });

    it('projects bundled SCM backend and managed dependency contributions from generated metadata', () => {
        const contributes = resolveBuiltInContributions();
        const generatedScmBackends = readGeneratedArray('BUNDLED_FIRST_PARTY_SCM_BACKEND_CONTRIBUTIONS');
        const generatedInstallables = readGeneratedArray('BUNDLED_FIRST_PARTY_INSTALLABLE_CONTRIBUTIONS');

        expect(contributes.scmBackends).toEqual(generatedScmBackends);
        expect(contributes.managedDependencies).toEqual(expect.arrayContaining(Array.from(generatedInstallables)));
        expect((contributes.scmBackends ?? []).map((backend) => [
            backend.id,
            backend.pluginId,
            backend.definition.installableDependencies,
        ])).toEqual(expect.arrayContaining([
            [
                'git',
                'happier.scm.backend.git',
                ['dep.git'],
            ],
            [
                'sapling',
                'happier.scm.backend.sapling',
                ['dep.sapling'],
            ],
        ]));
        const gitBackend = contributes.scmBackends?.find((backend) => backend.id === 'git');
        expect(gitBackend?.definition.capabilities.hosting).toEqual(expect.objectContaining({
            pullRequestCheckout: { support: 'supported' },
            pullRequestPrepareWorktree: { support: 'supported' },
            pullRequestRunStacked: { support: 'supported' },
        }));
        expect((contributes.managedDependencies ?? []).map((installable) => [
            installable.pluginId,
            installable.definition.key,
            installable.definition.capabilityId,
            installable.definition.defaultPolicy.autoInstallWhenNeeded,
        ])).toEqual(expect.arrayContaining([
            [
                'happier.scm.backend.git',
                'dep.git',
                'dep.git',
                false,
            ],
            [
                'happier.scm.backend.sapling',
                'dep.sapling',
                'dep.sapling',
                false,
            ],
        ]));
    });

    it('publishes a runtime kind for every built-in backend contribution', () => {
        const contributes = resolveBuiltInContributions();
        const generatedPluginRuntimeKinds = readGeneratedArray('BUNDLED_FIRST_PARTY_PLUGIN_AGENT_RUNTIME_CONTRIBUTIONS')
          .map((backend) => [
            (backend as { id?: unknown }).id,
            (backend as { runtimeKind?: unknown }).runtimeKind,
          ]);

    expect(contributes.agentRuntimes.map((backend) => [backend.id, backend.runtimeKind]).sort()).toEqual([
      ['auggie', 'native'],
      ['claude', 'native'],
      ['coderabbit', 'native'],
      ['codex', 'appServer'],
      ['copilot', 'native'],
      ['cursor', 'native'],
      ['deepsec', 'native'],
      ['gemini', 'native'],
      ['kilo', 'native'],
      ['kimi', 'native'],
      ['kiro', 'native'],
      ['ohMyPi', 'native'],
      ['opencode', 'server'],
      ['pi', 'native'],
      ['qwen', 'native'],
      ...generatedPluginRuntimeKinds,
    ].sort());
  });

  it('does not project host-local runtimeCore hooks from static built-in backend contributions', () => {
    const contributes = resolveBuiltInContributions();

    for (const backend of contributes.agentRuntimes) {
      expect(backend).not.toHaveProperty('getRuntimeCore');
    }
  });

  it('projects bundled first-party source specs with protocol-visible bundled provenance', () => {
    const contributes = resolveBuiltInContributions();
    const qwenProvider = contributes.agents.find((provider) => provider.id === 'qwen');
    const qwenBackend = contributes.agentRuntimes.find((backend) => backend.id === 'qwen');
    const qwenActivationTarget = contributes.activationTargets?.find((target) => target.pluginId === 'happier.agent.qwen');

    expect(qwenProvider?.sourceSpec?.kind).toBe('bundled');
    expect(qwenBackend?.sourceSpec?.kind).toBe('bundled');
    expect(qwenActivationTarget?.sourceSpec?.kind).toBe('bundled');
  });

  it('emits bundled source specs for every generated first-party contribution family', () => {
    const contributionFamilies = [
      'BUNDLED_FIRST_PARTY_AGENT_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_INSTALLABLE_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_SCM_BACKEND_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_CONNECTED_ACCOUNT_DESCRIPTOR_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_AGENT_RUNTIME_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_PLUGIN_AGENT_RUNTIME_CONTRIBUTIONS',
      'BUNDLED_FIRST_PARTY_EXECUTION_RUN_PROFILE_CONTRIBUTIONS',
    ];

    for (const family of contributionFamilies) {
      const kinds = readGeneratedSourceSpecKinds(family);
      expect(kinds).toEqual(kinds.map(() => 'bundled'));
    }
  });

  it('projects Qwen through bundled plugin metadata and routes its command through the common backend session launcher', async () => {
    runBackendSessionCliCommandMock.mockClear();
    const contributes = resolveBuiltInContributions();
    const qwenProvider = contributes.agents.find((provider) => provider.id === 'qwen');
    const qwenBackend = contributes.agentRuntimes.find((backend) => backend.id === 'qwen');
    const qwenActivationTarget = contributes.activationTargets?.find((target) => target.pluginId === 'happier.agent.qwen');
    const handler = await qwenProvider?.catalogEntry?.getCliCommandHandler?.();

    expect(qwenProvider).toMatchObject({
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
    expect(qwenBackend).toMatchObject({
      id: 'qwen',
      agentId: 'qwen',
      provenance: 'first_party',
      pluginId: 'happier.agent.qwen',
      manifestPath: 'bundled:happier.agent.qwen',
      daemonEntryPath: '@happier-dev/plugins-qwen',
      runtimeKind: 'native',
      sourceSpec: {
        kind: 'bundled',
        locator: '@happier-dev/plugins-qwen',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
    });
    expect(qwenBackend).not.toHaveProperty('getRuntimeCore');
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
    const kiroProvider = contributes.agents.find((provider) => provider.id === 'kiro');
    const kiroBackend = contributes.agentRuntimes.find((backend) => backend.id === 'kiro');
    const kiroActivationTarget = contributes.activationTargets?.find((target) => target.pluginId === 'happier.agent.kiro');
    const handler = await kiroProvider?.catalogEntry?.getCliCommandHandler?.();
    const authSpec = await kiroProvider?.catalogEntry?.getCliAuthSpec?.();

    expect(kiroProvider).toMatchObject({
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
    expect(kiroBackend).toMatchObject({
      id: 'kiro',
      agentId: 'kiro',
      provenance: 'first_party',
      pluginId: 'happier.agent.kiro',
      manifestPath: 'bundled:happier.agent.kiro',
      daemonEntryPath: '@happier-dev/plugins-kiro',
      runtimeKind: 'native',
      sourceSpec: {
        kind: 'bundled',
        locator: '@happier-dev/plugins-kiro',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
    });
    expect(kiroBackend).not.toHaveProperty('getRuntimeCore');
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
    const codexProvider = contributes.agents.find((provider) => provider.id === 'codex');
    const handler = await codexProvider?.catalogEntry?.getCliCommandHandler?.();

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
      resolveExtraOptions: expect.any(Function),
    }));
    const call = runBackendSessionCliCommandMock.mock.calls.at(-1)?.[0] as {
      resolveExtraOptions?: (args: string[], parsed: {
        startingMode?: string;
        directory?: string;
        providerArgs: string[];
      }) => unknown;
    } | undefined;
    expect(call?.resolveExtraOptions?.([], {
      startingMode: 'remote',
      directory: '/workspace',
      providerArgs: ['exec', '--model', 'gpt-5.1-codex-max'],
    })).toEqual({
      startingMode: 'remote',
      directory: '/workspace',
      codexArgs: ['exec', '--model', 'gpt-5.1-codex-max'],
    });
  });

  it('projects Claude CLI session command descriptors from the plugin runtime contribution', async () => {
    runBackendSessionCliCommandMock.mockClear();
    const contributes = resolveBuiltInContributions();
    const claudeProvider = contributes.agents.find((provider) => provider.id === 'claude');
    const handler = await claudeProvider?.catalogEntry?.getCliCommandHandler?.();

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
      resolveExtraOptions: expect.any(Function),
    }));
    const call = runBackendSessionCliCommandMock.mock.calls.at(-1)?.[0] as {
      resolveExtraOptions?: (args: string[], parsed: {
        startingMode?: string;
        directory?: string;
        resume?: string;
        providerArgs: string[];
      }) => unknown;
    } | undefined;
    expect(call?.resolveExtraOptions?.(['claude', '--js-runtime', 'bun', '--resume', 'vendor-session-1'], {
      startingMode: 'terminal',
      directory: '/workspace',
      resume: 'vendor-session-1',
      providerArgs: ['--model', 'claude-opus-4-6', '--js-runtime', 'bun'],
    })).toEqual({
      startingMode: 'terminal',
      directory: '/workspace',
      jsRuntime: 'bun',
      resume: undefined,
      claudeArgs: ['--model', 'claude-opus-4-6', '--resume', 'vendor-session-1'],
    });
  });

  it('projects OpenCode provider-native info command prefixes from the plugin runtime contribution', async () => {
    runBackendSessionCliCommandMock.mockClear();
    const contributes = resolveBuiltInContributions();
    const opencodeProvider = contributes.agents.find((provider) => provider.id === 'opencode');
    const handler = await opencodeProvider?.catalogEntry?.getCliCommandHandler?.();

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

  it('projects Antigravity provider-native model info command prefix from the plugin runtime contribution', async () => {
    runBackendSessionCliCommandMock.mockClear();
    const contributes = resolveBuiltInContributions();
    const antigravityProvider = contributes.agents.find((provider) => provider.id === 'antigravity');
    const handler = await antigravityProvider?.catalogEntry?.getCliCommandHandler?.();

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
    const provider = contributes.agents.find((entry) => entry.id === agentId);
    const backend = contributes.agentRuntimes.find((entry) => entry.id === agentId);
    const activationTarget = contributes.activationTargets?.find((target) => target.pluginId === pluginId);
    const handler = await provider?.catalogEntry?.getCliCommandHandler?.();

    expect(provider).toMatchObject({
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
    expect(backend).toMatchObject({
      id: agentId,
      agentId: agentId,
      provenance: 'first_party',
      pluginId,
      manifestPath: `bundled:${pluginId}`,
      daemonEntryPath: packageName,
      runtimeKind: 'native',
    });
    expect(backend).not.toHaveProperty('getRuntimeCore');
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
      agentIdForAccountSettings: agentId,
    }));
  });

  it('projects Kilo preflight and Copilot auth hooks from plugin runtime contributions', async () => {
    const contributes = resolveBuiltInContributions();
    const kiloProvider = contributes.agents.find((entry) => entry.id === 'kilo');
    const copilotProvider = contributes.agents.find((entry) => entry.id === 'copilot');

    await expect(kiloProvider?.catalogEntry?.getPreflightSessionControlsProbeAdapter?.()).resolves.toMatchObject({
      failureCacheStrategy: 'cooldown',
      cliModelsCommandArgs: ['models'],
    });

    const copilotAuthSpec = await copilotProvider?.catalogEntry?.getCliAuthSpec?.();
    expect(copilotAuthSpec?.detectAuthStatus).toBeTypeOf('function');
  });

  it('projects Pi through bundled plugin metadata without ACP or MCP ownership', () => {
    const contributes = resolveBuiltInContributions();
    const piProvider = contributes.agents.find((provider) => provider.id === 'pi');
    const piBackend = contributes.agentRuntimes.find((backend) => backend.id === 'pi');
    const piActivationTarget = contributes.activationTargets?.find((target) => target.pluginId === 'happier.agent.pi');

    expect(piProvider).toMatchObject({
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
    expect(piBackend).toMatchObject({
      id: 'pi',
      agentId: 'pi',
      provenance: 'first_party',
      pluginId: 'happier.agent.pi',
      manifestPath: 'bundled:happier.agent.pi',
      daemonEntryPath: '@happier-dev/plugins-pi',
      runtimeKind: 'native',
      sourceSpec: {
        kind: 'bundled',
        locator: '@happier-dev/plugins-pi',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
    });
    expect(piBackend).not.toHaveProperty('getRuntimeCore');
    expect(piBackend).not.toHaveProperty('acpDefinition');
    expect(piBackend).not.toHaveProperty('mcpDefinition');
    expect(piProvider?.catalogEntry?.getPreflightSessionControlsProbeAdapter).toBeTypeOf('function');
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

  it('projects structured output recovery facts onto built-in backend contributions', () => {
    const contributes = resolveBuiltInContributions();
    const codexBackend = contributes.agentRuntimes.find((backend) => backend.id === 'codex');
    const piBackend = contributes.agentRuntimes.find((backend) => backend.id === 'pi');

    expect(codexBackend?.capabilities?.executionRun?.structuredOutputRecovery).toEqual({
      delegate: 'loose-deliverables-with-single-fallback',
    });
    expect(piBackend?.capabilities?.executionRun?.structuredOutputRecovery).toEqual({
      plan: 'loose-sections',
      delegate: 'loose-deliverables',
    });
  });

  it('projects OhMyPi file-follow consumer surfaces through bundled plugin metadata', () => {
    const contributes = resolveBuiltInContributions();
    const ohMyPiProvider = contributes.agents.find((provider) => provider.id === 'ohMyPi');
    const ohMyPiBackend = contributes.agentRuntimes.find((backend) => backend.id === 'ohMyPi');
    const ohMyPiActivationTarget = contributes.activationTargets?.find(
      (target) => target.pluginId === 'happier.agent.ohmypi',
    );

    expect(ohMyPiProvider).toMatchObject({
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
    expect(ohMyPiBackend).toMatchObject({
      id: 'ohMyPi',
      agentId: 'ohMyPi',
      provenance: 'first_party',
      pluginId: 'happier.agent.ohmypi',
      manifestPath: 'bundled:happier.agent.ohmypi',
      daemonEntryPath: '@happier-dev/plugins-ohmypi',
      runtimeKind: 'native',
      sourceSpec: {
        kind: 'bundled',
        locator: '@happier-dev/plugins-ohmypi',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
    });
    expect((ohMyPiBackend?.surfaceHandlers ?? []).map((handler) => [
      handler.kind,
      handler.operation,
      handler.handler.exportName,
    ])).toEqual([
      ['terminalRuntime', 'resolveTranscriptBinding', 'resolveOhMyPiTerminalRuntimeTranscriptBinding'],
      ['externalSession', 'resolveSource', 'resolveOhMyPiExternalSessionSource'],
      ['externalSession', 'listCandidates', 'listOhMyPiExternalSessionCandidates'],
      ['externalSession', 'getActivity', 'getOhMyPiExternalSessionActivity'],
      ['externalSession', 'pageTranscript', 'pageOhMyPiExternalSessionTranscript'],
      ['externalSession', 'readAfterTranscript', 'readOhMyPiExternalSessionAfterTranscript'],
      ['externalSession', 'resolveFollowTranscriptPath', 'resolveOhMyPiExternalSessionFollowTranscriptPath'],
      ['externalSession', 'acquireFollowLease', 'acquireOhMyPiExternalSessionFollowLease'],
      ['externalSession', 'resolveLinkIdentity', 'resolveOhMyPiExternalSessionLinkIdentity'],
      ['externalSession', 'resolveLinkedIdentity', 'resolveLinkedOhMyPiExternalSessionIdentity'],
      ['externalSession', 'resolveTakeoverLaunch', 'resolveOhMyPiExternalSessionTakeoverLaunch'],
    ]);
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
});
