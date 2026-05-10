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
    SubagentRefInputV1,
    WorkspaceRefV1,
} from './index';

describe('plugin SDK engine contracts', () => {
    it('types backend engine registration through runtimeCore', () => {
        const runtimeCore = {} as RuntimeCore<unknown, unknown, unknown, unknown>;

        const registration: RegisterBackendEngineV1 = {
            backendId: 'acme.backend',
            create: (_ctx) => ({ runtimeCore }),
        };

        expect(registration.backendId).toBe('acme.backend');

        const engine: BackendEngineV1 = registration.create({} as PluginContextV1) as BackendEngineV1;
        expect(engine.runtimeCore).toBe(runtimeCore);
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
            resolveForSession: async () => [],
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
            'registerMcpBackendClient',
            'registerMcpTool',
            'registerMcpDiscoveryProvider',
        ];
        for (const method of registerMethods) {
            expect(method in api).toBe(false);
        }
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
});
