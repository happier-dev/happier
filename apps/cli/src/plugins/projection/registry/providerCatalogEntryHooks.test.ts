import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountSettingsParse, buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-claude/agent/contributions/runtime';
import { CODEX_PROVIDER_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-codex/agent/contributions/runtime';
import { GEMINI_PROVIDER_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-gemini/agent/contributions/runtime';
import { KIMI_PROVIDER_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-kimi/agent/contributions/runtime';
import { OH_MY_PI_PROVIDER_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-ohmypi/agent/contributions/runtime';
import { PI_PROVIDER_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-pi/agent/contributions/runtime';
import type { ExternalSessionTranscriptStoreAdapterV1 } from '@happier-dev/plugin-sdk/sessions';

import type { ApiClient } from '@/api/api';
import type { TrackedSession } from '@/daemon/types';
import { resolveConnectedServiceGroupHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import type { Credentials } from '@/persistence';
import type { ExternalSessionCandidateHostAdapter } from '@/session/external/candidates/host';
import type { ExternalSessionTranscriptStoreAdapter } from '@/session/external/transcripts/store';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { openBrowser } from '@/ui/openBrowser';
import {
    createCliSessionCommandHandler,
    createProviderRuntimeCatalogEntryHooks,
    readCliSessionCommandContribution,
} from './providerCatalogEntryHooks';

vi.mock('@/ui/openBrowser', () => ({
    openBrowser: vi.fn(async () => true),
}));

function writeFakeClaudeBinary(dir: string, helpText: string): string {
    const isWindows = process.platform === 'win32';
    const fileName = isWindows ? 'claude.cmd' : 'claude';
    const contents = isWindows
        ? [
            '@echo off',
            'set args=%*',
            'echo %args% | findstr /c:"--help" >nul',
            'if %errorlevel%==0 (',
            ...helpText.split(/\r?\n/).map((line) => `  echo ${line}`),
            '  exit /b 0',
            ')',
            'exit /b 0',
        ].join('\r\n')
        : [
            '#!/bin/sh',
            'for arg in "$@"; do',
            '  if [ "$arg" = "--help" ]; then',
            '    cat <<\'EOF\'',
            helpText,
            'EOF',
            '    exit 0',
            '  fi',
            'done',
            'exit 0',
        ].join('\n');
    return writeExecutableShimSync({ dir, fileName, contents });
}

describe('createProviderRuntimeCatalogEntryHooks', () => {
    beforeEach(() => {
        vi.mocked(openBrowser).mockReset();
        vi.mocked(openBrowser).mockResolvedValue(true);
    });

    it('preserves Claude config source precedence for connected-service state sharing', () => {
        const connectedServices = (
            CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION as {
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
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-claude',
            contribution: CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION,
        })();
        const contributedFreshness = (
            CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION as {
                connectedServices: {
                    isMaterializedHomeStale: unknown;
                };
            }
        ).connectedServices.isMaterializedHomeStale;

        await expect(hooks.getConnectedServiceMaterializedHomeFreshness?.()).resolves.toEqual({
            isMaterializedHomeStale: contributedFreshness,
        });
    });

    it('uses plugin-provided CLI auth hooks ahead of built-in auth parsing', async () => {
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'kiro',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                builtInAcpCatalog: true,
                cliAuth: {
                    detectAuthStatus: async () => ({
                        state: 'logged_in',
                        method: 'oauth_cli',
                        source: 'mixed',
                        accountLabel: 'plugin-auth@example.com',
                    }),
                },
            },
        })();

        const spec = await hooks.getCliAuthSpec?.();
        expect(spec?.binaryNames).toEqual(['kiro-cli']);
        await expect(spec?.detectAuthStatus?.({ resolvedPath: '/missing-kiro' })).resolves.toMatchObject({
            state: 'logged_in',
            method: 'oauth_cli',
            source: 'mixed',
            accountLabel: 'plugin-auth@example.com',
        });
    });

    it('projects Pi CLI catalog residuals from the Pi runtime contribution', async () => {
        const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
        const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
        try {
            process.env.OPENAI_API_KEY = 'sk-pi-test';
            delete process.env.ANTHROPIC_API_KEY;

            const hooks = createProviderRuntimeCatalogEntryHooks({
                agentId: 'pi',
                packageName: '@happier-dev/plugins-pi',
                contribution: PI_PROVIDER_RUNTIME_CONTRIBUTION,
            })();

            expect(hooks.getCliCommandHandler).toBeTypeOf('function');
            expect(hooks.checklists).toEqual({});

            await expect(hooks.getCliDetect?.()).resolves.toEqual({
                versionArgsToTry: [['--version'], ['version'], ['-v']],
                loginStatusArgs: null,
            });

            const authSpec = await hooks.getCliAuthSpec?.();
            expect(authSpec?.binaryNames).toEqual(['pi']);
            await expect(authSpec?.detectAuthStatus?.({ resolvedPath: '/bin/pi' })).resolves.toMatchObject({
                state: 'logged_in',
                method: 'api_key_env',
                source: 'env',
            });
        } finally {
            if (originalOpenAiApiKey === undefined) {
                delete process.env.OPENAI_API_KEY;
            } else {
                process.env.OPENAI_API_KEY = originalOpenAiApiKey;
            }
            if (originalAnthropicApiKey === undefined) {
                delete process.env.ANTHROPIC_API_KEY;
            } else {
                process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
            }
        }
    });

    it('projects external-session host adapters from runtime contributions', async () => {
        const transcriptStoreAdapter: ExternalSessionTranscriptStoreAdapter = Object.freeze({
            providerId: 'codex' as const,
            withStore: async () => {
                throw new Error('not used');
            },
            acquireStore: async () => {
                throw new Error('not used');
            },
        });
        const candidateHostAdapter: ExternalSessionCandidateHostAdapter = Object.freeze({
            providerId: 'codex' as const,
            listViaChildHost: vi.fn(),
        });
        const createTranscriptStoreAdapter = vi.fn(() => transcriptStoreAdapter);
        const createCandidateHostAdapter = vi.fn(() => candidateHostAdapter);
        const env = { HOME: '/tmp/home' } as NodeJS.ProcessEnv;
        const contributionWithExternalSessions: Parameters<typeof createProviderRuntimeCatalogEntryHooks>[0]['contribution'] = {
            externalSessions: {
                createTranscriptStoreAdapter,
                createCandidateHostAdapter,
            },
        };

        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-codex',
            contribution: contributionWithExternalSessions,
        })();

        const adapters = await hooks.getExternalSessionRuntimeHostAdapters?.({
            activeServerDir: '/tmp/server',
            env,
        });

        expect(createTranscriptStoreAdapter).toHaveBeenCalledWith(expect.objectContaining({
            activeServerDir: '/tmp/server',
            env,
            exec: expect.objectContaining({
                run: expect.any(Function),
                spawnClient: expect.any(Function),
            }),
        }));
        expect(createCandidateHostAdapter).toHaveBeenCalledWith(expect.objectContaining({
            activeServerDir: '/tmp/server',
            env,
            exec: expect.objectContaining({
                run: expect.any(Function),
                spawnClient: expect.any(Function),
            }),
        }));
        expect(adapters?.transcriptStores).toEqual([transcriptStoreAdapter]);
        expect(adapters?.candidateHosts).toEqual([candidateHostAdapter]);
    });

    it('adapts public external-session transcript services to host transcript stores', async () => {
        const unsubscribe = vi.fn();
        const release = vi.fn(async () => undefined);
        const publicTranscriptStoreAdapter: ExternalSessionTranscriptStoreAdapterV1 = Object.freeze({
            providerId: 'codex',
            getActivity: vi.fn(async () => ({ lastActivityAtMs: 123, isRunning: false })),
            page: vi.fn(async () => ({
                items: [],
                nextCursor: 'next-page',
                tailCursor: 'tail-page',
                hasMore: false,
                truncated: false,
            })),
            readAfter: vi.fn(async () => ({
                items: [],
                nextCursor: 'next-read',
                tailCursor: 'tail-read',
                truncated: false,
            })),
            acquireFollowLease: vi.fn(async () => ({
                release,
                getTailCursor: () => 'lease-tail',
                subscribeToTranscriptUpdates: vi.fn(() => unsubscribe),
            })),
            resolveFollowTranscriptPath: vi.fn(async () => ({ path: '/tmp/codex/transcript.jsonl', sourceId: 'thread-1' })),
            getWorkingDirectory: vi.fn(async () => '/repo'),
            getProviderHome: vi.fn(async () => '/tmp/codex'),
        });
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-codex',
            contribution: {
                externalSessions: {
                    createTranscriptStoreAdapter: () => publicTranscriptStoreAdapter,
                },
            },
        })();

        const adapters = await hooks.getExternalSessionRuntimeHostAdapters?.({
            activeServerDir: '/tmp/server',
            env: { HOME: '/tmp/home' } as NodeJS.ProcessEnv,
        });
        const transcriptStore = adapters?.transcriptStores?.[0];
        expect(transcriptStore).toEqual(expect.objectContaining({ providerId: 'codex' }));

        const key = {
            providerId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            providerSessionId: 'thread-1',
        } as const;
        await transcriptStore?.withStore(key, async (store) => {
            await expect(store.pageOlder({ cursor: 'before', maxBytes: 50, maxItems: 2 })).resolves.toEqual({
                items: [],
                nextCursor: 'next-page',
                hasMore: false,
                tailCursor: 'tail-page',
                truncated: false,
            });
            await expect(store.readAfter({ cursor: 'tail-page', maxBytes: 50, maxItems: 2 })).resolves.toEqual({
                items: [],
                nextCursor: 'next-read',
                truncated: false,
            });
            await expect(store.getActivity()).resolves.toEqual({ lastActivityAtMs: 123, isRunning: false });
            await expect(store.getWorkingDirectory()).resolves.toBe('/repo');
        });

        expect(publicTranscriptStoreAdapter.page).toHaveBeenCalledWith({
            ...key,
            direction: 'older',
            cursor: 'before',
            maxBytes: 50,
            maxItems: 2,
        });
        expect(publicTranscriptStoreAdapter.readAfter).toHaveBeenCalledWith({
            ...key,
            cursor: 'tail-page',
            maxBytes: 50,
            maxItems: 2,
        });

        const lease = await transcriptStore?.acquireStore({ ...key, reason: 'attached_view' });
        expect(lease?.key).toEqual({
            providerId: 'codex',
            source: key.source,
            remoteSessionId: 'thread-1',
        });
        expect(lease?.store.getTailCursor()).toBe('lease-tail');
        lease?.store.subscribe();
        await lease?.release();
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('projects the bundled OhMyPi external-session transcript store adapter', async () => {
        const env = { PI_CODING_AGENT_DIR: '/tmp/ohmypi-agent-dir' } as NodeJS.ProcessEnv;
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'ohMyPi',
            packageName: '@happier-dev/plugins-ohmypi',
            contribution: OH_MY_PI_PROVIDER_RUNTIME_CONTRIBUTION as Parameters<
                typeof createProviderRuntimeCatalogEntryHooks
            >[0]['contribution'],
        })();

        const adapters = await hooks.getExternalSessionRuntimeHostAdapters?.({
            activeServerDir: '/tmp/server',
            env,
        });

        expect(adapters?.transcriptStores).toEqual([
            expect.objectContaining({ providerId: 'ohMyPi' }),
        ]);
        expect(adapters?.candidateHosts).toEqual([]);
    });

    it('drops invalid implicit resume delegation descriptors while keeping CLI command dispatch', () => {
        const contribution = readCliSessionCommandContribution({
            backendIdForSessionRuntime: 'claude',
            implicitResumeDelegation: {
                resumeFlags: ['', 123, null],
            },
        }, 'claude');

        expect(contribution).toMatchObject({
            backendIdForSessionRuntime: 'claude',
        });
        expect(contribution).not.toHaveProperty('implicitResumeDelegation');
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
            backendIdForSessionRuntime: 'claude',
            implicitResumeDelegation: { resumeFlags: ['--resume', '-r'] },
        }, 'claude', {
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
            backendIdForSessionRuntime: 'claude',
        }, 'claude', {
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
            backendIdForSessionRuntime: 'claude',
            implicitResumeDelegation: { resumeFlags: ['--resume', '-r'] },
        }, 'claude', {
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

    it('projects a provider-owned ACP backend spec through a generic runtime definition bridge', async () => {
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-test',
            systemTools: [{
                toolId: 'codex-acp',
                displayName: 'Codex ACP',
                source: 'system',
                lookupNames: ['codex-acp'],
                defaultArgs: [],
            }],
            contribution: {
                acpBackend: {
                    createSpec: ({ cwd }: Readonly<{ cwd: string; env: NodeJS.ProcessEnv }>) => ({
                        backendId: 'codex',
                        transport: {
                            kind: 'stdio',
                            launch: {
                                kind: 'system-tool',
                                toolId: 'codex-acp',
                                purpose: 'Run Codex ACP',
                                preferredCommand: 'codex-acp',
                            },
                        },
                        ux: { title: 'Codex' },
                        callbacks: {
                            envBuilder: () => ({ CODEX_PROJECT_DIR: cwd }),
                        },
                    }),
                },
            },
        })();

        const bridge = await hooks.getAcpRuntimeDefinitionBridge?.();
        const definition = bridge?.createDefinition({
            cwd: '/workspace/codex-project',
            env: {},
        });

        expect(bridge?.exec.systemTools.resolve).toEqual(expect.any(Function));
        expect(definition).toMatchObject({
            backendId: 'codex',
            source: { kind: 'plugin_contributed' },
            transport: {
                kind: 'stdio',
                launch: {
                    kind: 'system-tool',
                    toolId: 'codex-acp',
                },
            },
        });
        expect(definition?.callbacks.envBuilder?.({
            cwd: '/ignored-after-create',
            env: {},
        })).toEqual({ CODEX_PROJECT_DIR: '/workspace/codex-project' });
    });

    it('passes mediated context to plugin-provided cloud connect custom authenticators', async () => {
        let capturedOptions: unknown = null;
        let capturedContext: unknown = null;
        const credentialWriteInputs: unknown[] = [];
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                cloudConnect: {
                    displayName: 'Codex',
                    vendorDisplayName: 'OpenAI Codex',
                    vendorKey: 'openai',
                    status: 'wired',
                    customAuthenticator: {
                        authenticate: async (opts: unknown, context: unknown) => {
                            capturedOptions = opts;
                            capturedContext = context;
                            const typedContext = context as Readonly<{
                                credentials: Readonly<{
                                    write(input: Readonly<Record<string, unknown>>): Promise<Readonly<{
                                        ok: boolean;
                                        credentialRef?: string;
                                    }>>;
                                }>;
                            }>;
                            const writeResult = await typedContext.credentials.write({
                                serviceId: 'openai-codex',
                                profileId: 'work',
                                record: { kind: 'oauth' },
                            });
                            return {
                                ok: true,
                                credentialRef: writeResult.credentialRef,
                                diagnostics: [
                                    {
                                        code: 'provider-note',
                                        message: 'accessToken=secret-provider-token',
                                    },
                                ],
                            };
                        },
                    },
                },
            },
        })();

        const target = await hooks.getCloudConnectTarget?.();

        expect(target).toMatchObject({
            id: 'codex',
            displayName: 'Codex',
            vendorDisplayName: 'OpenAI Codex',
            vendorKey: 'openai',
            status: 'wired',
        });
        await expect(target?.authenticate({
            device: true,
            noOpen: true,
            hostServices: {
                credentials: {
                    write: async (input) => {
                        credentialWriteInputs.push(input);
                        return { ok: true, credentialRef: 'openai-codex/work' };
                    },
                },
            },
        }))
            .resolves.toEqual({
                ok: true,
                credentialRef: 'openai-codex/work',
                diagnostics: [
                    {
                        code: 'provider-note',
                        message: expect.not.stringContaining('secret-provider-token'),
                    },
                ],
            });
        expect(capturedOptions).toEqual({ device: true, noOpen: true });
        expect(credentialWriteInputs).toEqual([
            {
                serviceId: 'openai-codex',
                profileId: 'work',
                record: { kind: 'oauth' },
            },
        ]);
        expect(capturedContext).toEqual(expect.objectContaining({
            signal: expect.any(AbortSignal),
            now: expect.any(Function),
            fetch: expect.any(Function),
            browser: expect.objectContaining({ open: expect.any(Function) }),
            prompt: expect.objectContaining({ requestText: expect.any(Function) }),
            oauth: expect.objectContaining({
                createPkceChallenge: expect.any(Function),
                callback: expect.objectContaining({ create: expect.any(Function) }),
            }),
            credentials: expect.objectContaining({ write: expect.any(Function) }),
            diagnostics: expect.objectContaining({
                info: expect.any(Function),
                warn: expect.any(Function),
            }),
        }));
        expect(capturedContext).not.toEqual(expect.objectContaining({
            openBrowser: expect.any(Function),
            promptInput: expect.any(Function),
        }));
    });

    it('cancels mediated custom-auth credential writes when the provided signal is already aborted', async () => {
        const credentialWriteInputs: unknown[] = [];
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                cloudConnect: {
                    displayName: 'Codex',
                    vendorDisplayName: 'OpenAI Codex',
                    vendorKey: 'openai',
                    status: 'wired',
                    customAuthenticator: {
                        authenticate: async (_opts: unknown, context: unknown) => {
                            const typedContext = context as Readonly<{
                                credentials: Readonly<{
                                    write(input: Readonly<Record<string, unknown>>): Promise<Readonly<{
                                        ok: boolean;
                                        code?: string;
                                    }>>;
                                }>;
                            }>;
                            const writeResult = await typedContext.credentials.write({
                                serviceId: 'openai-codex',
                                profileId: 'work',
                                record: { kind: 'oauth' },
                            });
                            return writeResult.ok
                                ? { ok: true, credentialRef: 'unexpected' }
                                : { ok: false, code: writeResult.code ?? 'failed' };
                        },
                    },
                },
            },
        })();

        const controller = new AbortController();
        controller.abort();
        const target = await hooks.getCloudConnectTarget?.();

        await expect(target?.authenticate({
            signal: controller.signal,
            hostServices: {
                credentials: {
                    write: async (input) => {
                        credentialWriteInputs.push(input);
                        return { ok: true, credentialRef: 'openai-codex/work' };
                    },
                },
            },
        }))
            .resolves.toEqual({ ok: false, code: 'cancelled' });
        expect(credentialWriteInputs).toEqual([]);
    });

    it('reports mediated browser open as unsupported when the host declines to open a browser', async () => {
        vi.mocked(openBrowser).mockResolvedValue(false);
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                cloudConnect: {
                    displayName: 'Codex',
                    vendorDisplayName: 'OpenAI Codex',
                    vendorKey: 'openai',
                    status: 'wired',
                    customAuthenticator: {
                        authenticate: async (_opts: unknown, context: unknown) => {
                            const typedContext = context as Readonly<{
                                browser: Readonly<{
                                    open(url: string): Promise<unknown>;
                                }>;
                            }>;
                            return await typedContext.browser.open('https://auth.example.test/login');
                        },
                    },
                },
            },
        })();

        const target = await hooks.getCloudConnectTarget?.();

        await expect(target?.authenticate({ noOpen: true })).resolves.toMatchObject({
            ok: false,
            code: 'unsupported',
            diagnostics: [
                expect.objectContaining({
                    code: 'browser_open_unavailable',
                }),
            ],
        });
        expect(openBrowser).toHaveBeenCalledWith('https://auth.example.test/login');
    });

    it('rejects cloud connect contributions with unknown vendor keys', async () => {
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                cloudConnect: {
                    displayName: 'Codex',
                    vendorDisplayName: 'OpenAI Codex',
                    vendorKey: 'not-a-vendor',
                    status: 'wired',
                    customAuthenticator: {
                        authenticate: async () => ({ authenticatedBy: 'plugin' }),
                    },
                },
            },
        })();

        expect(hooks.getCloudConnectTarget).toBeUndefined();
    });


    it('projects callable preflight probes and cache variants from runtime contributions', async () => {
        const probeInputs: ReadonlyArray<Readonly<Record<string, unknown>>>[] = [];
        const variantInputs: Readonly<Record<string, unknown>>[] = [];
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                preflightSessionControls: {
                    failureCacheStrategy: 'retry',
                    needsAccountSettings: true,
                    resolveProbeVariant: (input: Readonly<{
                        probeKind?: unknown;
                        accountSettings?: Readonly<Record<string, unknown>> | null;
                    }>) => {
                        variantInputs.push(input);
                        return `plugin:${String(input.probeKind)}:${String(input.accountSettings?.runtimeFlavor ?? 'default')}`;
                    },
                    probeModelsRaw: async (params: Readonly<Record<string, unknown>>) => {
                        probeInputs.push([params]);
                        return [{ id: 'model-from-plugin', name: 'Model from plugin' }];
                    },
                    probeModesRaw: async (params: Readonly<Record<string, unknown>>) => {
                        probeInputs.push([params]);
                        return [{ id: 'mode-from-plugin', name: 'Mode from plugin' }];
                    },
                    probeConfigOptionsRaw: async (params: Readonly<Record<string, unknown>>) => {
                        probeInputs.push([params]);
                        return [{ id: 'config-from-plugin', name: 'Config from plugin' }];
                    },
                },
            },
        })();

        expect(hooks.needsAccountSettingsForProbes).toBe(true);
        expect(hooks.resolveModelsProbeVariant?.({
            backendTarget: undefined,
            accountSettings: { runtimeFlavor: 'app-server' },
            probeKind: 'models',
        })).toBe('plugin:models:app-server');
        expect((hooks as unknown as {
            resolveSessionControlsProbeVariant?: typeof hooks.resolveModelsProbeVariant;
        }).resolveSessionControlsProbeVariant?.({
            backendTarget: undefined,
            accountSettings: { runtimeFlavor: 'app-server' },
            probeKind: 'configOptions',
        })).toBe('plugin:configOptions:app-server');
        expect(variantInputs[0]).toEqual(expect.objectContaining({ probeKind: 'models' }));

        const adapter = await hooks.getPreflightSessionControlsProbeAdapter?.();
        expect(adapter?.failureCacheStrategy).toBe('retry');
        await expect(adapter?.probeModelsRaw?.({
            cwd: '/workspace',
            timeoutMs: 1_500,
            backendTarget: undefined,
            accountSettings: { runtimeFlavor: 'app-server' },
            env: { CODEX_HOME: '/tmp/preflight-codex-home' } as any,
        })).resolves.toEqual([{ id: 'model-from-plugin', name: 'Model from plugin' }]);
        await expect(adapter?.probeModesRaw?.({
            cwd: '/workspace',
            timeoutMs: 1_500,
            backendTarget: undefined,
            accountSettings: null,
        })).resolves.toEqual([{ id: 'mode-from-plugin', name: 'Mode from plugin' }]);
        await expect(adapter?.probeConfigOptionsRaw?.({
            cwd: '/workspace',
            timeoutMs: 1_500,
            backendTarget: undefined,
            accountSettings: null,
        })).resolves.toEqual([{ id: 'config-from-plugin', name: 'Config from plugin' }]);
        expect(probeInputs[0]?.[0]).toEqual(expect.objectContaining({
            cwd: '/workspace',
            timeoutMs: 1_500,
            accountSettings: { runtimeFlavor: 'app-server' },
            exec: expect.objectContaining({
                spawnClient: expect.any(Function),
            }),
            env: expect.objectContaining({
                CODEX_HOME: '/tmp/preflight-codex-home',
            }),
            probeKind: 'models',
        }));
        expect(probeInputs[1]?.[0]).toEqual(expect.objectContaining({ probeKind: 'modes' }));
        expect(probeInputs[2]?.[0]).toEqual(expect.objectContaining({ probeKind: 'configOptions' }));
    });

    it('projects Codex account-settings-aware preflight hooks from the plugin runtime contribution', async () => {
        const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
        try {
            process.env.OPENAI_API_KEY = 'sk-test';
            const hooks = createProviderRuntimeCatalogEntryHooks({
                agentId: 'codex',
                packageName: '@happier-dev/plugins-codex',
                contribution: CODEX_PROVIDER_RUNTIME_CONTRIBUTION,
            })();

            expect(hooks.needsAccountSettingsForProbes).toBe(true);
            expect(hooks.resolveModelsProbeVariant?.({
                backendTarget: undefined,
                accountSettings: null,
            })).toBe('codex:appServer');
            expect(hooks.resolveModelsProbeVariant?.({
                backendTarget: undefined,
                accountSettings: { codexBackendMode: 'acp' },
            })).toBe('codex:acp');

            const adapter = await hooks.getPreflightSessionControlsProbeAdapter?.();
            expect(adapter?.failureCacheStrategy).toBe('retry');
            expect(adapter?.probeModelsRaw).toBeTypeOf('function');
            expect(adapter?.probeModesRaw).toBeTypeOf('function');
            expect(adapter?.probeConfigOptionsRaw).toBeTypeOf('function');
        } finally {
            if (previousOpenAiApiKey === undefined) {
                delete process.env.OPENAI_API_KEY;
            } else {
                process.env.OPENAI_API_KEY = previousOpenAiApiKey;
            }
        }
    });

    it('projects Codex daemon auth bridge refresh through the plugin runtime contribution', async () => {
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-codex',
            contribution: CODEX_PROVIDER_RUNTIME_CONTRIBUTION,
        })() as ReturnType<ReturnType<typeof createProviderRuntimeCatalogEntryHooks>> & {
            getConnectedServiceDaemonAuthBridgeRefresh?: () => Promise<((input: Readonly<{
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
        }));

        const refresh = await hooks.getConnectedServiceDaemonAuthBridgeRefresh?.();

        await expect(refresh?.({
            serviceId: 'openai-codex',
            request: {
                sessionId: 'sess_codex',
                selection: {
                    kind: 'profile',
                    serviceId: 'openai-codex',
                    profileId: 'codex-profile',
                },
                chatgptPlanType: 'plus',
                forceRefresh: true,
            },
            refreshCoordinator: { refreshOpenAiCodexChatGptTokensForBridge } as never,
        })).resolves.toEqual({
            accessToken: 'codex-access',
            chatgptAccountId: 'acct_123',
            chatgptPlanType: 'plus',
        });
        expect(refreshOpenAiCodexChatGptTokensForBridge).toHaveBeenCalledWith({
            selection: {
                kind: 'profile',
                serviceId: 'openai-codex',
                profileId: 'codex-profile',
            },
            chatgptPlanType: 'plus',
            forceRefresh: true,
        });
    });

    it('projects connected-service quota fetchers through the plugin runtime contribution', async () => {
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-codex',
            contribution: CODEX_PROVIDER_RUNTIME_CONTRIBUTION,
        })() as ReturnType<ReturnType<typeof createProviderRuntimeCatalogEntryHooks>> & {
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

    it('projects Claude readiness hooks from the plugin runtime contribution', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-hooks-'));
        const previousClaudePath = process.env.HAPPIER_CLAUDE_PATH;
        const previousPath = process.env.PATH;
        const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        const previousHappierClaudeConfigDir = process.env.HAPPIER_CLAUDE_CONFIG_DIR;
        const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
        const previousAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
        try {
            const fakeClaude = writeFakeClaudeBinary(
                root,
                '  --effort <level>  Effort level for the current session (low, medium, high, xhigh, max)',
            );
            const claudeConfigDir = join(root, '.claude');
            await mkdir(claudeConfigDir, { recursive: true });
            await writeFile(
                join(claudeConfigDir, '.credentials.json'),
                JSON.stringify({
                    accessToken: 'claude-token',
                    email: 'claude-plugin-auth@example.test',
                }),
                'utf8',
            );
            process.env.HAPPIER_CLAUDE_PATH = fakeClaude;
            process.env.PATH = '/usr/bin:/bin';
            process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
            delete process.env.HAPPIER_CLAUDE_CONFIG_DIR;
            delete process.env.ANTHROPIC_API_KEY;
            delete process.env.ANTHROPIC_AUTH_TOKEN;

            const hooks = createProviderRuntimeCatalogEntryHooks({
                agentId: 'claude',
                packageName: '@happier-dev/plugins-claude',
                contribution: CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION,
            })();

            const connectTarget = await hooks.getCloudConnectTarget?.();
            expect(connectTarget).toMatchObject({
                id: 'claude',
                displayName: 'Claude',
                vendorDisplayName: 'Anthropic Claude',
                vendorKey: 'anthropic',
                status: 'wired',
            });
            expect(connectTarget?.authenticate).toBeTypeOf('function');

            const authSpec = await hooks.getCliAuthSpec?.();
            await expect(authSpec?.detectAuthStatus?.({ resolvedPath: fakeClaude })).resolves.toMatchObject({
                state: 'logged_in',
                method: 'credentials_file',
                source: 'file',
                accountLabel: 'claude-plugin-auth@example.test',
            });

            expect(hooks.normalizeSessionControlPermissionMode?.('safe-yolo')).toBe('acceptEdits');
            expect(hooks.normalizeSessionControlPermissionMode?.('yolo')).toBe('bypassPermissions');
            expect(hooks.normalizeSessionControlPermissionMode?.('plan')).toBe('plan');

            const transform = await hooks.getHeadlessTmuxArgvTransform?.();
            expect(transform?.(['--foo'])).toEqual(['--foo', '--happy-starting-mode', 'remote']);

            const promptSubmitVerification = await hooks.getTerminalPromptSubmitVerificationPolicy?.();
            expect(promptSubmitVerification?.shouldVerifyBeforeSubmit('first\nsecond')).toBe(false);
            expect(promptSubmitVerification?.shouldVerifyAfterSubmit('first\nsecond')).toBe(true);
            expect(promptSubmitVerification?.verifyAfterSubmit({
                promptText: 'first\nsecond',
                screenText: '❯ [Pasted text #1 +1 line]',
            })).toBe(true);

            const adapter = await hooks.getPreflightSessionControlsProbeAdapter?.();
            expect(adapter?.failureCacheStrategy).toBe('cooldown');
            expect(adapter?.probeModelsRaw).toBeTypeOf('function');

            const models = await adapter?.probeModelsRaw?.({
                cwd: root,
                timeoutMs: 1_500,
                backendTarget: undefined,
                accountSettings: null,
            });
            expect(models).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    id: 'claude-fable-5',
                    modelOptions: expect.arrayContaining([
                        expect.objectContaining({ id: 'reasoning_effort' }),
                    ]),
                }),
                expect.objectContaining({
                    id: 'claude-opus-4-8',
                    modelOptions: expect.arrayContaining([
                        expect.objectContaining({ id: 'reasoning_effort' }),
                    ]),
                }),
            ]));
        } finally {
            if (previousClaudePath === undefined) {
                delete process.env.HAPPIER_CLAUDE_PATH;
            } else {
                process.env.HAPPIER_CLAUDE_PATH = previousClaudePath;
            }
            if (previousPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = previousPath;
            }
            if (previousClaudeConfigDir === undefined) {
                delete process.env.CLAUDE_CONFIG_DIR;
            } else {
                process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
            }
            if (previousHappierClaudeConfigDir === undefined) {
                delete process.env.HAPPIER_CLAUDE_CONFIG_DIR;
            } else {
                process.env.HAPPIER_CLAUDE_CONFIG_DIR = previousHappierClaudeConfigDir;
            }
            if (previousAnthropicApiKey === undefined) {
                delete process.env.ANTHROPIC_API_KEY;
            } else {
                process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
            }
            if (previousAnthropicAuthToken === undefined) {
                delete process.env.ANTHROPIC_AUTH_TOKEN;
            } else {
                process.env.ANTHROPIC_AUTH_TOKEN = previousAnthropicAuthToken;
            }
            await rm(root, { recursive: true, force: true });
        }
    });

    it('projects Claude daemon auth bridge refresh through the plugin runtime contribution', async () => {
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-claude',
            contribution: CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION,
        })() as ReturnType<ReturnType<typeof createProviderRuntimeCatalogEntryHooks>> & {
            getConnectedServiceDaemonAuthBridgeRefresh?: () => Promise<((input: Readonly<{
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

        const refresh = await hooks.getConnectedServiceDaemonAuthBridgeRefresh?.();

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
            },
            refreshCoordinator: { refreshClaudeSubscriptionTokensForBridge } as never,
        })).resolves.toEqual({
            accessToken: 'claude-access',
            anthropicAccountId: 'anthropic-acct',
            expiresAt: null,
        });
        expect(refreshClaudeSubscriptionTokensForBridge).toHaveBeenCalledWith({
            selection: {
                kind: 'profile',
                serviceId: 'claude-subscription',
                profileId: 'claude-profile',
            },
            forceRefresh: false,
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
        const hooks = createProviderRuntimeCatalogEntryHooks({
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

    it('projects Pi connected-service hooks from the plugin runtime contribution', async () => {
        expect(PI_PROVIDER_RUNTIME_CONTRIBUTION.connectedServices.usageLimitRecovery).toMatchObject({
            agentId: 'pi',
        });

        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'pi',
            packageName: '@happier-dev/plugins-pi',
            contribution: PI_PROVIDER_RUNTIME_CONTRIBUTION as Parameters<
                typeof createProviderRuntimeCatalogEntryHooks
            >[0]['contribution'],
        })();

        expect(hooks.getConnectedServicesMaterializer).toBeTypeOf('function');
        expect(hooks.materializeConnectedServiceRuntimeAuthSelection).toBeTypeOf('function');
        expect(hooks.getConnectedServiceRuntimeAuthAdapter).toBeTypeOf('function');
        expect(hooks.getConnectedServiceStateSharingDescriptor).toBeTypeOf('function');
        expect(hooks.getConnectedServiceRecoveryCapabilities).toBeTypeOf('function');
        expect(hooks.getSessionUsageLimitRecoveryControlAdapter).toBeTypeOf('function');
        expect(hooks.resolveConnectedServiceSwitchContinuity).toBeTypeOf('function');
        expect(hooks.verifyResumeReachable).toBeTypeOf('function');
        expect(hooks.resolveConnectedServiceCandidatePersistedSessionFile).toBeTypeOf('function');

        await expect(hooks.getConnectedServiceRecoveryCapabilities?.()).resolves.toEqual({
            predictiveSoftSwitch: { mode: 'unsupported' },
        });
        await expect(hooks.getConnectedServiceStateSharingDescriptor?.()).resolves.toMatchObject({
            providerId: 'pi',
            authIsolation: {
                mode: 'materialized_home',
                secretEntries: expect.arrayContaining(['auth.json']),
            },
        });
    });

    it('projects OhMyPi connected-service hooks from the plugin runtime contribution', async () => {
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'ohMyPi',
            packageName: '@happier-dev/plugins-ohmypi',
            contribution: OH_MY_PI_PROVIDER_RUNTIME_CONTRIBUTION as Parameters<
                typeof createProviderRuntimeCatalogEntryHooks
            >[0]['contribution'],
        })();

        expect(hooks.getConnectedServicesMaterializer).toBeTypeOf('function');
        expect(hooks.materializeConnectedServiceRuntimeAuthSelection).toBeTypeOf('function');
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
            recordsByServiceId: new Map([['openai', record]]),
            processEnv: { HOME: '/tmp/home' },
        });

        expect(result?.env).toEqual({ OPENAI_API_KEY: 'sk-test' });
        expect(result?.targetMaterializedRoot).toContain('ohmypi-auth');
    });

    it('threads usage-limit recovery provider attribution into the generic backoff adapter', async () => {
        const hooks = createProviderRuntimeCatalogEntryHooks({
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

        const adapter = await hooks.getSessionUsageLimitRecoveryControlAdapter?.();
        const baseParams = {
            token: 'token',
            sessionId: 'sess_1',
            metadata: {},
            currentMachineId: 'machine-local',
            sessionMachineId: 'machine-local',
            cwd: '/repo',
            ctx: {
                encryptionKey: new Uint8Array(32).fill(1),
                encryptionVariant: 'legacy' as const,
            },
            mode: 'plain' as const,
        };
        const buildRawSession = (provider: string) => ({
            id: 'sess_1',
            active: false,
            path: '/repo',
            machineId: 'machine-local',
            metadata: '{}',
            metadataVersion: 1,
            encryptionMode: 'plain',
            latestTurnStatus: 'failed',
            lastRuntimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'usage_limit',
                source: 'usage_limit',
                provider,
                providerTurnId: 'turn-1',
                occurredAt: 1_700_000_000_000,
                usageLimit: {
                    v: 1,
                    resetAtMs: 1_700_000_060_000,
                    retryAfterMs: null,
                    quotaScope: 'account',
                    recoverability: 'wait',
                },
            },
        }) as unknown as Parameters<NonNullable<NonNullable<typeof adapter>['checkNow']>>[0]['rawSession'];

        await expect(adapter?.checkNow?.({
            ...baseParams,
            rawSession: buildRawSession('codex'),
        })).resolves.toMatchObject({
            ok: false,
            errorCode: 'session_usage_limit_recovery_control_inactive',
        });

        await expect(adapter?.checkNow?.({
            ...baseParams,
            rawSession: buildRawSession('claude'),
        })).resolves.toMatchObject({
            ok: true,
            metadata: {
                sessionUsageLimitRecoveryV1: {
                    selectedAuth: {
                        kind: 'native',
                        serviceId: 'claude-subscription',
                    },
                },
            },
        });
    });

    it('projects runtime-control usage-limit reset consumption adapters', async () => {
        const checkNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));
        const consumeResetCredit = vi.fn(async () => ({ ok: true, status: 'waiting' }));
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                runtimeControl: {
                    usageLimitRecovery: {
                        checkNow,
                        consumeResetCredit,
                    },
                },
            },
        })();

        const adapter = await hooks.getSessionUsageLimitRecoveryControlAdapter?.();
        type AdapterParams = Parameters<NonNullable<NonNullable<typeof adapter>['consumeResetCredit']>>[0];
        const params = {
            token: 'token',
            sessionId: 'sess_1',
            rawSession: { id: 'sess_1', metadata: '{}' } as unknown as AdapterParams['rawSession'],
            metadata: {},
            currentMachineId: 'machine-local',
            sessionMachineId: 'machine-local',
            cwd: '/repo',
            ctx: {
                encryptionKey: new Uint8Array(32).fill(1),
                encryptionVariant: 'legacy' as const,
            },
            mode: 'plain' as const,
        } satisfies AdapterParams;

        await expect(adapter?.consumeResetCredit?.(params)).resolves.toEqual({ ok: true, status: 'waiting' });
        expect(checkNow).not.toHaveBeenCalled();
        expect(consumeResetCredit).toHaveBeenCalledTimes(1);
    });

    it('projects declared connected-service recovery capability descriptors', async () => {
        const hooks = createProviderRuntimeCatalogEntryHooks({
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

        const claudeHooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-claude',
            contribution: CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION as Parameters<
                typeof createProviderRuntimeCatalogEntryHooks
            >[0]['contribution'],
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
        const hooks = createProviderRuntimeCatalogEntryHooks({
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
        const hooks = createProviderRuntimeCatalogEntryHooks({
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
            CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION as {
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
        const hooks = createProviderRuntimeCatalogEntryHooks({
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

        expect(hooks.getSessionUsageLimitRecoveryControlAdapter).toBeUndefined();
    });

    it('lets connected-service contributions opt out of generated runtime hooks while keeping materialization', async () => {
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'codex',
            packageName: '@happier-dev/plugins-test',
            contribution: {
                connectedServices: {
                    serviceIds: ['openai-codex'],
                    runtimeAuthAdapter: false,
                    materializeRuntimeAuthSelection: false,
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
        expect(hooks.materializeConnectedServiceRuntimeAuthSelection).toBeUndefined();
        expect(hooks.getConnectedServiceRuntimeAuthAdapter).toBeUndefined();
        expect(hooks.resolveConnectedServiceSwitchContinuity).toBeUndefined();
        expect(hooks.verifyResumeReachable).toBeUndefined();
        expect(hooks.getSessionUsageLimitRecoveryControlAdapter).toBeUndefined();
    });

    it('passes host materialization context to plugin-owned connected-service materializers', async () => {
        const inputs: Readonly<Record<string, unknown>>[] = [];
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'claude',
            packageName: '@happier-dev/plugins-test',
            systemTools: [{
                toolId: 'claude.macos.security',
                displayName: 'macOS Keychain security',
                source: 'system',
                lookupNames: ['security'],
                defaultArgs: [],
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
            recordsByServiceId: new Map([['anthropic', record]]),
            accountSettings: { connectedServicesProviderStateSharingSettingsV1: {} },
            processEnv: { HOME: '/tmp/home' },
        });

        expect(result?.env.CLAUDE_CONFIG_DIR).toContain('claude-config');
        expect(inputs[0]).toMatchObject({
            rootDir: expect.stringContaining('claude-config'),
            sessionDirectory: '/tmp/workspace',
            accountSettings: { connectedServicesProviderStateSharingSettingsV1: {} },
            processEnv: { HOME: '/tmp/home' },
            exec: expect.objectContaining({
                run: expect.any(Function),
                systemTools: expect.objectContaining({
                    resolve: expect.any(Function),
                }),
            }),
        });
    });

    // R4-4/F3: group-bound selections thread their groupId to plugin materializers so broker
    // selection identities can be pool-scoped (WITHOUT generation) at the single mint owner.
    it('threads group ids from group selections into plugin materializer input (profile selections omit the map)', async () => {
        const inputs: Readonly<Record<string, unknown>>[] = [];
        const hooks = createProviderRuntimeCatalogEntryHooks({
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
        const hooks = createProviderRuntimeCatalogEntryHooks({
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

    it('lets provider contributions require shared-state restarts for non-exact connected-service switches', async () => {
        const hooks = createProviderRuntimeCatalogEntryHooks({
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

    it('keeps connected-service restart continuity when runtime control only contributes resume reachability', async () => {
        const hooks = createProviderRuntimeCatalogEntryHooks({
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
                },
                runtimeControl: {
                    connectedServices: {
                        verifyResumeReachable: async () => ({ ok: true }),
                    },
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

    it('projects Gemini daemon spawn hooks so missing auth fails before ACP launch', async () => {
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'gemini',
            packageName: '@happier-dev/plugins-gemini',
            contribution: GEMINI_PROVIDER_RUNTIME_CONTRIBUTION,
        })();

        const daemonSpawnHooks = await hooks.getDaemonSpawnHooks?.();
        expect(daemonSpawnHooks?.resolveRuntimePrerequisites).toBeTypeOf('function');
        await expect(daemonSpawnHooks?.resolveRuntimePrerequisites?.({
            providerRuntimeSelection: { geminiBackendMode: 'acp' },
            env: {},
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'gemini_acp_credentials_unavailable',
            errorMessage: expect.stringContaining('GEMINI_API_KEY'),
        });
    });

    it('projects Kimi daemon spawn hooks so incompatible ACP CLIs fail before ACP launch', async () => {
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'kimi',
            packageName: '@happier-dev/plugins-kimi',
            contribution: KIMI_PROVIDER_RUNTIME_CONTRIBUTION,
        })();
        const runSystemTool = vi.fn(async () => ({
            ok: true as const,
            command: '/usr/local/bin/kimi',
            args: ['--work-dir', '/repo', 'acp'],
            source: 'system' as const,
            exitCode: 1,
            signal: null,
            stdout: '',
            stderr: 'error: unknown option --work-dir\n',
        }));

        const daemonSpawnHooks = await hooks.getDaemonSpawnHooks?.();
        expect(daemonSpawnHooks?.resolveRuntimePrerequisites).toBeTypeOf('function');
        await expect(daemonSpawnHooks?.resolveRuntimePrerequisites?.({
            cwd: '/repo',
            tools: {
                signal: new AbortController().signal,
                resolveSystemTool: vi.fn(async () => ({
                    ok: false as const,
                    reasonCode: 'tool_unavailable' as const,
                    errorMessage: 'unused',
                })),
                runSystemTool,
                resolveManagedInstallable: vi.fn(async () => ({
                    ok: false as const,
                    reasonCode: 'installable_unavailable' as const,
                    errorMessage: 'unused',
                })),
                diagnostics: {
                    info: vi.fn(),
                    warn: vi.fn(),
                },
            },
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'kimi_acp_unavailable',
            errorMessage: expect.stringContaining('ACP-compatible Kimi CLI'),
        });
    });

    it('lets plugin runtime-auth adapters select hot-apply continuity for runtime auth switches', async () => {
        const runtimeAuthSelection = {
            serviceId: 'anthropic',
            profileId: 'new',
            record: { id: 'credential-new' },
        };
        const targetMaterializedEnv = { CLAUDE_CONFIG_DIR: '/tmp/happier/claude-group' };
        const canHotApply = vi.fn(() => ({ supported: true, mode: 'plugin_hot_apply' }));
        const hooks = createProviderRuntimeCatalogEntryHooks({
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

    it('applies provider state-sharing descriptors when materializing runtime auth selections', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-selection-'));
        try {
            const activeServerDir = join(root, 'active-server');
            const nativeConfigRoot = join(root, 'native-config');
            const sessionDirectory = join(root, 'workspace');
            await mkdir(nativeConfigRoot, { recursive: true });
            await mkdir(sessionDirectory, { recursive: true });
            await writeFile(join(nativeConfigRoot, 'settings.json'), '{"theme":"dark"}\n');

            const hooks = createProviderRuntimeCatalogEntryHooks({
                agentId: 'claude',
                packageName: '@happier-dev/plugins-test',
                contribution: {
                    connectedServices: {
                        serviceIds: ['anthropic'],
                        materializedRootSubdir: 'claude-config',
                        resolveStateSharingSourceRoot: () => nativeConfigRoot,
                        readConnectedServiceId: (selection: unknown) => selection === 'anthropic' ? 'anthropic' : null,
                        createAuthMaterializationInput: (_serviceId: string, record: unknown) => ({ anthropic: record }),
                        materializeAuthEnvironment: (input: Readonly<Record<string, unknown>>) => ({
                            env: {
                                ANTHROPIC_API_KEY: 'sk-test',
                                CLAUDE_CONFIG_DIR: String(input.rootDir),
                            },
                        }),
                        stateSharingDescriptor: {
                            agentId: 'claude',
                            providerSupportStatus: 'supported',
                            config: {
                                supported: true,
                                modes: ['linked', 'copied', 'isolated'],
                                entries: [{ path: 'settings.json', mode: 'linked_or_copied' }],
                            },
                            state: {
                                supported: true,
                                modes: ['isolated', 'shared'],
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
            const materialized = await hooks.materializeConnectedServiceRuntimeAuthSelection?.({
                activeServerDir,
                // ApiClient and Credentials are not read by the retained runtime selection materializer.
                api: {} as unknown as ApiClient,
                credentials: {} as Credentials,
                processEnv: { HOME: join(root, 'home') },
                accountSettings: accountSettingsParse({
                    connectedServicesProviderStateSharingSettingsV1: {
                        v: 1,
                        defaults: { configMode: 'copied', stateMode: 'isolated' },
                    },
                }),
                baseSelection: {
                    serviceId: 'anthropic',
                    binding: { selection: 'profile' },
                    profileId: 'work',
                    record,
                },
                input: {
                    mode: 'apply',
                    tracked: {
                        startedBy: 'daemon',
                        happySessionId: 'session-1',
                        pid: 123,
                        spawnOptions: {
                            directory: sessionDirectory,
                            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                            connectedServices: { v: 1, bindingsByServiceId: {} },
                            environmentVariables: {},
                        },
                    } satisfies TrackedSession,
                    sessionId: 'session-1',
                    agentId: 'claude',
                    serviceId: 'anthropic',
                    previous: null,
                    next: {
                        source: 'connected',
                        selection: 'profile',
                        serviceId: 'anthropic',
                        profileId: 'work',
                        groupId: null,
                    },
                    previousBindings: { v: 1, bindingsByServiceId: {} },
                    normalizedBindings: { v: 1, bindingsByServiceId: {} },
                },
            });

            const targetRoot = (materialized as { targetMaterializedRoot?: unknown }).targetMaterializedRoot;
            expect(typeof targetRoot).toBe('string');
            await expect(readFile(join(String(targetRoot), 'settings.json'), 'utf8')).resolves.toBe('{"theme":"dark"}\n');
            expect((materialized as { materializationDiagnostics?: unknown }).materializationDiagnostics).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('preflights shared group runtime-auth selections without materializing provider state', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-selection-preflight-'));
        try {
            const activeServerDir = join(root, 'active-server');
            const nativeConfigRoot = join(root, 'native-config');
            const sessionDirectory = join(root, 'workspace');
            await mkdir(nativeConfigRoot, { recursive: true });
            await mkdir(sessionDirectory, { recursive: true });
            const resolveStateSharingSourceRoot = vi.fn(() => nativeConfigRoot);
            const materializeAuthEnvironment = vi.fn(() => {
                throw new Error('preflight must not materialize provider auth');
            });
            const hooks = createProviderRuntimeCatalogEntryHooks({
                agentId: 'claude',
                packageName: '@happier-dev/plugins-test',
                contribution: {
                    connectedServices: {
                        serviceIds: ['claude-subscription'],
                        materializedRootSubdir: 'claude-config',
                        resolveStateSharingSourceRoot,
                        readConnectedServiceId: (selection: unknown) =>
                            selection === 'claude-subscription' ? 'claude-subscription' : null,
                        createAuthMaterializationInput: (_serviceId: string, record: unknown) => ({ claude: record }),
                        materializeAuthEnvironment,
                        stateSharingDescriptor: {
                            agentId: 'claude',
                            providerSupportStatus: 'supported',
                            config: {
                                supported: true,
                                modes: ['linked', 'copied', 'isolated'],
                                entries: [{ path: 'settings.json', mode: 'linked_or_copied' }],
                            },
                            state: {
                                supported: true,
                                modes: ['isolated', 'shared'],
                                entries: [],
                                symlinkUnavailableDegradePolicy: 'block_continuity',
                            },
                            authIsolation: { mode: 'materialized_home', secretEntries: [] },
                        },
                        recoveryCapabilities: {
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
                        },
                    },
                },
            })();
            const record = buildConnectedServiceCredentialRecord({
                now: 1,
                serviceId: 'claude-subscription',
                profileId: 'work',
                kind: 'token',
                token: {
                    token: 'sk-test',
                    providerAccountId: null,
                    providerEmail: null,
                },
            });
            const expectedRoot = join(resolveConnectedServiceGroupHomeDir({
                activeServerDir,
                serviceId: 'claude-subscription',
                groupId: 'anthropic-cloud',
                agentId: 'claude',
            }), 'claude-config');

            const materialized = await hooks.materializeConnectedServiceRuntimeAuthSelection?.({
                activeServerDir,
                api: {} as unknown as ApiClient,
                credentials: {} as Credentials,
                processEnv: { HOME: join(root, 'home') },
                accountSettings: accountSettingsParse({
                    connectedServicesProviderStateSharingSettingsV1: {
                        v: 1,
                        defaults: { configMode: 'copied', stateMode: 'shared' },
                    },
                }),
                baseSelection: {
                    serviceId: 'claude-subscription',
                    binding: { selection: 'group' },
                    profileId: 'new-profile',
                    groupId: 'anthropic-cloud',
                    activeProfileId: 'new-profile',
                    fallbackProfileId: 'previous-profile',
                    record,
                },
                input: {
                    mode: 'preflight',
                    tracked: {
                        startedBy: 'daemon',
                        happySessionId: 'session-1',
                        pid: 123,
                        spawnOptions: {
                            directory: sessionDirectory,
                            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                            connectedServices: { v: 1, bindingsByServiceId: {} },
                            environmentVariables: { CLAUDE_CONFIG_DIR: expectedRoot },
                        },
                    } satisfies TrackedSession,
                    sessionId: 'session-1',
                    agentId: 'claude',
                    serviceId: 'claude-subscription',
                    previous: null,
                    next: {
                        source: 'connected',
                        selection: 'group',
                        serviceId: 'claude-subscription',
                        profileId: 'new-profile',
                        groupId: 'anthropic-cloud',
                    },
                    previousBindings: { v: 1, bindingsByServiceId: {} },
                    normalizedBindings: { v: 1, bindingsByServiceId: {} },
                },
            });

            expect((materialized as { targetMaterializedRoot?: unknown }).targetMaterializedRoot).toBe(expectedRoot);
            expect((materialized as { targetMaterializedEnv?: unknown }).targetMaterializedEnv).toEqual({
                CLAUDE_CONFIG_DIR: expectedRoot,
            });
            expect((materialized as { materializationDiagnostics?: unknown }).materializationDiagnostics).toEqual([]);
            expect(resolveStateSharingSourceRoot).not.toHaveBeenCalled();
            expect(materializeAuthEnvironment).not.toHaveBeenCalled();
            await expect(readFile(join(expectedRoot, '.credentials.json'), 'utf8')).rejects.toThrow();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('does not expose shared group hot-apply selection when the live Claude runtime is on another config dir', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-selection-profile-'));
        try {
            const activeServerDir = join(root, 'active-server');
            const sessionDirectory = join(root, 'workspace');
            await mkdir(sessionDirectory, { recursive: true });
            const materializeAuthEnvironment = vi.fn(() => {
                throw new Error('preflight must not materialize provider auth');
            });
            const hooks = createProviderRuntimeCatalogEntryHooks({
                agentId: 'claude',
                packageName: '@happier-dev/plugins-test',
                contribution: {
                    connectedServices: {
                        serviceIds: ['claude-subscription'],
                        materializedRootSubdir: 'claude-config',
                        readConnectedServiceId: (selection: unknown) =>
                            selection === 'claude-subscription' ? 'claude-subscription' : null,
                        createAuthMaterializationInput: (_serviceId: string, record: unknown) => ({ claude: record }),
                        materializeAuthEnvironment,
                        stateSharingDescriptor: {
                            agentId: 'claude',
                            providerSupportStatus: 'supported',
                            config: {
                                supported: true,
                                modes: ['linked', 'copied', 'isolated'],
                                entries: [],
                            },
                            state: {
                                supported: true,
                                modes: ['isolated', 'shared'],
                                entries: [],
                            },
                            authIsolation: { mode: 'materialized_home', secretEntries: [] },
                        },
                        recoveryCapabilities: {
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
                        },
                    },
                },
            })();
            const record = buildConnectedServiceCredentialRecord({
                now: 1,
                serviceId: 'claude-subscription',
                profileId: 'new-profile',
                kind: 'token',
                token: {
                    token: 'sk-test',
                    providerAccountId: null,
                    providerEmail: null,
                },
            });

            const materialized = await hooks.materializeConnectedServiceRuntimeAuthSelection?.({
                activeServerDir,
                api: {} as unknown as ApiClient,
                credentials: {} as Credentials,
                processEnv: { HOME: join(root, 'home') },
                baseSelection: {
                    serviceId: 'claude-subscription',
                    binding: { selection: 'group' },
                    profileId: 'new-profile',
                    groupId: 'anthropic-cloud',
                    activeProfileId: 'new-profile',
                    fallbackProfileId: 'previous-profile',
                    record,
                },
                input: {
                    mode: 'preflight',
                    tracked: {
                        startedBy: 'daemon',
                        happySessionId: 'session-1',
                        pid: 123,
                        spawnOptions: {
                            directory: sessionDirectory,
                            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                            connectedServices: { v: 1, bindingsByServiceId: {} },
                            environmentVariables: { CLAUDE_CONFIG_DIR: join(root, 'profile-home', 'claude-config') },
                        },
                    } satisfies TrackedSession,
                    sessionId: 'session-1',
                    agentId: 'claude',
                    serviceId: 'claude-subscription',
                    previous: null,
                    next: {
                        source: 'connected',
                        selection: 'group',
                        serviceId: 'claude-subscription',
                        profileId: 'new-profile',
                        groupId: 'anthropic-cloud',
                    },
                    previousBindings: { v: 1, bindingsByServiceId: {} },
                    normalizedBindings: { v: 1, bindingsByServiceId: {} },
                },
            });

            expect((materialized as { targetMaterializedRoot?: unknown }).targetMaterializedRoot).toBeUndefined();
            expect((materialized as { targetMaterializedEnv?: unknown }).targetMaterializedEnv).toBeUndefined();
            expect(materializeAuthEnvironment).not.toHaveBeenCalled();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('returns shared group runtime-auth metadata in apply mode without rewriting the live group home', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-selection-live-'));
        try {
            const activeServerDir = join(root, 'active-server');
            const sessionDirectory = join(root, 'workspace');
            await mkdir(sessionDirectory, { recursive: true });
            const materializeAuthEnvironment = vi.fn(() => {
                throw new Error('shared-surface hot apply must own credential writes');
            });
            const hooks = createProviderRuntimeCatalogEntryHooks({
                agentId: 'claude',
                packageName: '@happier-dev/plugins-test',
                contribution: {
                    connectedServices: {
                        serviceIds: ['claude-subscription'],
                        materializedRootSubdir: 'claude-config',
                        readConnectedServiceId: (selection: unknown) =>
                            selection === 'claude-subscription' ? 'claude-subscription' : null,
                        createAuthMaterializationInput: (_serviceId: string, record: unknown) => ({ claude: record }),
                        materializeAuthEnvironment,
                        stateSharingDescriptor: {
                            agentId: 'claude',
                            providerSupportStatus: 'supported',
                            config: {
                                supported: true,
                                modes: ['linked', 'copied', 'isolated'],
                                entries: [],
                            },
                            state: {
                                supported: true,
                                modes: ['isolated', 'shared'],
                                entries: [],
                            },
                            authIsolation: { mode: 'materialized_home', secretEntries: [] },
                        },
                        recoveryCapabilities: {
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
                        },
                    },
                },
            })();
            const record = buildConnectedServiceCredentialRecord({
                now: 1,
                serviceId: 'claude-subscription',
                profileId: 'new-profile',
                kind: 'token',
                token: {
                    token: 'sk-test',
                    providerAccountId: null,
                    providerEmail: null,
                },
            });
            const expectedRoot = join(resolveConnectedServiceGroupHomeDir({
                activeServerDir,
                serviceId: 'claude-subscription',
                groupId: 'anthropic-cloud',
                agentId: 'claude',
            }), 'claude-config');

            const materialized = await hooks.materializeConnectedServiceRuntimeAuthSelection?.({
                activeServerDir,
                api: {} as unknown as ApiClient,
                credentials: {} as Credentials,
                processEnv: { HOME: join(root, 'home') },
                baseSelection: {
                    serviceId: 'claude-subscription',
                    binding: { selection: 'group' },
                    profileId: 'new-profile',
                    groupId: 'anthropic-cloud',
                    activeProfileId: 'new-profile',
                    fallbackProfileId: 'previous-profile',
                    record,
                },
                input: {
                    mode: 'apply',
                    tracked: {
                        startedBy: 'daemon',
                        happySessionId: 'session-1',
                        pid: 123,
                        spawnOptions: {
                            directory: sessionDirectory,
                            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                            connectedServices: { v: 1, bindingsByServiceId: {} },
                            environmentVariables: { CLAUDE_CONFIG_DIR: expectedRoot },
                        },
                    } satisfies TrackedSession,
                    sessionId: 'session-1',
                    agentId: 'claude',
                    serviceId: 'claude-subscription',
                    previous: null,
                    next: {
                        source: 'connected',
                        selection: 'group',
                        serviceId: 'claude-subscription',
                        profileId: 'new-profile',
                        groupId: 'anthropic-cloud',
                    },
                    previousBindings: { v: 1, bindingsByServiceId: {} },
                    normalizedBindings: { v: 1, bindingsByServiceId: {} },
                },
            });

            expect((materialized as { targetMaterializedRoot?: unknown }).targetMaterializedRoot).toBe(expectedRoot);
            expect((materialized as { targetMaterializedEnv?: unknown }).targetMaterializedEnv).toEqual({
                CLAUDE_CONFIG_DIR: expectedRoot,
            });
            expect(materializeAuthEnvironment).not.toHaveBeenCalled();
            await expect(readFile(join(expectedRoot, '.credentials.json'), 'utf8')).rejects.toThrow();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('carries Claude shared project state from the previous materialized profile during runtime auth selection switches', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-shared-state-'));
        try {
            const activeServerDir = join(root, 'active-server');
            const previousClaudeConfigDir = join(root, 'previous-profile-claude-config');
            const sessionDirectory = join(root, 'workspace');
            const vendorResumeId = 'f55b3644-befc-406a-90ac-b8fbcc33cbf6';
            await mkdir(join(previousClaudeConfigDir, 'projects', 'workspace'), { recursive: true });
            await mkdir(sessionDirectory, { recursive: true });
            await writeFile(
                join(previousClaudeConfigDir, 'projects', 'workspace', `${vendorResumeId}.jsonl`),
                '{"session":"previous-profile"}\n',
            );
            await writeFile(
                join(previousClaudeConfigDir, '.credentials.json'),
                '{"claudeAiOauth":{"accessToken":"old-access-token","refreshToken":"old-refresh-token","scopes":[]}}\n',
            );
            const securityPath = writeExecutableShimSync({
                dir: root,
                fileName: process.platform === 'win32' ? 'security.cmd' : 'security',
                contents: process.platform === 'win32'
                    ? '@echo off\r\nexit /b 0\r\n'
                    : '#!/bin/sh\nexit 0\n',
            });

            const hooks = createProviderRuntimeCatalogEntryHooks({
                agentId: 'claude',
                packageName: '@happier-dev/plugins-claude',
                contribution: CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION,
                systemTools: [
                    {
                        toolId: 'claude.macos.security',
                        displayName: 'macOS Keychain security',
                        source: 'system',
                        executablePath: securityPath,
                        lookupNames: ['security'],
                        defaultArgs: [],
                    },
                ],
            })();
            const record = buildConnectedServiceCredentialRecord({
                now: 1,
                serviceId: 'claude-subscription',
                profileId: 'new-profile',
                kind: 'oauth',
                expiresAt: 2_000,
                oauth: {
                    accessToken: 'new-access-token',
                    refreshToken: 'new-refresh-token',
                    idToken: null,
                    providerAccountId: null,
                    providerEmail: null,
                    scope: 'user:profile user:inference user:sessions:claude_code',
                    tokenType: 'Bearer',
                },
            });

            const materialized = await hooks.materializeConnectedServiceRuntimeAuthSelection?.({
                activeServerDir,
                api: {} as unknown as ApiClient,
                credentials: {} as Credentials,
                processEnv: { HOME: join(root, 'home') },
                accountSettings: accountSettingsParse({
                    connectedServicesProviderStateSharingSettingsV1: {
                        v: 1,
                        defaults: { configMode: 'isolated', stateMode: 'isolated' },
                        byAgentId: {
                            claude: { configMode: 'isolated', stateMode: 'shared' },
                        },
                    },
                }),
                baseSelection: {
                    serviceId: 'claude-subscription',
                    binding: { selection: 'group' },
                    profileId: 'new-profile',
                    groupId: 'anthropic-cloud',
                    activeProfileId: 'new-profile',
                    fallbackProfileId: 'previous-profile',
                    record,
                },
                input: {
                    mode: 'apply',
                    tracked: {
                        startedBy: 'daemon',
                        happySessionId: 'session-1',
                        pid: 123,
                        vendorResumeId,
                        spawnOptions: {
                            directory: sessionDirectory,
                            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                            connectedServices: { v: 1, bindingsByServiceId: {} },
                            environmentVariables: {
                                CLAUDE_CONFIG_DIR: previousClaudeConfigDir,
                                HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: JSON.stringify(['CLAUDE_CONFIG_DIR']),
                            },
                        },
                    } satisfies TrackedSession,
                    sessionId: 'session-1',
                    agentId: 'claude',
                    serviceId: 'claude-subscription',
                    previous: {
                        source: 'connected',
                        selection: 'profile',
                        serviceId: 'claude-subscription',
                        profileId: 'previous-profile',
                        groupId: 'anthropic-cloud',
                    },
                    next: {
                        source: 'connected',
                        selection: 'group',
                        serviceId: 'claude-subscription',
                        profileId: 'new-profile',
                        groupId: 'anthropic-cloud',
                    },
                    previousBindings: { v: 1, bindingsByServiceId: {} },
                    normalizedBindings: { v: 1, bindingsByServiceId: {} },
                },
            });

            const targetRoot = (materialized as { targetMaterializedRoot?: unknown }).targetMaterializedRoot;
            expect(typeof targetRoot).toBe('string');
            await expect(readFile(
                join(String(targetRoot), 'projects', 'workspace', `${vendorResumeId}.jsonl`),
                'utf8',
            )).resolves.toBe('{"session":"previous-profile"}\n');
            const targetCredential = await readFile(join(String(targetRoot), '.credentials.json'), 'utf8');
            expect(targetCredential).toContain('new-access-token');
            expect(targetCredential).not.toContain('old-access-token');
            const exec = (materialized as { exec?: unknown }).exec;
            expect(exec).toEqual(expect.objectContaining({
                run: expect.any(Function),
                systemTools: expect.objectContaining({
                    resolve: expect.any(Function),
                }),
            }));
            expect((materialized as { materializationDiagnostics?: unknown }).materializationDiagnostics).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('keeps isolated Claude runtime-auth materialization fail-closed instead of importing source session files', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-isolated-state-'));
        try {
            const activeServerDir = join(root, 'active-server');
            const previousClaudeConfigDir = join(root, 'previous-profile-claude-config');
            const sessionDirectory = join(root, 'workspace');
            const vendorResumeId = 'f55b3644-befc-406a-90ac-b8fbcc33cbf6';
            await mkdir(join(previousClaudeConfigDir, 'projects', 'workspace'), { recursive: true });
            await mkdir(sessionDirectory, { recursive: true });
            await writeFile(
                join(previousClaudeConfigDir, 'projects', 'workspace', `${vendorResumeId}.jsonl`),
                '{"session":"previous-profile"}\n',
            );
            const securityPath = writeExecutableShimSync({
                dir: root,
                fileName: process.platform === 'win32' ? 'security.cmd' : 'security',
                contents: process.platform === 'win32'
                    ? '@echo off\r\nexit /b 0\r\n'
                    : '#!/bin/sh\nexit 0\n',
            });

            const hooks = createProviderRuntimeCatalogEntryHooks({
                agentId: 'claude',
                packageName: '@happier-dev/plugins-claude',
                contribution: CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION,
                systemTools: [
                    {
                        toolId: 'claude.macos.security',
                        displayName: 'macOS Keychain security',
                        source: 'system',
                        executablePath: securityPath,
                        lookupNames: ['security'],
                        defaultArgs: [],
                    },
                ],
            })();
            const record = buildConnectedServiceCredentialRecord({
                now: 1,
                serviceId: 'claude-subscription',
                profileId: 'new-profile',
                kind: 'oauth',
                expiresAt: 2_000,
                oauth: {
                    accessToken: 'new-access-token',
                    refreshToken: 'new-refresh-token',
                    idToken: null,
                    providerAccountId: null,
                    providerEmail: null,
                    scope: 'user:profile user:inference user:sessions:claude_code',
                    tokenType: 'Bearer',
                },
            });

            const materialized = await hooks.materializeConnectedServiceRuntimeAuthSelection?.({
                activeServerDir,
                api: {} as unknown as ApiClient,
                credentials: {} as Credentials,
                processEnv: { HOME: join(root, 'home') },
                accountSettings: accountSettingsParse({
                    connectedServicesProviderStateSharingSettingsV1: {
                        v: 1,
                        defaults: { configMode: 'isolated', stateMode: 'isolated' },
                        byAgentId: {
                            claude: { configMode: 'isolated', stateMode: 'isolated' },
                        },
                    },
                }),
                baseSelection: {
                    serviceId: 'claude-subscription',
                    binding: { selection: 'group' },
                    profileId: 'new-profile',
                    groupId: 'anthropic-cloud',
                    activeProfileId: 'new-profile',
                    fallbackProfileId: 'previous-profile',
                    record,
                },
                input: {
                    mode: 'apply',
                    tracked: {
                        startedBy: 'daemon',
                        happySessionId: 'session-1',
                        pid: 123,
                        vendorResumeId,
                        spawnOptions: {
                            directory: sessionDirectory,
                            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                            connectedServices: { v: 1, bindingsByServiceId: {} },
                            environmentVariables: {
                                CLAUDE_CONFIG_DIR: previousClaudeConfigDir,
                                HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: JSON.stringify(['CLAUDE_CONFIG_DIR']),
                            },
                        },
                    } satisfies TrackedSession,
                    sessionId: 'session-1',
                    agentId: 'claude',
                    serviceId: 'claude-subscription',
                    previous: {
                        source: 'connected',
                        selection: 'profile',
                        serviceId: 'claude-subscription',
                        profileId: 'previous-profile',
                        groupId: 'anthropic-cloud',
                    },
                    next: {
                        source: 'connected',
                        selection: 'group',
                        serviceId: 'claude-subscription',
                        profileId: 'new-profile',
                        groupId: 'anthropic-cloud',
                    },
                    previousBindings: { v: 1, bindingsByServiceId: {} },
                    normalizedBindings: { v: 1, bindingsByServiceId: {} },
                },
            });

            const targetRoot = (materialized as { targetMaterializedRoot?: unknown }).targetMaterializedRoot;
            expect(typeof targetRoot).toBe('string');
            await expect(readFile(
                join(String(targetRoot), 'projects', 'workspace', `${vendorResumeId}.jsonl`),
                'utf8',
            )).rejects.toThrow();
            const targetCredential = await readFile(join(String(targetRoot), '.credentials.json'), 'utf8');
            expect(targetCredential).toContain('new-access-token');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('preserves Codex dynamic sqlite state entries when materializing connected-service homes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-runtime-contribution-state-'));
        try {
            const nativeCodexHome = join(root, 'native-codex-home');
            const nativeSqliteHome = join(root, 'native-codex-sqlite');
            await mkdir(nativeCodexHome, { recursive: true });
            await mkdir(nativeSqliteHome, { recursive: true });
            await writeFile(join(nativeCodexHome, 'config.toml'), 'model = "gpt-5"\n', 'utf8');
            await writeFile(join(nativeSqliteHome, 'state_123.sqlite'), 'sqlite-state', 'utf8');

            const hooks = createProviderRuntimeCatalogEntryHooks({
                agentId: 'codex',
                packageName: '@happier-dev/plugins-codex',
                contribution: CODEX_PROVIDER_RUNTIME_CONTRIBUTION,
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
            await expect(readFile(join(String(targetRoot), 'state_123.sqlite'), 'utf8')).resolves.toBe('sqlite-state');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('imports existing Codex materialized session files before switching to shared state', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-runtime-contribution-import-'));
        try {
            const nativeCodexHome = join(root, 'native-codex-home');
            await mkdir(nativeCodexHome, { recursive: true });

            const hooks = createProviderRuntimeCatalogEntryHooks({
                agentId: 'codex',
                packageName: '@happier-dev/plugins-codex',
                contribution: CODEX_PROVIDER_RUNTIME_CONTRIBUTION,
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
