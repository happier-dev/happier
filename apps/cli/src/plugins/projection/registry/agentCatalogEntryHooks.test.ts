import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountSettingsParse, buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import type {
    AgentCliSessionCommandDeclarationV1,
    AgentPreflightSessionControlsContributionV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { CLAUDE_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-claude/agent/contributions/runtime';
import { PLUGIN_MANIFEST as CLAUDE_PLUGIN_MANIFEST } from '@happier-dev/plugins-claude/manifest';
import { CODEX_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-codex/agent/contributions/runtime';
import { PLUGIN_MANIFEST as CODEX_PLUGIN_MANIFEST } from '@happier-dev/plugins-codex/manifest';
import { GEMINI_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-gemini/agent/contributions/runtime';
import { OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-ohmypi/agent/contributions/runtime';
import { OPENCODE_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-opencode/agent/contributions/runtime';
import { PLUGIN_MANIFEST as OPENCODE_PLUGIN_MANIFEST } from '@happier-dev/plugins-opencode/manifest';
import { PI_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-pi/agent/contributions/runtime';
import { PLUGIN_MANIFEST as PI_PLUGIN_MANIFEST } from '@happier-dev/plugins-pi/manifest';

import type { ApiClient } from '@/api/api';
import type { TrackedSession } from '@/daemon/types';
import {
    resolveConnectedServiceGroupHomeDir,
    resolveConnectedServiceHomeDir,
} from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import type { Credentials } from '@/persistence';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import {
    createCliSessionCommandHandler,
    createAgentRuntimeCatalogEntryHooks,
    projectAgentCliAuthCatalogEntry,
    projectAgentCliSessionCommandCatalogEntry,
    projectAgentConnectedAccountLaunchCatalogEntry,
    projectAgentExperimentalVendorResumeSupportCatalogEntry,
    projectAgentPreflightSessionControlsCatalogEntry,
    projectAgentSessionStartupCatalogEntry,
} from './agentCatalogEntryHooks';

const runBackendSessionCliCommandMock = vi.hoisted(() =>
    vi.fn(async (_params: unknown) => undefined),
);
vi.mock('@/cli/runBackendSessionCliCommand', () => ({
    runBackendSessionCliCommand: runBackendSessionCliCommandMock,
}));

const LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY = {
    kind: 'legacy_unfenced_one_shot',
} as const;

describe('createAgentRuntimeCatalogEntryHooks', () => {
    beforeEach(() => {
        runBackendSessionCliCommandMock.mockClear();
    });

    it('does not retain a private Runtime Activity applicability override', () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-test',
            contribution: { runtimeActivityApplicability: 'supported' } as never,
        })();

        expect(hooks).not.toHaveProperty('runtimeActivityApplicability');
    });

    it('does not retain private daemon spawn hooks', () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                daemonSpawnHooks: {
                    augmentEnv: () => ({ PRIVATE_DAEMON_SPAWN: 'retired' }),
                },
            } as never,
        })();

        expect(hooks).not.toHaveProperty('getDaemonSpawnHooks');
    });

    it('does not retain a private CLI session-command declaration', () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                cliSessionCommand: {
                    backendIdForSessionRuntime: 'private-claude',
                },
            } as never,
        })();

        expect(hooks).not.toHaveProperty('getCliCommandHandler');
    });

    it('does not retain private static Agent catalog facts', () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'acme.static-catalog',
            packageName: '@happier-dev/plugins-test',
            systemTools: [{
                id: 'acme-cli',
                title: 'Acme CLI',
                executableNames: ['acme'],
            }],
            contribution: {
                agentCliSystemTool: { toolId: 'acme-cli' },
                vendorResumeSupport: { support: 'experimental' },
            } as never,
        })();

        expect(hooks).not.toHaveProperty('agentCliSystemTool');
        expect(hooks).not.toHaveProperty('vendorResumeSupport');
    });

    it('does not retain a private pet-discovery contribution', () => {
        const resolveHomePath = vi.fn(() => '/tmp/codex');
        const resolveHomeEntries = vi.fn(async () => []);
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                petDiscovery: { resolveHomePath, resolveHomeEntries },
            } as never,
        })();

        expect(hooks).not.toHaveProperty('resolvePetDiscoveryHomePath');
        expect(hooks).not.toHaveProperty('resolvePetDiscoveryHomeEntries');
        expect(resolveHomePath).not.toHaveBeenCalled();
        expect(resolveHomeEntries).not.toHaveBeenCalled();
    });

    it('does not retain a private cloud-connect catalog hook', () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                cloudConnect: {
                    displayName: 'Codex',
                    vendorDisplayName: 'OpenAI Codex',
                    vendorKey: 'openai',
                    status: 'wired',
                    customAuthenticator: {
                        authenticate: async () => ({ ok: true }),
                    },
                },
            } as never,
        })();

        expect(hooks).not.toHaveProperty('getCloudConnectTarget');
    });

    it('projects generation-current deferred startup and experimental vendor-resume policies without a private aggregate', async () => {
        const shouldUseDeferredBootstrap = vi.fn(() => true);
        const supportsVendorResume = vi.fn(() => true);
        let current = true;
        const startupHooks = projectAgentSessionStartupCatalogEntry({
            sessionStartup: { shouldUseDeferredBootstrap },
            isCurrent: () => current,
        });
        const resumeHooks = projectAgentExperimentalVendorResumeSupportCatalogEntry({
            vendorResumeSupport: { supportsVendorResume },
            isCurrent: () => current,
        });
        const input = {
            startedBy: 'terminal' as const,
            startingMode: 'terminal' as const,
            hasExistingSession: false,
            hasSessionAttachFile: false,
            hasProviderResumeId: false,
            hasExplicitPermissionMode: false,
            hasPersistedPermissionModeSeed: false,
            hasTerminalTty: true,
        };

        expect(startupHooks.shouldUseDeferredSessionStartup?.(input)).toBe(true);
        expect(shouldUseDeferredBootstrap).toHaveBeenCalledWith(input);
        const supportsResume = await resumeHooks.getVendorResumeSupport?.();
        expect(supportsResume?.({ agentRuntimeSelection: { mode: 'acp' } })).toBe(true);
        expect(supportsVendorResume).toHaveBeenCalledWith({
            agentRuntimeSelection: { mode: 'acp' },
        });

        current = false;
        expect(startupHooks.shouldUseDeferredSessionStartup?.(input)).toBe(false);
        expect(supportsResume?.({ agentRuntimeSelection: { mode: 'acp' } })).toBe(false);
        expect(shouldUseDeferredBootstrap).toHaveBeenCalledTimes(1);
        expect(supportsVendorResume).toHaveBeenCalledTimes(1);
    });

    it('projects only static connected-account launch facts through the catalog', async () => {
        const hooks = projectAgentConnectedAccountLaunchCatalogEntry({
            agentId: 'claude',
            connectedAccountLaunch: {
                requestAuthUses: [{
                    purpose: 'model_upstream',
                    materialization: {
                        kind: 'httpHeaders',
                        origin: 'https://api.example.test',
                        headerNames: ['authorization'],
                    },
                }],
                stateSharingDescriptor: {
                    providerSupportStatus: 'supported',
                    config: {
                        supported: true,
                        modes: ['linked'],
                        entries: [{ path: '.agent/config.toml', mode: 'linked' }],
                    },
                    state: {
                        supported: true,
                        modes: ['isolated'],
                        entries: [],
                        symlinkUnavailableDegradePolicy: 'block_continuity',
                    },
                    authIsolation: {
                        mode: 'materialized_home',
                        secretEntries: ['.agent/config.toml'],
                    },
                },
            },
        });

        expect(hooks.connectedAccountRequestAuthUses).toEqual([{
            purpose: 'model_upstream',
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://api.example.test',
                headerNames: ['authorization'],
            },
        }]);
        await expect(hooks.getConnectedServiceStateSharingDescriptor?.()).resolves.toEqual({
            providerId: 'claude',
            providerSupportStatus: 'supported',
            config: {
                supported: true,
                modes: ['linked'],
                entries: [{ path: '.agent/config.toml', mode: 'linked' }],
            },
            state: {
                supported: true,
                modes: ['isolated'],
                entries: [],
                symlinkUnavailableDegradePolicy: 'block_continuity',
            },
            authIsolation: {
                mode: 'materialized_home',
                secretEntries: ['.agent/config.toml'],
            },
        });
        expect(hooks).not.toHaveProperty('getConnectedServicesMaterializer');
        expect(hooks).not.toHaveProperty('resolveConnectedServiceMaterializedHomeRoot');
    });

    it('preserves Claude config source precedence for connected-service state sharing', () => {
        const connectedServices = (
            CLAUDE_AGENT_RUNTIME_CONTRIBUTION as {
                connectedServices: {
                    resolveStateSharingSourceRoot: (params: { env: NodeJS.ProcessEnv }) => string;
                };
            }
        ).connectedServices;

        expect(connectedServices.resolveStateSharingSourceRoot({
            env: {
                CLAUDE_CONFIG_DIR: '/tmp/native-claude',
                HAPPIER_CLAUDE_CONFIG_DIR: '/tmp/happier-claude',
            },
        })).toBe('/tmp/native-claude');
    });

    it('projects provider-owned materialized-home freshness checks through connected-services catalog hooks', async () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-claude',
            contribution: CLAUDE_AGENT_RUNTIME_CONTRIBUTION,
            systemTools: CLAUDE_PLUGIN_MANIFEST.contributes.systemTools,
        })();
        const contributedFreshness = (
            CLAUDE_AGENT_RUNTIME_CONTRIBUTION as {
                connectedServices: {
                    isMaterializedHomeStale: unknown;
                };
            }
        ).connectedServices.isMaterializedHomeStale;

        await expect(hooks.getConnectedServiceMaterializedHomeFreshness?.()).resolves.toEqual({
            isMaterializedHomeStale: contributedFreshness,
        });
    });

    it('does not retain a private Agent CLI auth aggregate', () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'kiro',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                cliAuth: {
                    detectAuthStatus: async () => ({
                        state: 'logged_in',
                        method: 'oauth_cli',
                        source: 'mixed',
                        accountLabel: 'plugin-auth@example.com',
                    }),
                },
            } as never,
        })();

        expect(hooks).not.toHaveProperty('getCliAuthSpec');
    });

    it('projects public Agent auth callbacks with only an admitted declared-system-tool runner', async () => {
        const hooks = projectAgentCliAuthCatalogEntry({
            agentId: 'copilot',
            cli: null,
            systemTools: [{
                id: 'github-cli',
                title: 'GitHub CLI',
                executableNames: ['gh'],
            }],
            cliAuth: {
                detectAuthStatus: async (input) => {
                    expect(Object.keys(input)).toEqual(['runDeclaredSystemToolCommand']);
                    await expect(input.runDeclaredSystemToolCommand({
                        toolId: 'github-cli',
                        args: ['auth', 'status'],
                        timeoutMs: 1_500,
                    })).resolves.toEqual({
                        ok: false,
                        stdout: '',
                        stderr: '',
                        exitCode: null,
                    });
                    return {
                        state: 'unknown',
                        reason: 'probe_failed',
                        source: 'command',
                    };
                },
            },
            isCurrent: () => true,
        });

        const spec = await hooks.getCliAuthSpec?.();
        await expect(spec?.detectAuthStatus?.({ resolvedPath: '/missing-copilot' })).resolves.toEqual({
            state: 'unknown',
            reason: 'probe_failed',
            source: 'command',
        });
    });

    it('projects Pi CLI catalog residuals from the Pi runtime contribution', async () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'pi',
            packageName: '@happier-dev/plugins-pi',
            contribution: PI_AGENT_RUNTIME_CONTRIBUTION,
            systemTools: PI_PLUGIN_MANIFEST.contributes.systemTools,
        })();

        expect(hooks.getCliCommandHandler).toBeTypeOf('function');
        expect(hooks).not.toHaveProperty('checklists');

        // Pi's CLI detect/auth spec is a declared-manifest fact projected by
        // `createManifestAgentCatalogEntry`, exactly as it is for an installed Agent.
        // The runtime contribution must not re-own it.
        expect(hooks.getCliDetect).toBeUndefined();
        expect(hooks.getCliAuthSpec).toBeUndefined();
    });

    it('projects only strict provider-owned request-auth use descriptors', () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'pi',
            packageName: '@happier-dev/plugins-pi',
            contribution: PI_AGENT_RUNTIME_CONTRIBUTION,
            systemTools: PI_PLUGIN_MANIFEST.contributes.systemTools,
        })();

        expect(hooks.connectedAccountRequestAuthUses).toEqual([{
            purpose: 'anthropic-model-request',
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://api.anthropic.com',
                headerNames: ['authorization'],
            },
        }, {
            purpose: 'openai-codex-model-request',
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://chatgpt.com',
                headerNames: ['authorization', 'chatgpt-account-id'],
            },
        }]);

        const invalidContribution = {
            ...PI_AGENT_RUNTIME_CONTRIBUTION,
            connectedServices: {
                ...PI_AGENT_RUNTIME_CONTRIBUTION.connectedServices,
                requestAuthUses: [{
                    purpose: 'openai-codex-model-request',
                    materialization: {
                        kind: 'httpHeaders',
                        origin: 'https://api.openai.com/v1',
                        headerNames: ['Authorization'],
                    },
                }],
            },
        };
        const invalidHooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'pi',
            packageName: '@happier-dev/plugins-pi',
            contribution: invalidContribution as never,
            systemTools: PI_PLUGIN_MANIFEST.contributes.systemTools,
        })();
        expect(invalidHooks).not.toHaveProperty(
            'connectedAccountRequestAuthUses',
        );
    });

    it('does not project the retired static external-session host-adapter carrier', () => {
        const createTranscriptStoreAdapter = vi.fn();
        const createCandidateHostAdapter = vi.fn();
        const contributionWithRetiredCarrier = {
            externalSessions: {
                createTranscriptStoreAdapter,
                createCandidateHostAdapter,
            },
        } as unknown as Parameters<typeof createAgentRuntimeCatalogEntryHooks>[0]['contribution'];

        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-codex',
            contribution: contributionWithRetiredCarrier,
        })();

        expect(hooks).not.toHaveProperty('getExternalSessionRuntimeHostAdapters');
        expect(createTranscriptStoreAdapter).not.toHaveBeenCalled();
        expect(createCandidateHostAdapter).not.toHaveBeenCalled();
    });

    it('projects Agent-native command policy through the host session command without raw argv authority', async () => {
        const buildSessionOptions = vi.fn(() => ({
            ok: true as const,
            options: { externalAgentArgs: ['--fast'] },
        }));
        const cliSessionCommand = {
            sessionRuntimeId: 'acme.external.backend',
            accountSettingsAgentId: 'acme.external',
            buildSessionOptions,
        } satisfies AgentCliSessionCommandDeclarationV1;
        const hooks = projectAgentCliSessionCommandCatalogEntry({
            agentId: 'acme.external' as never,
            cliSessionCommand,
        });
        const handler = await hooks.getCliCommandHandler?.();

        expect(handler).toBeTypeOf('function');
        await handler?.({
            args: ['acme.external'],
            rawArgv: ['happier', 'acme.external'],
            terminalRuntime: null,
        });

        expect(runBackendSessionCliCommandMock).toHaveBeenCalledWith(
            expect.objectContaining({
                backendIdForSessionRuntime: 'acme.external.backend',
                runtimeAuthorityAgentId: 'acme.external',
                agentIdForAccountSettings: 'acme.external',
                isExplicitCliSubcommand: true,
            }),
        );
        const call = runBackendSessionCliCommandMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
        expect(call).not.toHaveProperty('agentIdForDeprecatedAliases');
        expect(call).not.toHaveProperty('resolveExtraOptions');

        expect(hooks.resolveSessionRuntimePreferences?.({
            isExplicitCliSubcommand: true,
            parsed: {
                startingMode: 'remote',
                directory: '/workspace',
                resume: 'vendor-1',
                agentArgs: ['--fast'],
            },
            settings: { acmeSessionPreference: 'fast' },
            environment: { ACME_PROFILE: 'work' },
            startOrigin: 'terminal',
        })).toEqual({ externalAgentArgs: ['--fast'] });
        expect(buildSessionOptions).toHaveBeenCalledWith({
            isExplicitCliSubcommand: true,
            parsed: {
                startingMode: 'remote',
                directory: '/workspace',
                resume: 'vendor-1',
                agentArgs: ['--fast'],
            },
            settings: { acmeSessionPreference: 'fast' },
            environment: { ACME_PROFILE: 'work' },
            startOrigin: 'terminal',
        });
    });

    it('delegates implicit default resume before provider session dispatch when declared', async () => {
        const runBackendSessionCliCommand = vi.fn(async () => undefined);
        const resolveSessionCommandResumeDelegation = vi.fn(
            async (params: Readonly<{ explicitProviderSubcommand: boolean }>) => (
                params.explicitProviderSubcommand
                    ? { kind: 'continue' as const }
                    : { kind: 'delegate' as const, sessionId: 'session-1' }
            ),
        );
        const handleResumeCommand = vi.fn(async () => undefined);
        const getHandler = createCliSessionCommandHandler({
            sessionRuntimeId: 'claude',
            accountSettingsAgentId: 'claude',
            implicitResumeDelegation: { resumeFlags: ['--resume', '-r'] },
        }, {
            cliSubcommand: 'claude',
            runtimeAuthorityAgentId: 'claude',
        }, {
            runBackendSessionCliCommand,
            resolveSessionCommandResumeDelegation,
            handleResumeCommand,
        });

        const handler = await getHandler();
        await handler({
            args: ['--resume', 'session-1'],
            rawArgv: ['happier', '--resume', 'session-1'],
            terminalRuntime: null,
        });

        expect(resolveSessionCommandResumeDelegation).toHaveBeenCalledWith({
            args: ['--resume', 'session-1'],
            explicitProviderSubcommand: false,
            resumeFlags: ['--resume', '-r'],
        });
        expect(handleResumeCommand).toHaveBeenCalledWith(['session-1'], {
            terminalRuntime: null,
            rawArgv: ['happier', '--resume', 'session-1'],
        });
        expect(runBackendSessionCliCommand).not.toHaveBeenCalled();
    });

    it('continues provider session dispatch when resume delegation is absent or explicit', async () => {
        const runBackendSessionCliCommand = vi.fn(async () => undefined);
        const resolveSessionCommandResumeDelegation = vi.fn(
            async (params: Readonly<{ explicitProviderSubcommand: boolean }>) => (
                params.explicitProviderSubcommand
                    ? { kind: 'continue' as const }
                    : { kind: 'delegate' as const, sessionId: 'session-1' }
            ),
        );
        const handleResumeCommand = vi.fn(async () => undefined);

        const implicitHandler = await createCliSessionCommandHandler({
            sessionRuntimeId: 'claude',
            accountSettingsAgentId: 'claude',
        }, {
            cliSubcommand: 'claude',
            runtimeAuthorityAgentId: 'claude',
        }, {
            runBackendSessionCliCommand,
            resolveSessionCommandResumeDelegation,
            handleResumeCommand,
        })();
        await implicitHandler({
            args: ['--resume', 'session-1'],
            rawArgv: ['happier', '--resume', 'session-1'],
            terminalRuntime: null,
        });

        expect(resolveSessionCommandResumeDelegation).not.toHaveBeenCalled();
        expect(handleResumeCommand).not.toHaveBeenCalled();
        expect(runBackendSessionCliCommand).toHaveBeenCalledTimes(1);

        const explicitHandler = await createCliSessionCommandHandler({
            sessionRuntimeId: 'claude',
            accountSettingsAgentId: 'claude',
            implicitResumeDelegation: { resumeFlags: ['--resume', '-r'] },
        }, {
            cliSubcommand: 'claude',
            runtimeAuthorityAgentId: 'claude',
        }, {
            runBackendSessionCliCommand,
            resolveSessionCommandResumeDelegation,
            handleResumeCommand,
        })();
        await explicitHandler({
            args: ['claude', '--resume', 'vendor-session-1'],
            rawArgv: ['happier', 'claude', '--resume', 'vendor-session-1'],
            terminalRuntime: null,
        });

        expect(resolveSessionCommandResumeDelegation).toHaveBeenCalledWith({
            args: ['claude', '--resume', 'vendor-session-1'],
            explicitProviderSubcommand: true,
            resumeFlags: ['--resume', '-r'],
        });
        expect(handleResumeCommand).not.toHaveBeenCalled();
        expect(runBackendSessionCliCommand).toHaveBeenCalledTimes(2);
    });

    it('runs public preflight commands through host-owned resolution and environment policy', async () => {
        const toolRoot = await mkdtemp(join(tmpdir(), 'happier-external-agent-tool-'));
        const executable = writeExecutableShimSync({
            dir: toolRoot,
            fileName: process.platform === 'win32' ? 'external-agent.cmd' : 'external-agent',
            contents: process.platform === 'win32'
                ? [
                    '@echo off',
                    'set ci=0',
                    'if defined CI set ci=1',
                    'set keep=0',
                    'if defined KEEP set keep=1',
                    'set drop=0',
                    'if defined DROP set drop=1',
                    'echo %ci%|%keep%|%drop%',
                ].join('\r\n')
                : [
                    '#!/bin/sh',
                    'ci=0; [ -n "${CI+x}" ] && ci=1',
                    'keep=0; [ -n "${KEEP+x}" ] && keep=1',
                    'drop=0; [ -n "${DROP+x}" ] && drop=1',
                    'printf "%s|%s|%s\\n" "$ci" "$keep" "$drop"',
                ].join('\n'),
        });
        const omissionContribution = {
            models: {
                command: {
                    toolId: 'external-agent-cli',
                    args: ['models'],
                    environmentExcludeKeys: ['DROP'],
                    ci: 'omit',
                },
                parseOutput: ({ stdout }) => stdout.trim(),
            },
        } satisfies AgentPreflightSessionControlsContributionV1;
        const defaultContribution = {
            models: {
                command: {
                    toolId: 'external-agent-cli',
                    args: ['models'],
                    environmentKeys: ['KEEP'],
                },
                parseOutput: ({ stdout }) => stdout.trim(),
            },
        } satisfies AgentPreflightSessionControlsContributionV1;
        const project = (preflightSessionControls: AgentPreflightSessionControlsContributionV1) => (
            projectAgentPreflightSessionControlsCatalogEntry({
                agentId: 'acme.external-agent' as never,
                preflightSessionControls,
                systemTools: [{
                    id: 'external-agent-cli',
                    title: 'External Agent CLI',
                    executableNames: [executable],
                }],
                retirementSignal: new AbortController().signal,
                isCurrent: () => true,
            })
        );

        try {
            const omissionAdapter = await project(omissionContribution).getPreflightSessionControlsProbeAdapter?.();

            await expect(omissionAdapter?.probeModelsRaw?.({
                cwd: toolRoot,
                timeoutMs: 1_500,
                backendTarget: undefined,
                accountSettings: null,
                env: { CI: 'ambient', KEEP: 'kept', DROP: 'dropped' },
            })).resolves.toBe('0|1|0');
            expect(omissionAdapter).not.toHaveProperty('connectedServiceAuth');
            expect(omissionAdapter).not.toHaveProperty('failureCacheStrategy');

            const defaultAdapter = await project(defaultContribution).getPreflightSessionControlsProbeAdapter?.();
            await expect(defaultAdapter?.probeModelsRaw?.({
                cwd: toolRoot,
                timeoutMs: 1_500,
                backendTarget: undefined,
                accountSettings: null,
                env: { CI: 'ambient', KEEP: 'kept', DROP: 'dropped' },
            })).resolves.toBe('1|1|0');
        } finally {
            await rm(toolRoot, { recursive: true, force: true });
        }
    });

    it('keeps catalog handoff projection to metadata leaves rather than runtime operations', async () => {
        const extract = vi.fn(() => []);
        const build = vi.fn(() => ({ opencodeSessionId: 'provider-session-1' }));
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'opencode',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                sessionHandoff: {
                    agentBundleRecords: { extract },
                    runtimeLocalMetadata: { build },
                },
            },
        })();

        await expect(hooks.getSessionHandoffAgentBundleRecordExtractor?.()).resolves.toBe(extract);
        expect(hooks.buildRuntimeLocalHandoffMetadata).toBe(build);
        expect(hooks).not.toHaveProperty('getHandoffSurface');
        expect(hooks).not.toHaveProperty('resolveReplayChildLaunch');
    });

    it('projects Codex daemon auth bridge refresh through the plugin runtime contribution', async () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-codex',
            contribution: CODEX_AGENT_RUNTIME_CONTRIBUTION,
            systemTools: CODEX_PLUGIN_MANIFEST.contributes.systemTools,
        })() as ReturnType<ReturnType<typeof createAgentRuntimeCatalogEntryHooks>> & {
            getConnectedServiceDaemonAuthBridgeRefresh?: (serviceId: string) => Promise<((input: Readonly<{
                serviceId: string;
                request: Readonly<Record<string, unknown>>;
                refreshCoordinator: {
                    refreshOpenAiCodexChatGptTokensForBridge(input: unknown): Promise<unknown>;
                };
            }>) => Promise<unknown>) | null>;
        };
        const refreshOpenAiCodexChatGptTokensForBridge = vi.fn(async () => ({
            accessToken: 'codex-access',
            chatgptAccountId: 'acct_123',
            chatgptPlanType: 'plus',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        }));

        await expect(hooks.getConnectedServiceDaemonAuthBridgeRefresh?.('openai')).resolves.toBeNull();
        const refresh = await hooks.getConnectedServiceDaemonAuthBridgeRefresh?.('openai-codex');

        await expect(refresh?.({
            serviceId: 'openai-codex',
            request: {
                sessionId: 'sess_codex',
                refreshAttemptId: 'codex-refresh-attempt-projection',
                selection: {
                    kind: 'profile',
                    serviceId: 'openai-codex',
                    profileId: 'codex-profile',
                },
                planType: 'plus',
                forceRefresh: true,
                failingAccessTokenFingerprint: 'sha256:failed',
                expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            },
            refreshCoordinator: { refreshOpenAiCodexChatGptTokensForBridge } as never,
        })).resolves.toEqual({
            status: 'refreshed',
            result: {
                accessToken: 'codex-access',
                chatgptAccountId: 'acct_123',
                chatgptPlanType: 'plus',
                credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            },
        });
        expect(refreshOpenAiCodexChatGptTokensForBridge).toHaveBeenCalledWith({
            refreshAttemptId: 'codex-refresh-attempt-projection',
            selection: {
                kind: 'profile',
                serviceId: 'openai-codex',
                profileId: 'codex-profile',
            },
            chatgptPlanType: 'plus',
            forceRefresh: true,
            failingAccessTokenFingerprint: 'sha256:failed',
            expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        });
    });

    it('projects Codex predecessor failure-source compatibility through the provider contribution', () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-codex',
            contribution: CODEX_AGENT_RUNTIME_CONTRIBUTION,
            systemTools: CODEX_PLUGIN_MANIFEST.contributes.systemTools,
        })() as ReturnType<ReturnType<typeof createAgentRuntimeCatalogEntryHooks>> & {
            resolveLegacyConnectedServiceRuntimeAuthFailureSourceRevision?: unknown;
        };

        expect(hooks.resolveLegacyConnectedServiceRuntimeAuthFailureSourceRevision).toBeTypeOf('function');
    });

    it('projects connected-service quota fetchers through the plugin runtime contribution', async () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-codex',
            contribution: CODEX_AGENT_RUNTIME_CONTRIBUTION,
            systemTools: CODEX_PLUGIN_MANIFEST.contributes.systemTools,
        })() as ReturnType<ReturnType<typeof createAgentRuntimeCatalogEntryHooks>> & {
            getConnectedServiceQuotaFetcherDescriptor?: () => Promise<Readonly<{
                id: string;
                createFetcher: (params: Readonly<{
                    env: NodeJS.ProcessEnv;
                    staleAfterMs: number;
                    userAgent?: string;
                }>) => unknown;
            }> | null>;
        };

        const descriptor = await hooks.getConnectedServiceQuotaFetcherDescriptor?.();

        expect(descriptor?.id).toBe('openai-codex');
        expect(descriptor?.createFetcher).toBeTypeOf('function');
    });

    it('does not project Claude auth through the private runtime aggregate', () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-claude',
            contribution: CLAUDE_AGENT_RUNTIME_CONTRIBUTION,
            systemTools: CLAUDE_PLUGIN_MANIFEST.contributes.systemTools,
        })();

        expect(hooks.getCliAuthSpec).toBeUndefined();
        expect(hooks).not.toHaveProperty('getHeadlessTmuxArgvTransform');
        expect(hooks).not.toHaveProperty('getTerminalPromptSubmitVerificationPolicy');
        expect(hooks).not.toHaveProperty('onTerminalAttachmentRetired');
        expect(hooks.getPreflightSessionControlsProbeAdapter).toBeUndefined();
    });

    it('projects Claude daemon auth bridge refresh through the plugin runtime contribution', async () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-claude',
            contribution: CLAUDE_AGENT_RUNTIME_CONTRIBUTION,
            systemTools: CLAUDE_PLUGIN_MANIFEST.contributes.systemTools,
        })() as ReturnType<ReturnType<typeof createAgentRuntimeCatalogEntryHooks>> & {
            getConnectedServiceDaemonAuthBridgeRefresh?: (serviceId: string) => Promise<((input: Readonly<{
                serviceId: string;
                request: Readonly<Record<string, unknown>>;
                refreshCoordinator: {
                    refreshClaudeSubscriptionTokensForBridge(input: unknown): Promise<unknown>;
                };
            }>) => Promise<unknown>) | null>;
        };
        const refreshClaudeSubscriptionTokensForBridge = vi.fn(async () => ({
            accessToken: 'claude-access',
            anthropicAccountId: 'anthropic-acct',
            expiresAt: null,
        }));

        await expect(hooks.getConnectedServiceDaemonAuthBridgeRefresh?.('anthropic')).resolves.toBeNull();
        const refresh = await hooks.getConnectedServiceDaemonAuthBridgeRefresh?.('claude-subscription');

        await expect(refresh?.({
            serviceId: 'claude-subscription',
            request: {
                sessionId: 'sess_claude',
                selection: {
                    kind: 'profile',
                    serviceId: 'claude-subscription',
                    profileId: 'claude-profile',
                },
                forceRefresh: false,
                expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            },
            refreshCoordinator: { refreshClaudeSubscriptionTokensForBridge } as never,
        })).resolves.toEqual({
            status: 'refreshed',
            result: {
                accessToken: 'claude-access',
                anthropicAccountId: 'anthropic-acct',
                expiresAt: null,
            },
        });
        expect(refreshClaudeSubscriptionTokensForBridge).toHaveBeenCalledWith({
            selection: {
                kind: 'profile',
                serviceId: 'claude-subscription',
                profileId: 'claude-profile',
            },
            forceRefresh: false,
            expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        });
    });

    it('uses plugin-provided connected-service runtime auth adapters instead of the restart-only fallback', async () => {
        const runtimeAuthAdapter = {
            classifyRuntimeAuthFailure: () => null,
            materializeActiveProfile: async () => ({ supported: true, via: 'plugin' }),
            canHotApply: () => ({ supported: true, via: 'plugin' }),
            hotApply: async () => ({ applied: true, via: 'plugin' }),
            recoverAfterRuntimeAuthSwitch: async () => ({ recovered: true, via: 'plugin' }),
            probeQuota: async () => ({ status: 'available', via: 'plugin' }),
            refreshActiveProfile: async () => ({ status: 'available', via: 'plugin' }),
        };
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['openai-codex'],
                    readConnectedServiceId: (selection: unknown) => selection === 'openai-codex' ? 'openai-codex' : null,
                    createAuthMaterializationInput: () => ({}),
                    materializeAuthEnvironment: () => ({ env: {} }),
                    stateSharingDescriptor: {
                        agentId: 'codex',
                        providerSupportStatus: 'supported',
                        config: { supported: true, modes: ['isolated'], entries: [] },
                        state: {
                            supported: true,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'materialized_home', secretEntries: [] },
                    },
                    shouldRestartForServiceSwitch: (serviceId: unknown) => serviceId === 'openai-codex',
                    restartRematerializeRequiredReason: 'codex_session_state_sharing_required',
                    resolveResumeReachabilityUnsupported: async () => ({ ok: false, reason: 'unsupported' }),
                    classifyUsageLimitError: () => null,
                    runtimeAuthAdapter,
                    usageLimitRecovery: {
                        agentId: 'codex',
                        fallbackBackoffEnvKey: 'HAPPIER_TEST_BACKOFF_MS',
                        maxAttemptsEnvKey: 'HAPPIER_TEST_MAX_ATTEMPTS',
                        defaultFallbackBackoffMs: 1,
                        defaultMaxAttempts: 1,
                    },
                },
            },
        })();

        const adapter = await hooks.getConnectedServiceRuntimeAuthAdapter?.();
        expect(adapter?.canHotApply({
            target: { agentId: 'codex' },
            selection: null,
        })).toEqual({ supported: true, via: 'plugin' });
        await expect(adapter?.probeQuota({
            target: { agentId: 'codex' },
            selection: null,
        })).resolves.toEqual({ status: 'available', via: 'plugin' });
    });

    it('rechecks shared-home target currency inside the destination lock before provider mutation', async () => {
        const destinationHome = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-currentness-'));
        const hotApply = vi.fn(async () => ({ applied: true, via: 'plugin' }));
        try {
            const hooks = createAgentRuntimeCatalogEntryHooks({
                agentId: 'claude',
                packageName: '@happier-dev/plugins-test',
                contribution: {
                    connectedServices: {
                        serviceIds: ['claude-subscription'],
                        readConnectedServiceId: () => 'claude-subscription',
                        createAuthMaterializationInput: () => ({}),
                        materializeAuthEnvironment: () => ({ env: {} }),
                        stateSharingDescriptor: {
                            agentId: 'claude',
                            providerSupportStatus: 'supported',
                            config: { supported: true, modes: ['isolated'], entries: [] },
                            state: {
                                supported: true,
                                modes: ['isolated'],
                                entries: [],
                                symlinkUnavailableDegradePolicy: 'block_continuity',
                            },
                            authIsolation: { mode: 'materialized_home', secretEntries: [] },
                        },
                        shouldRestartForServiceSwitch: () => false,
                        classifyUsageLimitError: () => null,
                        runtimeAuthAdapter: {
                            resolveDestinationHome: () => destinationHome,
                            classifyRuntimeAuthFailure: () => null,
                            materializeActiveProfile: async () => ({ supported: true }),
                            canHotApply: () => ({ supported: true }),
                            hotApply,
                            recoverAfterRuntimeAuthSwitch: async () => ({ recovered: true }),
                            probeQuota: async () => ({ status: 'available' }),
                            refreshActiveProfile: async () => ({ status: 'available' }),
                        },
                    },
                },
            })();
            const adapter = await hooks.getConnectedServiceRuntimeAuthAdapter?.();

            await expect(adapter?.hotApply({
                target: { agentId: 'claude' },
                selection: null,
                validateCurrentBeforeMutation: async () => ({
                    current: false,
                    reason: 'credential_revision_superseded',
                    authoritativeTarget: {
                        profileId: 'profile-current',
                        generation: 7,
                        credentialRevision: 'csr_2123456789ABCDEFGHJKMNPQRS',
                    },
                }),
            } as never)).resolves.toEqual({
                applied: false,
                status: 'superseded_after_apply',
                activeProfileId: 'profile-current',
                generation: 7,
                credentialRevision: 'csr_2123456789ABCDEFGHJKMNPQRS',
                reason: 'credential_revision_superseded',
                recovery: 'none',
            });
            expect(hotApply).not.toHaveBeenCalled();
        } finally {
            await rm(destinationHome, { recursive: true, force: true });
        }
    });

    it('projects Pi connected-service hooks from the plugin runtime contribution', async () => {
        expect(PI_AGENT_RUNTIME_CONTRIBUTION.connectedServices.usageLimitRecovery).toMatchObject({
            agentId: 'pi',
        });

        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'pi',
            packageName: '@happier-dev/plugins-pi',
            contribution: PI_AGENT_RUNTIME_CONTRIBUTION as Parameters<
                typeof createAgentRuntimeCatalogEntryHooks
            >[0]['contribution'],
            systemTools: PI_PLUGIN_MANIFEST.contributes.systemTools,
        })();

        expect(hooks.getConnectedServicesMaterializer).toBeTypeOf('function');
        expect(hooks).not.toHaveProperty('materializeConnectedServiceRuntimeAuthSelection');
        expect(hooks.getConnectedServiceRuntimeAuthAdapter).toBeTypeOf('function');
        expect(hooks.getConnectedServiceStateSharingDescriptor).toBeTypeOf('function');
        expect(hooks.getConnectedServiceRecoveryCapabilities).toBeTypeOf('function');
        expect(hooks).not.toHaveProperty('getSessionUsageLimitRecoveryControlAdapter');
        expect(hooks.sessionUsageLimitRecoveryBackoffPolicy).toMatchObject({
            providerId: 'pi',
            defaultFallbackBackoffMs: 600_000,
            defaultMaxAttempts: 3,
        });
        expect(hooks.resolveConnectedServiceSwitchContinuity).toBeTypeOf('function');
        expect(hooks.verifyResumeReachable).toBeTypeOf('function');
        expect(hooks.resolveConnectedServiceCandidatePersistedSessionFile).toBeTypeOf('function');

        await expect(hooks.getConnectedServiceRecoveryCapabilities?.()).resolves.toEqual({
            predictiveSoftSwitch: { mode: 'unsupported' },
            generationApplicationScope: 'request_time_auth',
        });
        await expect(hooks.getConnectedServiceStateSharingDescriptor?.()).resolves.toMatchObject({
            providerId: 'pi',
            authIsolation: {
                mode: 'materialized_home',
                secretEntries: expect.arrayContaining(['auth.json']),
            },
        });
    });

    it('keeps OpenCode request-auth services out of the legacy runtime-auth adapter path', () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'opencode',
            packageName: '@happier-dev/plugins-opencode',
            contribution: OPENCODE_AGENT_RUNTIME_CONTRIBUTION as Parameters<
                typeof createAgentRuntimeCatalogEntryHooks
            >[0]['contribution'],
            systemTools: OPENCODE_PLUGIN_MANIFEST.contributes.systemTools,
        })();

        expect(hooks.getConnectedServicesMaterializer).toBeTypeOf('function');
        expect(hooks.getConnectedServiceRuntimeAuthAdapter).toBeUndefined();
        expect(hooks.getConnectedServiceRecoveryCapabilities).toBeTypeOf('function');
    });

    it('does not retain OpenCode provider attach in the private bundled catalog contribution', () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'opencode',
            packageName: '@happier-dev/plugins-opencode',
            contribution: OPENCODE_AGENT_RUNTIME_CONTRIBUTION as Parameters<
                typeof createAgentRuntimeCatalogEntryHooks
            >[0]['contribution'],
            systemTools: OPENCODE_PLUGIN_MANIFEST.contributes.systemTools,
        })();

        expect(hooks.resolveHostAgentRuntimeSurfaces).toBeUndefined();
    });

    it('projects OhMyPi connected-service hooks from the plugin runtime contribution', async () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'ohMyPi',
            packageName: '@happier-dev/plugins-ohmypi',
            contribution: OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION as Parameters<
                typeof createAgentRuntimeCatalogEntryHooks
            >[0]['contribution'],
        })();

        expect(hooks.getConnectedServicesMaterializer).toBeTypeOf('function');
        expect(hooks).not.toHaveProperty('materializeConnectedServiceRuntimeAuthSelection');
        expect(hooks.getConnectedServiceRuntimeAuthAdapter).toBeTypeOf('function');
        expect(hooks.getConnectedServiceStateSharingDescriptor).toBeTypeOf('function');
        expect(hooks.resolveConnectedServiceSwitchContinuity).toBeTypeOf('function');
        expect(hooks.verifyResumeReachable).toBeTypeOf('function');

        await expect(hooks.getConnectedServiceStateSharingDescriptor?.()).resolves.toMatchObject({
            providerId: 'ohMyPi',
            providerSupportStatus: 'unsupported',
            authIsolation: {
                mode: 'process_env',
                secretEntries: [
                    'OPENAI_CODEX_OAUTH_TOKEN',
                    'OPENAI_API_KEY',
                    'ANTHROPIC_OAUTH_TOKEN',
                    'ANTHROPIC_API_KEY',
                    'GEMINI_API_KEY',
                ],
            },
        });

        const adapter = await hooks.getConnectedServiceRuntimeAuthAdapter?.();
        expect(adapter?.canHotApply({
            target: { agentId: 'ohMyPi' },
            selection: null,
        })).toEqual({ supported: false, recovery: 'restart_rematerialize' });

        const materializer = await hooks.getConnectedServicesMaterializer?.();
        const record = buildConnectedServiceCredentialRecord({
            now: 1,
            serviceId: 'openai',
            profileId: 'openai-api',
            kind: 'token',
            token: {
                token: 'sk-test',
                providerAccountId: null,
                providerEmail: null,
            },
        });
        const result = await materializer?.({
            materializationKey: 'mat-ohmypi',
            activeServerDir: '/tmp/happier-active',
            baseDir: '/tmp/happier-base',
            rootDir: '/tmp/happier-root',
            connectedAccountMaterializationAuthority:
                LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
            recordsByServiceId: new Map([['openai', record]]),
            processEnv: { HOME: '/tmp/home' },
        });

        expect(result?.env).toEqual({ OPENAI_API_KEY: 'sk-test' });
        expect(result?.targetMaterializedRoot).toContain('ohmypi-auth');
    });

    it('projects host-owned usage-limit recovery policy without a cached control adapter', () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['claude-subscription'],
                    readConnectedServiceId: (selection: unknown) => selection === 'claude-subscription' ? 'claude-subscription' : null,
                    createAuthMaterializationInput: () => ({}),
                    materializeAuthEnvironment: () => ({ env: {} }),
                    stateSharingDescriptor: {
                        agentId: 'claude',
                        providerSupportStatus: 'supported',
                        config: { supported: true, modes: ['isolated'], entries: [] },
                        state: {
                            supported: true,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'materialized_home', secretEntries: [] },
                    },
                    classifyUsageLimitError: () => null,
                    usageLimitRecovery: {
                        agentId: 'claude',
                        issueProviderFilter: 'claude',
                        defaultNativeServiceId: 'claude-subscription',
                        fallbackBackoffEnvKey: 'HAPPIER_TEST_BACKOFF_MS',
                        maxAttemptsEnvKey: 'HAPPIER_TEST_MAX_ATTEMPTS',
                        defaultFallbackBackoffMs: 60_000,
                        defaultMaxAttempts: 3,
                    },
                },
            },
        })();

        expect(hooks).not.toHaveProperty('getSessionUsageLimitRecoveryControlAdapter');
        expect(hooks.sessionUsageLimitRecoveryBackoffPolicy).toEqual({
            providerId: 'claude',
            issueProviderFilter: 'claude',
            defaultNativeServiceId: 'claude-subscription',
            fallbackBackoffEnvKey: 'HAPPIER_TEST_BACKOFF_MS',
            maxAttemptsEnvKey: 'HAPPIER_TEST_MAX_ATTEMPTS',
            defaultFallbackBackoffMs: 60_000,
            defaultMaxAttempts: 3,
        });
    });

    it('projects declared connected-service recovery capability descriptors', async () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['claude-subscription'],
                    readConnectedServiceId: (selection: unknown) => selection === 'claude-subscription' ? 'claude-subscription' : null,
                    createAuthMaterializationInput: () => ({}),
                    materializeAuthEnvironment: () => ({ env: {} }),
                    stateSharingDescriptor: {
                        agentId: 'claude',
                        providerSupportStatus: 'supported',
                        config: { supported: true, modes: ['isolated'], entries: [] },
                        state: {
                            supported: true,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'materialized_home', secretEntries: [] },
                    },
                    recoveryCapabilities: {
                        predictiveSoftSwitch: { mode: 'supported' },
                        sameAccountFanoutStrategy: 'provider_account_id',
                        generationApplicationScope: 'request_time_auth',
                        runtimeAuthApply: {
                            directLiveHotAuth: {
                                supportsInTurnApply: true,
                                requiresExactRuntimeIdentity: true,
                                refreshSelectionResync: 'required',
                                authMode: {
                                    kind: 'external_token_injection',
                                    surface: 'codex_chatgpt_auth_tokens',
                                },
                            },
                        },
                    },
                },
            },
        })();

        await expect(hooks.getConnectedServiceRecoveryCapabilities?.()).resolves.toEqual({
            predictiveSoftSwitch: { mode: 'supported' },
            sameAccountFanoutStrategy: 'provider_account_id',
            generationApplicationScope: 'request_time_auth',
            runtimeAuthApply: {
                directLiveHotAuth: {
                    supportsInTurnApply: true,
                    requiresExactRuntimeIdentity: true,
                    refreshSelectionResync: 'required',
                    authMode: {
                        kind: 'external_token_injection',
                        surface: 'codex_chatgpt_auth_tokens',
                    },
                },
            },
        });

        const claudeHooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-claude',
            contribution: CLAUDE_AGENT_RUNTIME_CONTRIBUTION as Parameters<
                typeof createAgentRuntimeCatalogEntryHooks
            >[0]['contribution'],
            systemTools: CLAUDE_PLUGIN_MANIFEST.contributes.systemTools,
        })();
        await expect(claudeHooks.getConnectedServiceRecoveryCapabilities?.()).resolves.toEqual({
            predictiveSoftSwitch: {
                mode: 'supported',
                liveSessionRequirement: {
                    kind: 'shared_group_auth_surface',
                    serviceIds: ['claude-subscription'],
                    authEnvKey: 'CLAUDE_CONFIG_DIR',
                    authEnvSubpath: ['claude-config'],
                },
            },
            sameAccountFanoutStrategy: 'shared_group_auth_surface',
            generationApplicationScope: 'shared_group_auth_surface',
            sharedGenerationApplicationServiceIds: ['claude-subscription'],
            runtimeAuthApply: {
                directLiveHotAuth: {
                    supportsInTurnApply: false,
                    requiresExactRuntimeIdentity: false,
                    refreshSelectionResync: 'not_applicable',
                    authMode: {
                        kind: 'provider_owned',
                        name: 'claude_shared_group_auth_surface',
                    },
                },
            },
        });
    });

    it('rejects partial direct-live runtime apply capability declarations', async () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['openai-codex'],
                    readConnectedServiceId: (selection: unknown) => selection === 'openai-codex' ? 'openai-codex' : null,
                    createAuthMaterializationInput: () => ({}),
                    materializeAuthEnvironment: () => ({ env: {} }),
                    stateSharingDescriptor: {
                        agentId: 'codex',
                        providerSupportStatus: 'supported',
                        config: { supported: true, modes: ['isolated'], entries: [] },
                        state: {
                            supported: true,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'materialized_home', secretEntries: [] },
                    },
                    recoveryCapabilities: {
                        predictiveSoftSwitch: { mode: 'supported' },
                        runtimeAuthApply: {
                            directLiveHotAuth: { supportsInTurnApply: true },
                        },
                    },
                },
            },
        })();

        expect(hooks.getConnectedServiceRecoveryCapabilities).toBeUndefined();
    });

    it('omits the recovery capability hook when a contribution declares none', async () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['openai-codex'],
                    readConnectedServiceId: (selection: unknown) => selection === 'openai-codex' ? 'openai-codex' : null,
                    createAuthMaterializationInput: () => ({}),
                    materializeAuthEnvironment: () => ({ env: {} }),
                    stateSharingDescriptor: {
                        agentId: 'codex',
                        providerSupportStatus: 'supported',
                        config: { supported: true, modes: ['isolated'], entries: [] },
                        state: {
                            supported: true,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'materialized_home', secretEntries: [] },
                    },
                },
            },
        })();

        expect(hooks.getConnectedServiceRecoveryCapabilities).toBeUndefined();
    });

    it('declares Claude usage-limit recovery provider attribution in the plugin contribution', () => {
        const usageLimitRecovery = (
            CLAUDE_AGENT_RUNTIME_CONTRIBUTION as {
                connectedServices: {
                    usageLimitRecovery: Record<string, unknown>;
                };
            }
        ).connectedServices.usageLimitRecovery;

        expect(usageLimitRecovery).toMatchObject({
            agentId: 'claude',
            issueProviderFilter: 'claude',
            defaultNativeServiceId: 'claude-subscription',
        });
    });

    it('rejects retired usage-limit recovery provider-id contributions', async () => {
        const retiredProviderIdKey = ['provider', 'Id'].join('');
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['claude-subscription'],
                    readConnectedServiceId: (selection: unknown) => selection === 'claude-subscription' ? 'claude-subscription' : null,
                    createAuthMaterializationInput: () => ({}),
                    materializeAuthEnvironment: () => ({ env: {} }),
                    stateSharingDescriptor: {
                        agentId: 'claude',
                        providerSupportStatus: 'supported',
                        config: { supported: true, modes: ['isolated'], entries: [] },
                        state: {
                            supported: true,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'materialized_home', secretEntries: [] },
                    },
                    classifyUsageLimitError: () => null,
                    usageLimitRecovery: {
                        [retiredProviderIdKey]: 'claude',
                        issueProviderFilter: 'claude',
                        defaultNativeServiceId: 'claude-subscription',
                        fallbackBackoffEnvKey: 'HAPPIER_TEST_BACKOFF_MS',
                        maxAttemptsEnvKey: 'HAPPIER_TEST_MAX_ATTEMPTS',
                        defaultFallbackBackoffMs: 60_000,
                        defaultMaxAttempts: 3,
                    },
                },
            },
        })();

        expect(hooks).not.toHaveProperty('getSessionUsageLimitRecoveryControlAdapter');
    });

    it('lets connected-service contributions opt out of generated runtime hooks while keeping materialization', async () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['openai-codex'],
                    runtimeAuthAdapter: false,
                    readConnectedServiceId: (selection: unknown) => selection === 'openai-codex' ? 'openai-codex' : null,
                    createAuthMaterializationInput: (_serviceId: string, record: unknown) => ({ openaiCodex: record }),
                    materializeAuthEnvironment: () => ({ env: { CODEX_HOME: '/tmp/codex-home' } }),
                    stateSharingDescriptor: {
                        agentId: 'codex',
                        providerSupportStatus: 'supported',
                        config: { supported: true, modes: ['isolated'], entries: [] },
                        state: {
                            supported: true,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'materialized_home', secretEntries: [] },
                    },
                },
            },
        })();

        expect(hooks.getConnectedServicesMaterializer).toBeTypeOf('function');
        expect(hooks.getConnectedServiceRuntimeAuthAdapter).toBeUndefined();
        expect(hooks.resolveConnectedServiceSwitchContinuity).toBeUndefined();
        expect(hooks.verifyResumeReachable).toBeUndefined();
        expect(hooks).not.toHaveProperty('getSessionUsageLimitRecoveryControlAdapter');
    });

    it('passes only the host-stamped state-sharing effect to plugin-owned connected-service materializers', async () => {
        const inputs: Readonly<Record<string, unknown>>[] = [];
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-test',
            systemTools: [{
                id: 'macos-security',
                title: 'macOS Keychain security',
                executableNames: ['security'],
            }],
            contribution: {
                connectedServices: {
                    serviceIds: ['anthropic'],
                    materializedRootSubdir: 'claude-config',
                    readConnectedServiceId: (selection: unknown) => selection === 'anthropic' ? 'anthropic' : null,
                    createAuthMaterializationInput: (_serviceId: string, record: unknown) => ({ anthropic: record }),
                    materializeAuthEnvironment: (input: Readonly<Record<string, unknown>>) => {
                        inputs.push(input);
                        return { env: { CLAUDE_CONFIG_DIR: String(input.rootDir) } };
                    },
                    stateSharingDescriptor: {
                        agentId: 'claude',
                        providerSupportStatus: 'supported',
                        config: { supported: true, modes: ['isolated'], entries: [] },
                        state: {
                            supported: true,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'materialized_home', secretEntries: [] },
                    },
                    shouldRestartForServiceSwitch: (serviceId: unknown) => serviceId === 'anthropic',
                    restartRematerializeRequiredReason: 'claude_session_state_sharing_required',
                    resolveResumeReachabilityUnsupported: async () => ({ ok: false, reason: 'unsupported' }),
                    classifyUsageLimitError: () => null,
                    usageLimitRecovery: {
                        agentId: 'claude',
                        fallbackBackoffEnvKey: 'HAPPIER_TEST_BACKOFF_MS',
                        maxAttemptsEnvKey: 'HAPPIER_TEST_MAX_ATTEMPTS',
                        defaultFallbackBackoffMs: 1,
                        defaultMaxAttempts: 1,
                    },
                },
            },
        })();

        const materializer = await hooks.getConnectedServicesMaterializer?.();
        const record = buildConnectedServiceCredentialRecord({
            now: 1,
            serviceId: 'anthropic',
            profileId: 'work',
            kind: 'token',
            token: {
                token: 'sk-test',
                providerAccountId: null,
                providerEmail: null,
            },
        });
        const result = await materializer?.({
            materializationKey: 'mat-1',
            activeServerDir: '/tmp/happier-active',
            baseDir: '/tmp/happier-base',
            rootDir: '/tmp/happier-root',
            sessionDirectory: '/tmp/workspace',
            connectedAccountMaterializationAuthority:
                LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
            recordsByServiceId: new Map([['anthropic', record]]),
            accountSettings: {
                connectedServicesProviderStateSharingSettingsV1: {
                    v: 1,
                    defaults: { configMode: 'copied', stateMode: 'shared' },
                },
            },
            processEnv: { HOME: '/tmp/home' },
        });

        expect(result?.env.CLAUDE_CONFIG_DIR).toContain('claude-config');
        expect(inputs[0]).toMatchObject({
            materializationId: 'mat-1',
            rootDir: expect.stringContaining('claude-config'),
            sessionDirectory: '/tmp/workspace',
            connectedServicesSessionStateSharingRequested: true,
            processEnv: { HOME: '/tmp/home' },
            exec: expect.objectContaining({
                run: expect.any(Function),
                systemTools: expect.objectContaining({
                    resolve: expect.any(Function),
                }),
            }),
        });
        expect(inputs[0]).not.toHaveProperty('accountSettings');
        expect(inputs[0]).not.toHaveProperty('daemonControlToken');
    });

    it('projects exact qualified OpenCode purpose bindings and capability path into the catalog materializer', async () => {
        const inputs: Readonly<Record<string, unknown>>[] = [];
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'opencode',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['openai-codex', 'claude-subscription'],
                    readConnectedServiceId: () => null,
                    createAuthMaterializationInput: (serviceId: string, record: unknown) => ({
                        [serviceId === 'openai-codex' ? 'openaiCodex' : 'claudeSubscription']: record,
                    }),
                    materializeAuthEnvironment: (input: Readonly<Record<string, unknown>>) => {
                        inputs.push(input);
                        return { env: {} };
                    },
                    stateSharingDescriptor: {
                        agentId: 'opencode',
                        providerSupportStatus: 'supported',
                        config: { supported: false, modes: ['isolated'], entries: [] },
                        state: {
                            supported: false,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'materialized_home', secretEntries: [] },
                    },
                },
            },
        })();
        const materializer = await hooks.getConnectedServicesMaterializer?.();
        const record = buildConnectedServiceCredentialRecord({
            now: 1,
            serviceId: 'openai-codex',
            profileId: 'codex-work',
            kind: 'oauth',
            expiresAt: 10_000,
            oauth: {
                accessToken: 'access',
                refreshToken: 'refresh',
                idToken: null,
                scope: null,
                tokenType: 'Bearer',
                providerAccountId: 'account',
                providerEmail: null,
            },
        });
        const purposeBindings = [{
            purpose: {
                consumer: {
                    pluginId: 'happier.agent.opencode',
                    localId: 'opencode',
                },
                purpose: 'openai-codex-model-request',
            },
            target: {
                kind: 'account' as const,
                account: {
                    service: {
                        pluginId: 'happier.agent.codex',
                        localId: 'openai-codex',
                    },
                    accountId: 'codex-work',
                },
            },
        }];

        await materializer?.({
            materializationKey: 'mat-opencode-request-auth',
            activeServerDir: '/tmp/happier-active',
            baseDir: '/tmp/happier-base',
            rootDir: '/tmp/happier-root',
            recordsByServiceId: new Map([['openai-codex', record]]),
            connectedAccountMaterializationAuthority: {
                kind: 'qualified',
                purposeBindings,
                requestAuthPurposeBindings: purposeBindings,
            },
        });

        expect(inputs).toHaveLength(1);
        expect(inputs[0]?.requestAuth).toEqual({
            purposeBindings,
            capabilityPath: expect.stringContaining(
                '/request-auth/capability.json',
            ),
        });
    });

    it.each([
        'symlink',
        'foreign-owner',
    ] as const)('refuses a pre-planted %s stable target before plugin materialization effects', async (unsafeKind) => {
        if (
            process.platform === 'win32'
            || (
                unsafeKind === 'foreign-owner'
                && typeof process.getuid !== 'function'
            )
        ) {
            return;
        }
        const activeServerDir = await mkdtemp(
            join(tmpdir(), 'happier-catalog-private-root-'),
        );
        const outside = await mkdtemp(
            join(tmpdir(), 'happier-catalog-private-root-outside-'),
        );
        const stableRoot = resolveConnectedServiceHomeDir({
            activeServerDir,
            serviceId: 'openai-codex',
            profileId: 'codex-work',
            agentId: 'opencode',
        });
        const effectPath = join(
            unsafeKind === 'symlink' ? outside : stableRoot,
            'materializer-effect.txt',
        );
        const materializeEffects: string[] = [];
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'opencode',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['openai-codex'],
                    readConnectedServiceId: () => null,
                    createAuthMaterializationInput: () => ({}),
                    materializeAuthEnvironment: async (input: Readonly<Record<string, unknown>>) => {
                        const rootDir = String(input.rootDir);
                        materializeEffects.push(rootDir);
                        await writeFile(join(rootDir, 'materializer-effect.txt'), 'effect', 'utf8');
                        return { env: {} };
                    },
                    stateSharingDescriptor: {
                        agentId: 'opencode',
                        providerSupportStatus: 'supported',
                        config: { supported: false, modes: ['isolated'], entries: [] },
                        state: {
                            supported: false,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'materialized_home', secretEntries: [] },
                    },
                },
            },
        })();
        const materializer = await hooks.getConnectedServicesMaterializer?.();
        const record = buildConnectedServiceCredentialRecord({
            now: 1,
            serviceId: 'openai-codex',
            profileId: 'codex-work',
            kind: 'oauth',
            expiresAt: 10_000,
            oauth: {
                accessToken: 'access',
                refreshToken: 'refresh',
                idToken: null,
                scope: null,
                tokenType: 'Bearer',
                providerAccountId: 'account',
                providerEmail: null,
            },
        });
        let restoreGetuid: (() => void) | null = null;
        try {
            await mkdir(dirname(stableRoot), { recursive: true });
            if (unsafeKind === 'symlink') {
                await symlink(outside, stableRoot, 'dir');
            } else {
                await mkdir(stableRoot, { recursive: true });
                await chmod(stableRoot, 0o755);
                const originalGetuid = process.getuid;
                if (typeof originalGetuid !== 'function') {
                    throw new Error('process.getuid is required for the POSIX ownership test');
                }
                const actualUid = originalGetuid();
                Object.defineProperty(process, 'getuid', {
                    configurable: true,
                    value: () => actualUid + 1,
                });
                restoreGetuid = () => {
                    Object.defineProperty(process, 'getuid', {
                        configurable: true,
                        value: originalGetuid,
                    });
                };
            }

            let failure: unknown = null;
            try {
                await materializer?.({
                    materializationKey: 'mat-opencode-private-root',
                    activeServerDir,
                    baseDir: join(activeServerDir, 'materialized'),
                    rootDir: join(activeServerDir, 'unused-staging-root'),
                    connectedAccountMaterializationAuthority:
                        LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
                    recordsByServiceId: new Map([['openai-codex', record]]),
                });
            } catch (error) {
                failure = error;
            }

            expect(failure).toMatchObject({
                message: 'connected_service_materialization_root_unsafe',
            });
            expect(materializeEffects).toEqual([]);
            await expect(lstat(effectPath)).rejects.toMatchObject({
                code: 'ENOENT',
            });
        } finally {
            restoreGetuid?.();
            await Promise.all([
                rm(activeServerDir, { recursive: true, force: true }),
                rm(outside, { recursive: true, force: true }),
            ]);
        }
    });

    it('does not pass a revisioned Gemini credential to the private materializer when the session has a non-request-auth qualified purpose', async () => {
        const inputs: Readonly<Record<string, unknown>>[] = [];
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'gemini',
            packageName: '@happier-dev/plugins-gemini',
            contribution: {
                connectedServices: {
                    serviceIds: ['gemini'],
                    readConnectedServiceId: (selection: unknown) => selection === 'gemini' ? 'gemini' : null,
                    createAuthMaterializationInput: (_serviceId: string, record: unknown) => ({ gemini: record }),
                    materializeAuthEnvironment: (input: Readonly<Record<string, unknown>>) => {
                        inputs.push(input);
                        return { env: {} };
                    },
                    stateSharingDescriptor: {
                        agentId: 'gemini',
                        providerSupportStatus: 'supported',
                        config: { supported: false, modes: ['isolated'], entries: [] },
                        state: {
                            supported: false,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'process_env', secretEntries: ['GEMINI_API_KEY'] },
                    },
                },
            },
        })();
        const materializer = await hooks.getConnectedServicesMaterializer?.();
        const record = buildConnectedServiceCredentialRecord({
            now: 1,
            serviceId: 'gemini',
            profileId: 'gemini-work',
            kind: 'token',
            token: {
                token: 'must-not-reach-legacy-materializer',
                providerAccountId: null,
                providerEmail: null,
            },
        });
        const purposeBindings = [{
            purpose: {
                consumer: {
                    pluginId: 'happier.agent.gemini',
                    localId: 'gemini',
                },
                purpose: 'model_upstream',
            },
            target: {
                kind: 'account' as const,
                account: {
                    service: {
                        pluginId: 'happier.agent.gemini',
                        localId: 'gemini-account',
                    },
                    accountId: 'gemini-work',
                },
            },
        }];

        await materializer?.({
            materializationKey: 'mat-gemini-qualified',
            activeServerDir: '/tmp/happier-active',
            baseDir: '/tmp/happier-base',
            rootDir: '/tmp/happier-root',
            recordsByServiceId: new Map([['gemini', record]]),
            connectedAccountMaterializationAuthority: {
                kind: 'qualified',
                purposeBindings,
                requestAuthPurposeBindings: [],
            },
        });

        expect(inputs).toHaveLength(1);
        expect(inputs[0]).not.toHaveProperty('gemini');
        expect(inputs[0]).toMatchObject({
            connectedAccountMaterializationAuthority: 'qualified',
            rootDir: expect.any(String),
        });
        expect(inputs[0]).not.toHaveProperty('requestAuth');
    });

    // Group-bound selections thread their groupId to plugin materializers so runtime-auth
    // selection identities can be pool-scoped without generation churn.
    it('threads group ids from group selections into plugin materializer input (profile selections omit the map)', async () => {
        const inputs: Readonly<Record<string, unknown>>[] = [];
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['anthropic'],
                    materializedRootSubdir: 'claude-config',
                    readConnectedServiceId: (selection: unknown) => selection === 'anthropic' ? 'anthropic' : null,
                    createAuthMaterializationInput: (_serviceId: string, record: unknown) => ({ anthropic: record }),
                    materializeAuthEnvironment: (input: Readonly<Record<string, unknown>>) => {
                        inputs.push(input);
                        return { env: {} };
                    },
                    stateSharingDescriptor: {
                        agentId: 'claude',
                        providerSupportStatus: 'supported',
                        config: { supported: true, modes: ['isolated'], entries: [] },
                        state: {
                            supported: true,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'materialized_home', secretEntries: [] },
                    },
                },
            },
        })();

        const materializer = await hooks.getConnectedServicesMaterializer?.();
        const record = buildConnectedServiceCredentialRecord({
            now: 1,
            serviceId: 'anthropic',
            profileId: 'work',
            kind: 'token',
            token: { token: 'sk-test', providerAccountId: null, providerEmail: null },
        });

        await materializer?.({
            materializationKey: 'mat-group',
            activeServerDir: '/tmp/happier-active',
            baseDir: '/tmp/happier-base',
            rootDir: '/tmp/happier-root',
            connectedAccountMaterializationAuthority:
                LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
            recordsByServiceId: new Map([['anthropic', record]]),
            selectionsByServiceId: new Map([['anthropic', {
                kind: 'group' as const,
                serviceId: 'anthropic' as const,
                groupId: 'pool-A',
                activeProfileId: 'work',
                fallbackProfileId: 'work',
                generation: 3,
                record,
                policy: null,
            }]]),
            processEnv: { HOME: '/tmp/home' },
        });
        expect(inputs[0].connectedServiceGroupIdsByServiceId).toEqual({ anthropic: 'pool-A' });

        await materializer?.({
            materializationKey: 'mat-profile',
            activeServerDir: '/tmp/happier-active',
            baseDir: '/tmp/happier-base',
            rootDir: '/tmp/happier-root',
            connectedAccountMaterializationAuthority:
                LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
            recordsByServiceId: new Map([['anthropic', record]]),
            selectionsByServiceId: new Map([['anthropic', {
                kind: 'profile' as const,
                serviceId: 'anthropic' as const,
                profileId: 'work',
                record,
            }]]),
            processEnv: { HOME: '/tmp/home' },
        });
        expect(inputs[1].connectedServiceGroupIdsByServiceId).toBeUndefined();
    });

    it('preserves sanitized credential-refresh materialization diagnostics from plugin-owned materializers', async () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['anthropic'],
                    readConnectedServiceId: (selection: unknown) => selection === 'anthropic' ? 'anthropic' : null,
                    createAuthMaterializationInput: (_serviceId: string, record: unknown) => ({ anthropic: record }),
                    materializeAuthEnvironment: () => ({
                        env: {},
                        diagnostics: [
                            {
                                code: 'valid_diagnostic',
                                agentId: 'claude',
                                serviceId: 'anthropic',
                                severity: 'blocking',
                                reason: 'missing_required_scope',
                                credentialRefreshFailure: {
                                    category: 'provider_403',
                                    providerStatus: 403,
                                    providerErrorCode: 'claude_subscription_missing_scope',
                                },
                            },
                            {
                                code: 'invalid_refresh_metadata',
                                agentId: 'claude',
                                serviceId: 'anthropic',
                                severity: 'blocking',
                                reason: 'bad_metadata',
                                credentialRefreshFailure: {
                                    category: 'not_a_category',
                                    providerStatus: 999,
                                    providerErrorCode: 'should_be_dropped',
                                },
                            },
                        ],
                    }),
                    stateSharingDescriptor: {
                        agentId: 'claude',
                        providerSupportStatus: 'supported',
                        config: { supported: true, modes: ['isolated'], entries: [] },
                        state: {
                            supported: true,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'materialized_home', secretEntries: [] },
                    },
                    shouldRestartForServiceSwitch: (serviceId: unknown) => serviceId === 'anthropic',
                    restartRematerializeRequiredReason: 'claude_session_state_sharing_required',
                    resolveResumeReachabilityUnsupported: async () => ({ ok: false, reason: 'unsupported' }),
                    classifyUsageLimitError: () => null,
                    usageLimitRecovery: {
                        agentId: 'claude',
                        fallbackBackoffEnvKey: 'HAPPIER_TEST_BACKOFF_MS',
                        maxAttemptsEnvKey: 'HAPPIER_TEST_MAX_ATTEMPTS',
                        defaultFallbackBackoffMs: 1,
                        defaultMaxAttempts: 1,
                    },
                },
            },
        })();

        const materializer = await hooks.getConnectedServicesMaterializer?.();
        const record = buildConnectedServiceCredentialRecord({
            now: 1,
            serviceId: 'anthropic',
            profileId: 'work',
            kind: 'token',
            token: {
                token: 'sk-test',
                providerAccountId: null,
                providerEmail: null,
            },
        });
        const result = await materializer?.({
            materializationKey: 'mat-1',
            activeServerDir: '/tmp/happier-active',
            baseDir: '/tmp/happier-base',
            rootDir: '/tmp/happier-root',
            connectedAccountMaterializationAuthority:
                LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
            recordsByServiceId: new Map([['anthropic', record]]),
        });

        expect(result?.diagnostics).toEqual([
            expect.objectContaining({
                code: 'valid_diagnostic',
                credentialRefreshFailure: {
                    category: 'provider_403',
                    providerStatus: 403,
                    providerErrorCode: 'claude_subscription_missing_scope',
                },
            }),
            expect.not.objectContaining({
                credentialRefreshFailure: expect.anything(),
            }),
        ]);
    });

    it('lets Agent contributions require shared-state restarts for non-exact connected-service switches', async () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['anthropic'],
                    readConnectedServiceId: (selection: unknown) => selection === 'anthropic' ? 'anthropic' : null,
                    createAuthMaterializationInput: () => ({}),
                    materializeAuthEnvironment: () => ({ env: {} }),
                    stateSharingDescriptor: {
                        agentId: 'claude',
                        providerSupportStatus: 'supported',
                        config: { supported: true, modes: ['isolated'], entries: [] },
                        state: {
                            supported: true,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'materialized_home', secretEntries: [] },
                    },
                    shouldRestartForServiceSwitch: (serviceId: unknown) => serviceId === 'anthropic',
                    restartRematerializeRequiredReason: 'generic_rematerialize_required',
                    connectedSwitchSharedStateRequiredReason: 'claude_shared_state_required',
                    nativeSwitchSharedStateRequiredReason: 'claude_session_state_sharing_required',
                    resolveResumeReachabilityUnsupported: async () => ({ ok: false, reason: 'unsupported' }),
                    classifyUsageLimitError: () => null,
                    usageLimitRecovery: {
                        agentId: 'claude',
                        fallbackBackoffEnvKey: 'HAPPIER_TEST_BACKOFF_MS',
                        maxAttemptsEnvKey: 'HAPPIER_TEST_MAX_ATTEMPTS',
                        defaultFallbackBackoffMs: 1,
                        defaultMaxAttempts: 1,
                    },
                },
            },
        })();

        await expect(hooks.resolveConnectedServiceSwitchContinuity?.({
            sessionId: 'session-1',
            agentId: 'claude',
            serviceId: 'anthropic',
            previousBinding: {
                source: 'connected',
                selection: 'profile',
                serviceId: 'anthropic',
                profileId: 'old',
                groupId: null,
            },
            nextBinding: {
                source: 'connected',
                selection: 'profile',
                serviceId: 'anthropic',
                profileId: 'new',
                groupId: null,
            },
            fromBindings: { v: 1, bindingsByServiceId: {} },
            toBindings: { v: 1, bindingsByServiceId: {} },
        })).resolves.toEqual({
            mode: 'restart_shared_state_required',
            reason: 'claude_shared_state_required',
        });

        await expect(hooks.resolveConnectedServiceSwitchContinuity?.({
            sessionId: 'session-1',
            agentId: 'claude',
            serviceId: 'anthropic',
            previousBinding: {
                source: 'native',
                selection: 'native',
                serviceId: 'anthropic',
                profileId: null,
                groupId: null,
            },
            nextBinding: {
                source: 'connected',
                selection: 'profile',
                serviceId: 'anthropic',
                profileId: 'new',
                groupId: null,
            },
            fromBindings: { v: 1, bindingsByServiceId: {} },
            toBindings: { v: 1, bindingsByServiceId: {} },
        })).resolves.toEqual({
            mode: 'restart_shared_state_required',
            reason: 'claude_session_state_sharing_required',
        });
    });

    it('applies native exact-selection and same-auth-group reachability policy without runtime control', async () => {
        const verifyResumeReachable = vi.fn(async () => ({ ok: true as const }));
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['openai-codex'],
                    readConnectedServiceId: (selection: unknown) =>
                        selection === 'openai-codex' ? 'openai-codex' : null,
                    createAuthMaterializationInput: () => ({}),
                    materializeAuthEnvironment: () => ({ env: {} }),
                    stateSharingDescriptor: {
                        agentId: 'codex',
                        providerSupportStatus: 'supported',
                        config: { supported: true, modes: ['isolated'], entries: [] },
                        state: {
                            supported: true,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'materialized_home', secretEntries: [] },
                    },
                    shouldRestartForServiceSwitch: (serviceId: unknown) =>
                        serviceId === 'openai-codex',
                    exactSameSelectionRequiresResumeReachability: false,
                    sameAuthGroupRequiresResumeReachability: true,
                    connectedSwitchSharedStateRequiredReason: 'codex_shared_state_required',
                    verifyResumeReachable,
                },
            },
        })();
        const base = {
            sessionId: 'session-1',
            agentId: 'codex' as const,
            serviceId: 'openai-codex' as const,
            fromBindings: { v: 1 as const, bindingsByServiceId: {} },
            toBindings: { v: 1 as const, bindingsByServiceId: {} },
        };

        await expect(hooks.resolveConnectedServiceSwitchContinuity?.({
            ...base,
            previousBinding: {
                source: 'connected',
                selection: 'profile',
                serviceId: 'openai-codex',
                profileId: 'same',
                groupId: null,
            },
            nextBinding: {
                source: 'connected',
                selection: 'profile',
                serviceId: 'openai-codex',
                profileId: 'same',
                groupId: null,
            },
        })).resolves.toEqual({
            mode: 'restart_shared_state_required',
            reason: 'codex_shared_state_required',
        });
        expect(verifyResumeReachable).not.toHaveBeenCalled();

        await expect(hooks.resolveConnectedServiceSwitchContinuity?.({
            ...base,
            previousBinding: {
                source: 'connected',
                selection: 'group',
                serviceId: 'openai-codex',
                profileId: 'old',
                groupId: 'work',
            },
            nextBinding: {
                source: 'connected',
                selection: 'group',
                serviceId: 'openai-codex',
                profileId: 'new',
                groupId: 'work',
            },
        })).resolves.toEqual({
            mode: 'unsupported',
            reason: 'provider_session_state_unavailable_for_resume',
        });
    });

    it('projects native connected-service reachability without runtime-control precedence', async () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'gemini',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['gemini'],
                    readConnectedServiceId: (selection: unknown) => selection === 'gemini' ? 'gemini' : null,
                    createAuthMaterializationInput: () => ({}),
                    materializeAuthEnvironment: () => ({ env: {} }),
                    stateSharingDescriptor: {
                        agentId: 'gemini',
                        providerSupportStatus: 'unsupported',
                        authIsolation: { mode: 'process_env', secretEntries: ['GEMINI_API_KEY'] },
                    },
                    shouldRestartForServiceSwitch: (serviceId: unknown) => serviceId === 'gemini',
                    restartRematerializeRequiredReason: 'gemini_auth_environment_rematerialization_required',
                    verifyResumeReachable: async () => ({ ok: true }),
                },
            },
        })();

        expect(hooks.resolveConnectedServiceSwitchContinuity).toBeTypeOf('function');
        await expect(hooks.resolveConnectedServiceSwitchContinuity?.({
            sessionId: 'session-1',
            agentId: 'gemini',
            serviceId: 'gemini',
            previousBinding: {
                source: 'native',
                selection: 'native',
                serviceId: 'gemini',
                profileId: null,
                groupId: null,
            },
            nextBinding: {
                source: 'connected',
                selection: 'profile',
                serviceId: 'gemini',
                profileId: 'work',
                groupId: null,
            },
            fromBindings: { v: 1, bindingsByServiceId: { gemini: { source: 'native' } } },
            toBindings: {
                v: 1,
                bindingsByServiceId: {
                    gemini: { source: 'connected', selection: 'profile', profileId: 'work' },
                },
            },
        })).resolves.toEqual({
            mode: 'restart_same_home',
            reason: 'gemini_auth_environment_rematerialization_required',
        });
    });

    it('does not duplicate Gemini activation hooks through the generated Agent catalog', () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'gemini',
            packageName: '@happier-dev/plugins-gemini',
            contribution: GEMINI_AGENT_RUNTIME_CONTRIBUTION,
        })();

        expect(hooks.getDaemonSpawnHooks).toBeUndefined();
    });

    it('does not duplicate Kimi activation hooks through the generated Agent catalog', () => {
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'kimi',
            packageName: '@happier-dev/plugins-kimi',
            contribution: {},
        })();

        expect(hooks.getDaemonSpawnHooks).toBeUndefined();
    });

    it('lets plugin runtime-auth adapters select hot-apply continuity for runtime auth switches', async () => {
        const runtimeAuthSelection = {
            serviceId: 'anthropic',
            profileId: 'new',
            record: { id: 'credential-new' },
        };
        const targetMaterializedEnv = { CLAUDE_CONFIG_DIR: '/tmp/happier/claude-group' };
        const canHotApply = vi.fn(() => ({ supported: true, mode: 'plugin_hot_apply' }));
        const hooks = createAgentRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['anthropic'],
                    readConnectedServiceId: (selection: unknown) => selection === 'anthropic' ? 'anthropic' : null,
                    createAuthMaterializationInput: () => ({}),
                    materializeAuthEnvironment: () => ({ env: {} }),
                    stateSharingDescriptor: {
                        agentId: 'claude',
                        providerSupportStatus: 'supported',
                        config: { supported: true, modes: ['isolated'], entries: [] },
                        state: {
                            supported: true,
                            modes: ['isolated'],
                            entries: [],
                            symlinkUnavailableDegradePolicy: 'block_continuity',
                        },
                        authIsolation: { mode: 'materialized_home', secretEntries: [] },
                    },
                    shouldRestartForServiceSwitch: (serviceId: unknown) => serviceId === 'anthropic',
                    connectedSwitchSharedStateRequiredReason: 'claude_shared_state_required',
                    resolveResumeReachabilityUnsupported: async () => ({ ok: false, reason: 'unsupported' }),
                    classifyUsageLimitError: () => null,
                    runtimeAuthAdapter: {
                        classifyRuntimeAuthFailure: () => null,
                        materializeActiveProfile: async () => ({ supported: true }),
                        canHotApply,
                        hotApply: async () => ({ applied: true }),
                        recoverAfterRuntimeAuthSwitch: async () => ({ recovered: true }),
                        probeQuota: async () => ({ status: 'available' }),
                        refreshActiveProfile: async () => ({ status: 'available' }),
                    },
                    usageLimitRecovery: {
                        agentId: 'claude',
                        fallbackBackoffEnvKey: 'HAPPIER_TEST_BACKOFF_MS',
                        maxAttemptsEnvKey: 'HAPPIER_TEST_MAX_ATTEMPTS',
                        defaultFallbackBackoffMs: 1,
                        defaultMaxAttempts: 1,
                    },
                },
            },
        })();

        await expect(hooks.resolveConnectedServiceSwitchContinuity?.({
            sessionId: 'session-1',
            agentId: 'claude',
            serviceId: 'anthropic',
            previousBinding: {
                source: 'connected',
                selection: 'profile',
                serviceId: 'anthropic',
                profileId: 'old',
                groupId: null,
            },
            nextBinding: {
                source: 'connected',
                selection: 'profile',
                serviceId: 'anthropic',
                profileId: 'new',
                groupId: null,
            },
            fromBindings: { v: 1, bindingsByServiceId: {} },
            toBindings: { v: 1, bindingsByServiceId: {} },
            runtimeAuthSelection,
            targetMaterializedEnv,
        })).resolves.toEqual({ mode: 'hot_apply' });
        expect(canHotApply).toHaveBeenCalledWith({
            target: { agentId: 'claude' },
            selection: runtimeAuthSelection,
            targetMaterializedEnv,
            materializedEnv: targetMaterializedEnv,
        });
    });

    it('shares Codex SQLite state through one source home instead of linking database files', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-runtime-contribution-state-'));
        try {
            const nativeCodexHome = join(root, 'native-codex-home');
            const nativeSqliteHome = join(root, 'native-codex-sqlite');
            await mkdir(nativeCodexHome, { recursive: true });
            await mkdir(nativeSqliteHome, { recursive: true });
            await writeFile(join(nativeCodexHome, 'config.toml'), 'model = "gpt-5"\n', 'utf8');
            await writeFile(join(nativeSqliteHome, 'state_123.sqlite'), 'sqlite-state', 'utf8');

            const hooks = createAgentRuntimeCatalogEntryHooks({
                agentId: 'codex',
                packageName: '@happier-dev/plugins-codex',
                contribution: CODEX_AGENT_RUNTIME_CONTRIBUTION,
                systemTools: CODEX_PLUGIN_MANIFEST.contributes.systemTools,
            })();
            const materializer = await hooks.getConnectedServicesMaterializer?.();
            const record = buildConnectedServiceCredentialRecord({
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

            const materialized = await materializer?.({
                materializationKey: 'mat-1',
                activeServerDir: root,
                baseDir: root,
                rootDir: root,
                connectedAccountMaterializationAuthority:
                    LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
                recordsByServiceId: new Map([['openai-codex', record]]),
                accountSettings: accountSettingsParse({
                    connectedServicesProviderStateSharingSettingsV1: {
                        v: 1,
                        defaults: { configMode: 'copied', stateMode: 'shared' },
                    },
                }),
                processEnv: {
                    HOME: join(root, 'home'),
                    CODEX_HOME: nativeCodexHome,
                    CODEX_SQLITE_HOME: nativeSqliteHome,
                },
            });

            const targetRoot = materialized?.targetMaterializedRoot;
            expect(typeof targetRoot).toBe('string');
            const configToml = await readFile(join(String(targetRoot), 'config.toml'), 'utf8');
            expect(configToml).toContain('model = "gpt-5"');
            expect(configToml).toContain('cli_auth_credentials_store = "file"');
            expect(materialized?.env.CODEX_SQLITE_HOME).toBe(nativeSqliteHome);
            await expect(lstat(join(String(targetRoot), 'state_123.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('imports existing Codex materialized session files before switching to shared state', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-runtime-contribution-import-'));
        try {
            const nativeCodexHome = join(root, 'native-codex-home');
            await mkdir(nativeCodexHome, { recursive: true });

            const hooks = createAgentRuntimeCatalogEntryHooks({
                agentId: 'codex',
                packageName: '@happier-dev/plugins-codex',
                contribution: CODEX_AGENT_RUNTIME_CONTRIBUTION,
                systemTools: CODEX_PLUGIN_MANIFEST.contributes.systemTools,
            })();
            const materializer = await hooks.getConnectedServicesMaterializer?.();
            const record = buildConnectedServiceCredentialRecord({
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
            const sharedAccountSettings = accountSettingsParse({
                connectedServicesProviderStateSharingSettingsV1: {
                    v: 1,
                    defaults: { configMode: 'copied', stateMode: 'shared' },
                },
            });

            const firstMaterialized = await materializer?.({
                materializationKey: 'mat-1',
                activeServerDir: root,
                baseDir: root,
                rootDir: root,
                connectedAccountMaterializationAuthority:
                    LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
                recordsByServiceId: new Map([['openai-codex', record]]),
                accountSettings: sharedAccountSettings,
                processEnv: {
                    HOME: join(root, 'home'),
                    CODEX_HOME: nativeCodexHome,
                },
            });
            const targetRoot = String(firstMaterialized?.targetMaterializedRoot);
            const localSessionPath = join(
                targetRoot,
                'sessions',
                'rollout-00000000-0000-0000-0000-000000000001.jsonl',
            );
            await mkdir(join(targetRoot, 'sessions'), { recursive: true });
            await writeFile(localSessionPath, '{"type":"session"}\n', 'utf8');

            await materializer?.({
                materializationKey: 'mat-2',
                activeServerDir: root,
                baseDir: root,
                rootDir: root,
                connectedAccountMaterializationAuthority:
                    LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
                recordsByServiceId: new Map([['openai-codex', record]]),
                accountSettings: sharedAccountSettings,
                processEnv: {
                    HOME: join(root, 'home'),
                    CODEX_HOME: nativeCodexHome,
                },
            });

            await expect(readFile(
                join(nativeCodexHome, 'sessions', 'rollout-00000000-0000-0000-0000-000000000001.jsonl'),
                'utf8',
            )).resolves.toBe('{"type":"session"}\n');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

});
