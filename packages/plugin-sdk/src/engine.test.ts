import { describe, expect, it } from 'vitest';

import type { RuntimeCore, SessionStateFacet } from '@happier-dev/agents';
import type {
    BackendEngineV1,
    ConnectionRuntimeServiceV1,
    ConnectionStateV1,
    ExternalSessionTakeoverInputV1,
    FetchRuntimeServiceV1,
    PluginActionsServiceV1,
    PluginApiV1,
    PluginContextV1,
    AbortServiceV1,
    EnvRuntimeServiceV1,
    ErrorRuntimeServiceV1,
    ExecRuntimeServiceV1,
    ExecClientHandleV1,
    FsRuntimeServiceV1,
    ManagedServerRuntimeServiceV1,
    McpRuntimeServiceV1,
    NotificationsServiceV1,
    ProgressRuntimeServiceV1,
    ProjectsServiceV1,
    PluginAuthServiceV1,
    AccountSettingsServiceV1,
    PluginEventsServiceV1,
    PluginSecretsServiceV1,
    PluginSettingsServiceV1,
    PluginStorageServiceV1,
    RetryRuntimeServiceV1,
    TimeoutRuntimeServiceV1,
    TranscriptsRuntimeServiceV1,
    RegisterBackendEngineV1,
    RuntimeCoreV1,
    SessionRuntimeV1,
    SubagentRefInputV1,
    CreateExecutionRunBackendParamsV1,
    CreateSessionRuntimeParamsV1,
    ExecutionRunBackendV1,
    WorkspaceRefV1,
    BackendSessionLaunchHintsV1,
    CheckpointDescriptorV1,
    ForkResultV1,
    RestoreCheckpointResultV1,
    TerminalRuntimeRunResultV1,
} from './index';

describe('plugin SDK engine contracts', () => {
    it('types backend engine registration through runtimeCore', () => {
        const sessionRuntime: SessionRuntimeV1 = {
            send: async (input, options) => ({
                status: options?.signal?.aborted ? 'rejected' : 'accepted',
                turnId: options?.turnId,
                providerTurnId: options?.localInputId ?? input.structuredInput?.skillMentions?.[0]?.id,
            }),
            cancel: async (request) => ({
                status: request.reason === 'runtime_recovery' ? 'not_running' : 'cancelled',
            }),
            dispose: async () => undefined,
        };
        const executionRunBackend: ExecutionRunBackendV1 = {
            run: async (_input, options) => ({
                status: options?.signal?.aborted ? 'cancelled' : 'accepted',
            }),
            dispose: async () => undefined,
        };
        const runtimeCore: RuntimeCoreV1 = {
            createSessionRuntime: async (params: CreateSessionRuntimeParamsV1) => {
                await params.services?.writeMetadata({
                    kind: 'set',
                    metadata: { backendId: params.backendId },
                });
                return sessionRuntime;
            },
            createExecutionRunBackend: (params: CreateExecutionRunBackendParamsV1) => {
                const backendTarget = params.backendTarget;
                const startIntent = params.start?.intent;
                const modelId = params.modelId;
                const accountSettings = params.accountSettings;
                expect(backendTarget).toEqual({ kind: 'backend', backendId: 'acme.backend', sourceKind: 'built_in' });
                expect(startIntent).toBe('review');
                expect(modelId).toBe('model-1');
                expect(accountSettings).toEqual({ mode: 'test' });
                return executionRunBackend;
            },
        };

        const registration: RegisterBackendEngineV1 = {
            backendId: 'acme.backend',
            create: (_ctx) => ({ runtimeCore }),
        };

        expect(registration.backendId).toBe('acme.backend');

        const engine: BackendEngineV1 = registration.create({} as PluginContextV1) as BackendEngineV1;
        expect(engine.runtimeCore).toBe(runtimeCore);
        expect(engine.runtimeCore?.createExecutionRunBackend({
            backendId: 'acme.backend',
            backendTarget: { kind: 'backend', backendId: 'acme.backend', sourceKind: 'built_in' },
            modelId: 'model-1',
            permissionMode: 'read_only',
            accountSettings: { mode: 'test' },
            start: {
                intent: 'review',
                retentionPolicy: 'ephemeral',
                intentInput: { reviewType: 'summary' },
            },
        })).toBe(executionRunBackend);
    });

    it('rejects raw unknown runtimeCore at the plugin authoring seam', () => {
        const runtimeCore = {} as RuntimeCore<unknown, unknown, unknown, unknown>;

        const engine: BackendEngineV1 = {
            // @ts-expect-error A.13q requires the public SDK backend engine to expose RuntimeCoreV1.
            runtimeCore,
        };

        expect(engine).toBeDefined();
    });

    it('does not expose host session runtime plans through the public session runtime result', () => {
        type PublicSessionRuntimeCreateResult = import('./index').SessionRuntimeCreateResultV1;
        type PublicHostPlanLeak = Extract<PublicSessionRuntimeCreateResult, { kind: 'hostSessionRuntimePlan' }>;
        type AssertNever<T extends never> = T;
        type NoHostPlanLeak = AssertNever<PublicHostPlanLeak>;

        const sessionRuntime: SessionRuntimeV1 = {
            send: async () => ({ status: 'accepted' }),
            dispose: async () => undefined,
        };
        const publicResult: PublicSessionRuntimeCreateResult = sessionRuntime;
        const noHostPlanLeak = true satisfies NoHostPlanLeak extends never ? true : false;

        expect(publicResult).toBe(sessionRuntime);
        expect(noHostPlanLeak).toBe(true);
    });

    it('types session state as a runtime facet adjunct', () => {
        const sessionState = {} as SessionStateFacet;

        const engine: BackendEngineV1 = {
            facets: {
                sessionState,
            },
        };

        expect(engine.facets?.sessionState).toBe(sessionState);
        expect('sessionState' in engine).toBe(false);
    });

    it('exposes final backend executable surface fields without stale handoff naming', () => {
        const terminalResult: TerminalRuntimeRunResultV1 = {
            type: 'process_exited',
            exitCode: 0,
        };
        const launchHints: BackendSessionLaunchHintsV1 = {
            directory: '/repo',
            environmentVariables: { HAPPIER_BACKEND_MODE: 'test' },
        };
        const forkResult: ForkResultV1 = {
            providerSessionId: 'vendor-child-1',
            launch: launchHints,
        };
        const checkpoint: CheckpointDescriptorV1 = {
            id: 'checkpoint-1',
            target: { kind: 'provider_checkpoint', checkpointId: 'provider-checkpoint-1' },
            timing: 'idle',
            checkpointScopes: ['conversation'],
            restoreScopes: ['conversation'],
        };
        const restoreResult: RestoreCheckpointResultV1 = {
            ok: true,
            outcome: 'completed',
            restoredScopes: ['conversation'],
        };
        const engine: BackendEngineV1 = {
            terminalRuntimeSurface: {
                launch: async () => terminalResult,
                resolveTranscriptBinding: async () => null,
            },
            externalSessionSurface: {
                resolveSource: async ({ source }) => ({ ok: true, value: { source } }),
                listCandidates: async () => ({ ok: true, value: { candidates: [], nextCursor: null } }),
                pageTranscript: async () => ({
                    ok: true,
                    value: { items: [], nextCursor: null, tailCursor: null, hasMore: false },
                }),
            },
            attachSurface: {
                attach: async () => ({ ok: true, value: { exitCode: 0 } }),
            },
            handoffSurface: {
                exportBundle: async () => ({ ok: true, value: { bundle: {} } }),
                importBundle: async () => ({
                    ok: true,
                    value: {
                        providerSessionId: 'vendor-import-1',
                        launch: launchHints,
                    },
                }),
            },
            forkSurface: {
                fork: async () => forkResult,
                resolveReplayChildLaunch: async () => launchHints,
            },
            checkpointSurface: {
                list: async () => [checkpoint],
                restore: async () => restoreResult,
            },
        };

        expect(engine.handoffSurface).toBeDefined();
        expect(engine.forkSurface).toBeDefined();
        expect(engine.checkpointSurface).toBeDefined();
        expect('sessionHandoffSurface' in engine).toBe(false);
    });

    it('rejects arbitrary raw payloads on final backend executable surfaces', () => {
        const engine: BackendEngineV1 = {
            terminalRuntimeSurface: {
                // @ts-expect-error terminal runtime launch returns TerminalRuntimeRunResultV1, not arbitrary objects.
                launch: async () => ({ ok: true }),
            },
            forkSurface: {
                // @ts-expect-error fork returns ForkResultV1 with providerSessionId and launch hints.
                fork: async () => ({ spawn: {}, metadata: {} }),
            },
            checkpointSurface: {
                // @ts-expect-error restore returns RestoreCheckpointResultV1 with outcome/scopes, not a bare success marker.
                restore: async () => ({ ok: true }),
            },
        };

        expect(engine).toBeDefined();
    });

    it('rejects stale bindings-only backend engines at the SDK seam', () => {
        const runtimeCore = {} as RuntimeCore<unknown, unknown, unknown, unknown>;

        const registration: RegisterBackendEngineV1 = {
            backendId: 'acme.backend',
            // @ts-expect-error A.6 hard-breaks stale engine bindings in favor of runtimeCore.
            create: () => ({
                bindings: runtimeCore,
            }),
        };

        expect(registration.backendId).toBe('acme.backend');
    });

    it('exposes generated SDK actions as type-only context substrate', async () => {
        const actions = {} as PluginContextV1['actions'];
        const service: PluginActionsServiceV1 = actions;
        const listPullRequests: PluginActionsServiceV1['scm']['pullRequest']['list'] = async (input) => {
            expect(input.cwd).toBe('/repo');
            return { success: true, pullRequests: [] };
        };

        await expect(listPullRequests({ cwd: '/repo' })).resolves.toEqual({
            success: true,
            pullRequests: [],
        });
        expect(service).toEqual({});
    });

    it('exposes notifications on runtime context without putting runtime services on activate api', async () => {
        const notifications = {} as PluginContextV1['notifications'];
        const service: NotificationsServiceV1 = notifications;
        const send: NotificationsServiceV1['send'] = async (input) => {
            expect(input.categoryId).toBe('acme.notifications.reviewReady');
            return { delivered: ['builtin:expo_push'] };
        };

        await expect(send({
            categoryId: 'acme.notifications.reviewReady',
            title: 'Review ready',
            body: 'The review is waiting for input',
        })).resolves.toEqual({
            delivered: ['builtin:expo_push'],
        });

        const api = {} as PluginApiV1;
        expect('notifications' in api).toBe(false);
        expect(service).toEqual({});
    });

    it('exposes observe-only connection state on runtime context without putting connection on activate api', () => {
        const state: ConnectionStateV1 = Object.freeze({
            phase: 'online',
            reason: null,
            attempt: 0,
            nextRetryAt: null,
            lastConnectedAt: 1000,
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        });
        const connection: ConnectionRuntimeServiceV1 = {
            getDaemonLinkState: () => state,
            watchDaemonLink: (listener) => {
                listener(state);
                return { unsubscribe: () => undefined };
            },
            isDaemonOnline: () => true,
        };
        const context = { connection } as PluginContextV1;

        expect(context.connection.getDaemonLinkState()).toEqual(state);
        expect(context.connection.isDaemonOnline()).toBe(true);
        expect('supervise' in context.connection).toBe(false);
        expect('send' in context.connection).toBe(false);
        expect('request' in context.connection).toBe(false);

        const api = {} as PluginApiV1;
        expect('connection' in api).toBe(false);
    });

    it('exposes fetch and nested session services on runtime context without putting fetch on activate api', async () => {
        const fetchService: FetchRuntimeServiceV1 = async (request) => {
            expect(request.url).toBe('https://example.test/status');
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: {},
                body: null,
                text: async () => 'ok',
                json: async () => ({ ok: true }),
                arrayBuffer: async () => new ArrayBuffer(0),
            };
        };
        const context = {
            fetch: fetchService,
            sessions: {
                subagents: {
                    upsert: async (input: SubagentRefInputV1) => ({
                        ...input,
                        status: input.status ?? 'pending',
                        createdAt: input.createdAt ?? 0,
                    }),
                },
                external: {
                    takeover: async (input: ExternalSessionTakeoverInputV1) => ({
                        ok: true,
                        sessionId: input.linkedSessionId,
                        targetRuntimeMode: input.targetRuntimeMode,
                        storageMode: input.storageMode,
                        converted: false,
                    }),
                },
            },
        } as PluginContextV1;

        await expect(context.fetch({ url: 'https://example.test/status' }))
            .resolves
            .toMatchObject({ ok: true, status: 200 });
        await expect(context.sessions.subagents.upsert({
            id: 'subagent-1',
            parentSessionId: 'session-1',
            origin: 'plugin',
            kind: 'custom',
        })).resolves.toMatchObject({
            id: 'subagent-1',
            status: 'pending',
        });
        await expect(context.sessions.external.takeover({
            linkedSessionId: 'session-1',
            targetRuntimeMode: 'remote',
            storageMode: 'external-linked',
        })).resolves.toMatchObject({
            ok: true,
            sessionId: 'session-1',
        });

        const api = {} as PluginApiV1;
        expect('fetch' in api).toBe(false);
    });

    it('exposes A.13 runtime services on context without stale managedTools or RPC escape hatches', () => {
        const exec = {} as ExecRuntimeServiceV1;
        const managedServer = {} as ManagedServerRuntimeServiceV1;
        const errors = {} as ErrorRuntimeServiceV1;
        const retry = {} as RetryRuntimeServiceV1;
        const env = {} as EnvRuntimeServiceV1;
        const fs = {} as FsRuntimeServiceV1;
        const abort = {} as AbortServiceV1;
        const timeout = {} as TimeoutRuntimeServiceV1;
        const progress = {} as ProgressRuntimeServiceV1;
        const transcripts = {} as TranscriptsRuntimeServiceV1;
        const context = {
            exec,
            managedServer,
            errors,
            retry,
            env,
            fs,
            abort,
            timeout,
            progress,
            transcripts,
        } as PluginContextV1;
        const contextRecord = context as unknown as Readonly<Record<string, unknown>>;

        expect(context.exec).toBe(exec);
        expect(context.managedServer).toBe(managedServer);
        expect(context.errors).toBe(errors);
        expect(context.retry).toBe(retry);
        expect(context.env).toBe(env);
        expect(context.fs).toBe(fs);
        expect(context.abort).toBe(abort);
        expect(context.timeout).toBe(timeout);
        expect(context.progress).toBe(progress);
        expect(context.transcripts).toBe(transcripts);
        expect('managedTools' in contextRecord).toBe(false);
        expect('rpc' in contextRecord).toBe(false);
        expect('jsonRpcStdio' in contextRecord).toBe(false);

        const api = {} as PluginApiV1;
        expect('exec' in api).toBe(false);
        expect('managedServer' in api).toBe(false);
        expect('retry' in api).toBe(false);
    });

    it('exposes MCP substrate on runtime context and MCP registration on activate api', () => {
        const mcp: McpRuntimeServiceV1 = {
            startServer: async () => ({
                id: 'acme.server',
                dispose: async () => undefined,
            }),
            createClient: async () => ({
                id: 'acme.client',
                dispose: async () => undefined,
            }),
            list: async () => [],
            resolveForSession: async () => [{
                id: 'acme.server',
                name: 'acme-server',
                transport: { kind: 'hosted' },
                scope: { sessionId: 'session-1' },
            }],
        };
        const ctx = { mcp } as PluginContextV1;

        expect(ctx.mcp).toBe(mcp);
        expect(typeof ctx.mcp.startServer).toBe('function');
        expect(typeof ctx.mcp.createClient).toBe('function');
        expect(typeof ctx.mcp.list).toBe('function');
        expect(typeof ctx.mcp.resolveForSession).toBe('function');

        const api = {} as PluginApiV1;
        expect('mcp' in api).toBe(false);

        const registerMethods: ReadonlyArray<keyof PluginApiV1> = [
            'registerMcpServer',
            'registerMcpDiscoveryProvider',
        ];
        for (const method of registerMethods) {
            expect(method in api).toBe(false);
        }
        expect('registerMcpBackendClient' in api).toBe(false);
        expect('registerMcpTool' in api).toBe(false);
    });

    it('exposes A.11 persistence, event, and narrow auth services only on runtime context', async () => {
        const storage = {} as PluginContextV1['storage'];
        const settings = {} as PluginContextV1['settings'];
        const secrets = {} as PluginContextV1['secrets'];
        const events = {} as PluginContextV1['events'];
        const auth = {} as PluginContextV1['auth'];

        const storageService: PluginStorageServiceV1 = storage;
        const settingsService: PluginSettingsServiceV1 = settings;
        const secretsService: PluginSecretsServiceV1 = secrets;
        const eventsService: PluginEventsServiceV1 = events;
        const authService: PluginAuthServiceV1 = auth;

        const context = {
            storage: storageService,
            settings: settingsService,
            secrets: secretsService,
            events: eventsService,
            auth: authService,
        } as PluginContextV1;

        expect(context.storage).toBe(storageService);
        expect(context.settings).toBe(settingsService);
        expect(context.secrets).toBe(secretsService);
        expect(context.events).toBe(eventsService);
        expect(context.auth).toBe(authService);
        expect('getConnectedServices' in context.auth).toBe(false);
        expect('startConnect' in context.auth).toBe(false);
        expect('disconnect' in context.auth).toBe(false);

        const api = {} as PluginApiV1;
        expect('storage' in api).toBe(false);
        expect('settings' in api).toBe(false);
        expect('secrets' in api).toBe(false);
        expect('events' in api).toBe(false);
        expect('auth' in api).toBe(false);
    });

    it('exposes projects and account settings on runtime context without putting them on activate api', async () => {
        const workspaceRef: WorkspaceRefV1 = {
            id: 'workspace_1',
            serverId: 'server_1',
            machineId: 'machine_1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
            lastOpenedAtMs: null,
        };
        const projects: ProjectsServiceV1 = {
            listAll: async () => [workspaceRef],
            listForCurrentMachine: async () => [workspaceRef],
            listForMachine: async (machineId) => machineId === 'machine_1' ? [workspaceRef] : [],
            get: async (key) => ('id' in key && key.id === workspaceRef.id ? workspaceRef : null),
            getActive: async () => workspaceRef,
            watch: (listener) => {
                listener([workspaceRef]);
                return { unsubscribe: () => undefined };
            },
        };
        const accountSettings: AccountSettingsServiceV1 = {
            get: async (key?: string) => key === 'workspaceRefsV1' ? [workspaceRef] : {},
            set: async () => undefined,
            onChange: (listener) => {
                listener({ workspaceRefsV1: [workspaceRef] });
                return { unsubscribe: () => undefined };
            },
        };
        const context = {
            projects,
            account: {
                settings: accountSettings,
            },
        } as PluginContextV1;

        await expect(context.projects.listAll()).resolves.toEqual([workspaceRef]);
        await expect(context.projects.get({ id: 'workspace_1' })).resolves.toEqual(workspaceRef);
        await expect(context.account.settings.get('workspaceRefsV1')).resolves.toEqual([workspaceRef]);

        const api = {} as PluginApiV1;
        expect('projects' in api).toBe(false);
        expect('account' in api).toBe(false);
    });

    it('exposes provider-account usage recording on runtime context without putting it on activate api', async () => {
        const accountUsage = {} as PluginContextV1['accountUsage'];
        const service = accountUsage;
        const context = {
            accountUsage: service,
        } as PluginContextV1;

        expect(context.accountUsage).toBe(service);

        const api = {} as PluginApiV1;
        expect('accountUsage' in api).toBe(false);
    });

    it('types spawnClient as protocol-client-spec with implemented stream and byte protocols', async () => {
        function assertSpawnClientAuthoring(exec: ExecRuntimeServiceV1) {
            // @ts-expect-error A.13p freezes spawnClient on object-shaped ExecClientSpecV1, not launch-only input.
            void exec.spawnClient({
                kind: 'binary',
                executablePath: '/bin/agent',
            });

            void exec.spawnClient({
                launch: {
                    kind: 'binary',
                    executablePath: '/bin/agent',
                },
                transport: {
                    kind: 'stdio',
                    framing: { kind: 'strict-lf-json' },
                    encoding: 'utf8',
                },
                protocol: {
                    kind: 'json-rpc-2.0',
                },
                lifecycle: {
                    diagnostics: {
                        rpcLog: {
                            kind: 'file',
                            path: '/tmp/happier-rpc.log',
                            maxBytes: 1024,
                            rotateCount: 1,
                        },
                        sanitizer: {
                            redactedValues: ['known-secret-value'],
                            sensitiveKeys: ['vendorSessionId'],
                            maxStringBytes: 256,
                            maxArrayItems: 4,
                            maxObjectKeys: 8,
                            maxDepth: 3,
                        },
                    },
                },
            });

            void exec.spawnClient({
                // @ts-expect-error A.13p current public authoring excludes host-issued resolvedExecutable grants.
                launch: {
                    kind: 'resolvedExecutable',
                    executablePath: '/bin/agent',
                },
                transport: {
                    kind: 'stdio',
                    framing: { kind: 'strict-lf-json' },
                    encoding: 'utf8',
                },
                protocol: {
                    kind: 'json-rpc-2.0',
                },
            });

            void exec.spawnClient({
                launch: {
                    kind: 'binary',
                    executablePath: '/bin/agent',
                },
                transport: {
                    kind: 'stdio',
                    // @ts-expect-error A.13p current public framing is strict LF JSON; other frame families require A.13p.1.
                    framing: { kind: 'content-length' },
                    encoding: 'utf8',
                },
                protocol: {
                    kind: 'json-rpc-2.0',
                },
            });

            void exec.spawnClient({
                launch: {
                    kind: 'binary',
                    executablePath: '/bin/agent',
                },
                transport: {
                    kind: 'stdio',
                    framing: { kind: 'strict-lf-json' },
                    encoding: 'utf8',
                },
                protocol: {
                    kind: 'json-stream',
                },
            });

            void exec.spawnClient({
                launch: {
                    kind: 'binary',
                    executablePath: '/bin/agent',
                },
                transport: {
                    kind: 'stdio',
                    framing: { kind: 'framed-bytes' },
                },
                protocol: {
                    kind: 'framed-bytes',
                },
            });
        }

        expect(assertSpawnClientAuthoring).toBeTypeOf('function');
    });

    it('types exec client JSON-RPC operations through handle.client only', async () => {
        function assertExecClientHandle(handle: ExecClientHandleV1) {
            void handle.client.request('fixture/ping', {});
            void handle.client.notify('fixture/ready', {});

            // @ts-expect-error A.13p does not expose legacy message-envelope request helpers on the public handle.
            void handle.request({ method: 'fixture/ping' });
            // @ts-expect-error A.13p does not expose legacy message-envelope notify helpers on the public handle.
            void handle.notify({ method: 'fixture/ready' });
        }

        expect(assertExecClientHandle).toBeTypeOf('function');
    });
});
