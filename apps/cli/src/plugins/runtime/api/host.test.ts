import { describe, expect, it, vi } from 'vitest';

import { createPluginApiHost } from './host';
import type { PluginApiHostPolicy, PluginDisposable } from './types';

async function disposePluginDisposable(disposable: PluginDisposable): Promise<void> {
    if (typeof disposable === 'function') {
        await disposable();
        return;
    }
    await disposable.dispose();
}

describe('createPluginApiHost', () => {
    it('exposes manifest-declared SCM backend registration as a narrow runtime surface', () => {
        const host = createPluginApiHost({
            pluginId: 'acme.scm.backend',
            runtimeCapabilities: ['scmBackends'],
            declaredScmBackendIds: ['acme-vcs'],
        } as Parameters<typeof createPluginApiHost>[0] & {
            declaredScmBackendIds: readonly string[];
        });
        const api = host.api as typeof host.api & {
            registerScmBackend?: (registration: {
                id: string;
                handlers: {
                    detection: {
                        detectRepo: () => Promise<{ isRepo: boolean; rootPath: string | null; mode: '.git' | '.sl' | null }>;
                    };
                    read: {
                        statusSnapshot: () => Promise<unknown>;
                    };
                };
            }) => PluginDisposable;
        };

        expect(api.registerScmBackend).toBeTypeOf('function');
        api.registerScmBackend?.({
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: false, rootPath: null, mode: null }),
                },
                read: {
                    statusSnapshot: async () => ({ ok: true, snapshot: null }),
                },
            },
        });

        expect((host.registrations() as ReturnType<typeof host.registrations> & {
            scmBackends?: readonly { id: string }[];
        }).scmBackends).toEqual([
            expect.objectContaining({ id: 'acme-vcs' }),
        ]);
    });

    it('rejects SCM backend activation without a matching manifest contribution', () => {
        const host = createPluginApiHost({
            pluginId: 'acme.scm.backend',
            runtimeCapabilities: ['scmBackends'],
            declaredScmBackendIds: ['acme-vcs'],
        } as Parameters<typeof createPluginApiHost>[0] & {
            declaredScmBackendIds: readonly string[];
        });
        const api = host.api as typeof host.api & {
            registerScmBackend?: (registration: { id: string; handlers: object }) => PluginDisposable;
        };

        expect(() => api.registerScmBackend?.({
            id: 'shadow-vcs',
            handlers: {},
        })).toThrow(/not a manifest-declared SCM backend id/);
        expect(host.registrations().diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_scm_backend_undeclared_id',
            }),
        ]);
    });

    it('does not expose legacy static contribution registration methods', () => {
        const host = createPluginApiHost();
        const legacyMethods = [
            `register${'Provider'}`,
            `register${'Backend'}`,
            `registerRuntime${'Adapter'}`,
        ];

        for (const method of legacyMethods) {
            expect(method in host.api).toBe(false);
        }

        const registrations = host.registrations() as Record<string, unknown>;
        expect(`providers` in registrations).toBe(false);
        expect(`backends` in registrations).toBe(false);
        expect(`runtime${'Adapters'}` in registrations).toBe(false);
    });

    it('records tracked disposables in the registration snapshot and disposes them once', async () => {
        const dispose = vi.fn(async () => undefined);
        const host = createPluginApiHost();

        host.api.registerAction({
            id: 'acme.action',
            title: 'Acme Action',
            surface: 'cli',
            handler: async () => null,
        });
        host.api.onDispose({ dispose });

        const registrations = host.registrations();
        expect(registrations.disposables).toHaveLength(2);

        await host.dispose();
        await host.dispose();

        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('captures backend engine registrations and disposes their removal handlers', async () => {
        const host = createPluginApiHost();

        host.api.registerBackendEngine({
            backendId: 'acme.backend',
            create: async () => ({}),
        });

        expect(host.registrations().backendEngines).toHaveLength(1);

        await host.dispose();

        expect(host.registrations().backendEngines).toHaveLength(0);
    });

    it('rejects backend engine registrations for backend ids absent from the manifest', () => {
        const policy = {
            declaredBackendIds: ['acme.backend'],
        } satisfies Parameters<typeof createPluginApiHost>[0] & Readonly<{
            declaredBackendIds: readonly string[];
        }>;
        const host = createPluginApiHost(policy);

        expect(() => host.api.registerBackendEngine({
            backendId: 'acme.undeclared',
            create: async () => ({}),
        })).toThrow(/manifest-declared backend id/);

        expect(host.registrations().backendEngines).toEqual([]);
        expect(host.registrations().diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_backend_engine_undeclared_backend_id',
            }),
        ]);
    });

    it('rejects action registrations for ids absent from the same plugin manifest', () => {
        const host = createPluginApiHost({
            pluginId: 'acme.actions',
            runtimeCapabilities: ['actions'],
            permissions: ['actions.register'],
            declaredActionIds: ['acme.actions.allowed'],
        });

        host.api.registerAction({
            id: 'acme.actions.allowed',
            title: 'Allowed',
            surface: 'cli',
            handler: async () => null,
        });

        expect(() => host.api.registerAction({
            id: 'acme.actions.shadow',
            title: 'Shadow',
            surface: 'cli',
            handler: async () => null,
        })).toThrow(/manifest-declared action id/);

        expect(host.registrations().actions.map((entry) => entry.id)).toEqual([
            'acme.actions.allowed',
        ]);
        expect(host.registrations().diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_action_undeclared_id',
            }),
        ]);
    });

    it('rejects tool registrations for ids absent from the same plugin manifest', () => {
        const host = createPluginApiHost({
            pluginId: 'acme.tools',
            runtimeCapabilities: ['tools'],
            permissions: ['tools.register'],
            declaredToolIds: ['acme.tools.allowed'],
        });

        host.api.registerTool({
            id: 'acme.tools.allowed',
            name: 'acme_tools_allowed',
            title: 'Allowed',
            surfaces: { cli: true, mcp: false, session_agent: false },
            handler: async () => null,
        });

        expect(() => host.api.registerTool({
            id: 'acme.tools.shadow',
            name: 'acme_tools_shadow',
            title: 'Shadow',
            surfaces: { cli: true, mcp: false, session_agent: false },
            handler: async () => null,
        })).toThrow(/manifest-declared tool id/);

        expect(host.registrations().tools.map((entry) => entry.id)).toEqual([
            'acme.tools.allowed',
        ]);
        expect(host.registrations().diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_tool_undeclared_id',
            }),
        ]);
    });

    it('rejects command registrations for ids absent from the same plugin manifest', () => {
        const host = createPluginApiHost({
            pluginId: 'acme.commands',
            runtimeCapabilities: ['commands'],
            permissions: ['commands.register'],
            declaredCommandIds: ['acme.commands.allowed'],
        });

        host.api.registerCommand({
            id: 'acme.commands.allowed',
            command: 'allowed',
            allowTmux: false,
            handler: async () => null,
        });

        expect(() => host.api.registerCommand({
            id: 'acme.commands.shadow',
            command: 'shadow',
            allowTmux: false,
            handler: async () => null,
        })).toThrow(/manifest-declared command id/);

        expect(host.registrations().commands.map((entry) => entry.id)).toEqual([
            'acme.commands.allowed',
        ]);
        expect(host.registrations().diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_command_undeclared_id',
            }),
        ]);
    });

    it('rejects hook registrations for ids absent from the same plugin manifest', () => {
        const host = createPluginApiHost({
            pluginId: 'acme.hooks',
            runtimeCapabilities: ['hooks'],
            permissions: ['hooks.register'],
            declaredHookIds: ['acme.hooks.allowed'],
        });

        host.api.registerHook({
            hookId: 'acme.hooks.allowed',
            handler: async () => null,
        });

        expect(() => host.api.registerHook({
            hookId: 'acme.hooks.shadow',
            handler: async () => null,
        })).toThrow(/manifest-declared hook id/);

        expect(host.registrations().hooks.map((entry) => entry.hookId)).toEqual([
            'acme.hooks.allowed',
        ]);
        expect(host.registrations().diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_hook_undeclared_id',
            }),
        ]);
    });

    it('rejects lifecycle handler registrations for ids absent from the same plugin manifest', () => {
        const host = createPluginApiHost({
            pluginId: 'acme.lifecycle',
            runtimeCapabilities: ['lifecycle'],
            declaredLifecycleHandlerIds: ['acme.lifecycle.allowed'],
        });

        host.api.registerLifecycleHandler({
            id: 'acme.lifecycle.allowed',
            event: 'activated',
            handler: async () => undefined,
        });

        expect(() => host.api.registerLifecycleHandler({
            id: 'acme.lifecycle.shadow',
            event: 'deactivating',
            handler: async () => undefined,
        })).toThrow(/manifest-declared lifecycle handler id/);

        expect(host.registrations().lifecycleHandlers.map((entry) => entry.id)).toEqual([
            'acme.lifecycle.allowed',
        ]);
        expect(host.registrations().diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_lifecycle_handler_undeclared_id',
            }),
        ]);
    });

    it('allows id-less lifecycle handler registrations declared for the same event', () => {
        const policy: PluginApiHostPolicy = {
            pluginId: 'acme.lifecycle',
            runtimeCapabilities: ['lifecycle'],
            declaredLifecycleHandlers: [
                { event: 'activated' },
            ],
        };
        const host = createPluginApiHost(policy);

        host.api.registerLifecycleHandler({
            event: 'activated',
            handler: async () => undefined,
        });

        expect(() => host.api.registerLifecycleHandler({
            event: 'deactivating',
            handler: async () => undefined,
        })).toThrow(/manifest-declared lifecycle handler id/);

        expect(host.registrations().lifecycleHandlers.map((entry) => ({
            event: entry.event,
            id: entry.id ?? null,
        }))).toEqual([
            { event: 'activated', id: null },
        ]);
        expect(host.registrations().diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_lifecycle_handler_undeclared_id',
            }),
        ]);
    });

    it('mounts sibling-owned register methods through the shared host policy and disposable registry', () => {
        const registeredCanaries: string[] = [];
        const host = createPluginApiHost({
            runtimeCapabilities: ['acmeCanaries'],
            registerMethods: {
                registerAcmeCanary: {
                    family: 'acmeCanaries',
                    register(registration, context) {
                        const canaryId = typeof registration === 'object'
                            && registration !== null
                            && 'id' in registration
                            && typeof registration.id === 'string'
                            ? registration.id
                            : 'unknown';
                        registeredCanaries.push(canaryId);
                        return context.addDisposable(() => {
                            const index = registeredCanaries.indexOf(canaryId);
                            if (index >= 0) {
                                registeredCanaries.splice(index, 1);
                            }
                        });
                    },
                },
            },
        });

        expect('registerAcmeCanary' in host.api).toBe(true);

        const api = host.api as typeof host.api & Readonly<{
            registerAcmeCanary: (registration: Readonly<{ id: string }>) => () => void;
        }>;
        const dispose = api.registerAcmeCanary({ id: 'canary-1' });

        expect(registeredCanaries).toEqual(['canary-1']);

        dispose();

        expect(registeredCanaries).toEqual([]);
    });

    it('registers request interceptors only when the plugin declares network permission', () => {
        const denied = createPluginApiHost({
            pluginId: 'acme.fetch',
            permissions: [],
        });

        expect('registerRequestInterceptor' in denied.api).toBe(true);
        const deniedApi = denied.api as typeof denied.api & Readonly<{
            registerRequestInterceptor: (registration: unknown) => unknown;
        }>;

        expect(deniedApi.registerRequestInterceptor({
            id: 'acme.fetch.audit',
            intercept: async () => ({ ok: true }),
        })).toEqual(expect.any(Function));
        expect(denied.registrations().requestInterceptors).toEqual([]);
        expect(denied.registrations().diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_permission_missing',
            }),
        ]);

        const allowed = createPluginApiHost({
            pluginId: 'acme.fetch',
            permissions: ['network'],
        });
        const allowedApi = allowed.api as typeof allowed.api & Readonly<{
            registerRequestInterceptor: (registration: unknown) => () => void;
        }>;

        const dispose = allowedApi.registerRequestInterceptor({
            id: 'acme.fetch.audit',
            priority: 5,
            intercept: async () => ({ ok: true }),
        });

        expect(allowed.registrations().requestInterceptors).toHaveLength(1);

        dispose();

        expect(allowed.registrations().requestInterceptors).toEqual([]);
    });

    it('validates notification category and channel registrations against manifest declarations', async () => {
        const host = createPluginApiHost({
            pluginId: 'acme.notifications',
            runtimeCapabilities: ['notifications'],
            permissions: ['notifications.register'],
            declaredNotificationCategoryIds: ['acme.notifications.ready'],
            declaredNotificationChannelIds: ['acme.notifications.webhook'],
        });

        host.api.registerNotificationCategory({
            id: 'acme.notifications.ready',
            kind: 'activity',
            title: 'Ready',
        });
        host.api.registerNotificationChannel({
            id: 'acme.notifications.webhook',
            kind: 'webhook',
            title: 'Webhook',
            send: async () => ({ delivered: true }),
        });

        expect(host.registrations().notificationCategories.map((entry) => entry.id)).toEqual([
            'acme.notifications.ready',
        ]);
        expect(host.registrations().notificationChannels.map((entry) => entry.id)).toEqual([
            'acme.notifications.webhook',
        ]);

        expect(() => host.api.registerNotificationCategory({
            id: 'acme.notifications.ready',
            kind: 'activity',
            title: 'Duplicate ready',
        })).toThrow(/Duplicate notification category/);
        expect(() => host.api.registerNotificationChannel({
            id: 'acme.notifications.missing',
            kind: 'webhook',
            title: 'Missing',
            send: async () => ({ delivered: true }),
        })).toThrow(/manifest-declared notification channel id/);

        await host.dispose();

        expect(host.registrations().notificationCategories).toEqual([]);
        expect(host.registrations().notificationChannels).toEqual([]);
        expect(host.registrations().diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_notification_category_duplicate_id',
            }),
            expect.objectContaining({
                code: 'plugin_notification_channel_undeclared_id',
            }),
        ]);
    });

    it('validates SCM hosting-provider registrations against same-plugin manifest declarations', () => {
        const host = createPluginApiHost({
            pluginId: 'acme.scm',
            runtimeCapabilities: ['scmHostingProviders'],
            declaredScmHostingProviderIds: ['acme.scm.github'],
        });
        const api = host.api as typeof host.api & Readonly<{
            registerScmHostingProvider: (registration: Readonly<{
                id: string;
                adapter: Readonly<Record<string, unknown>>;
            }>) => unknown;
        }>;

        const dispose = api.registerScmHostingProvider({
            id: 'acme.scm.github',
            adapter: {},
        });

        expect(host.registrations().scmHostingProviders).toEqual([
            expect.objectContaining({
                id: 'acme.scm.github',
            }),
        ]);

        expect(() => api.registerScmHostingProvider({
            id: 'acme.scm.gitlab',
            adapter: {},
        })).toThrow(/manifest-declared SCM hosting provider id/);

        expect(typeof dispose).toBe('function');
        if (typeof dispose === 'function') {
            dispose();
        }

        expect(host.registrations().scmHostingProviders).toEqual([]);
        expect(host.registrations().diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_scm_hosting_provider_undeclared_id',
            }),
        ]);
    });

    it('rejects invalid execution-run profile registrations before storing them', () => {
        const host = createPluginApiHost({
            pluginId: 'acme.execution-runs',
            runtimeCapabilities: ['executionRunProfiles'],
            declaredExecutionRunProfileIds: ['acme.review.profile'],
        });
        const api = host.api as typeof host.api & Readonly<{
            registerExecutionRunProfile: (registration: unknown) => unknown;
        }>;

        expect(() => api.registerExecutionRunProfile({
            id: 'acme.review.profile',
            intent: 'review',
            displayKey: 'plugins.acme.executionRuns.review.label',
        })).toThrow(/Invalid execution-run profile/);

        expect(host.registrations().executionRunProfiles).toEqual([]);
        expect(host.registrations().diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_manifest_semantic_invalid',
            }),
        ]);
    });

    it('records MCP registrations and removes them through disposable handles', async () => {
        const host = createPluginApiHost({
            pluginId: 'acme',
        });

        const serverDisposable = host.api.registerMcpServer({
            id: 'acme.hosted',
            name: 'acme-hosted',
            transport: { kind: 'hosted' },
        });
        const backendClientDisposable = host.api.registerMcpBackendClient({
            id: 'acme.backendClient',
            serverName: 'acme-hosted',
            toolNamespace: 'codex.github',
        });
        const toolDisposable = host.api.registerMcpTool({
            id: 'acme.tool',
            name: 'ext.acme.search',
            inputSchema: { type: 'object' },
            handler: async () => ({ ok: true }),
        });
        const discoveryDisposable = host.api.registerMcpDiscoveryProvider({
            id: 'acme.discovery',
            discover: async () => [],
        });

        expect(host.registrations().mcpServers.map((entry) => entry.id)).toEqual(['acme.hosted']);
        expect(host.registrations().mcpBackendClients.map((entry) => entry.id)).toEqual(['acme.backendClient']);
        expect(host.registrations().mcpTools.map((entry) => entry.name)).toEqual(['ext.acme.search']);
        expect(host.registrations().mcpDiscoveryProviders.map((entry) => entry.id)).toEqual(['acme.discovery']);

        await disposePluginDisposable(serverDisposable);
        await disposePluginDisposable(backendClientDisposable);
        await disposePluginDisposable(toolDisposable);
        await disposePluginDisposable(discoveryDisposable);

        expect(host.registrations().mcpServers).toEqual([]);
        expect(host.registrations().mcpBackendClients).toEqual([]);
        expect(host.registrations().mcpTools).toEqual([]);
        expect(host.registrations().mcpDiscoveryProviders).toEqual([]);
    });

    it('rejects unprefixed MCP tools and same-namespace collisions', () => {
        const host = createPluginApiHost({
            pluginId: 'acme',
        });

        expect(() => host.api.registerMcpTool({
            id: 'acme.bad',
            name: 'search',
            handler: async () => null,
        })).toThrow(/canonical MCP tool prefix/);

        host.api.registerMcpTool({
            id: 'acme.search',
            name: 'ext.acme.search',
            handler: async () => null,
        });

        expect(() => host.api.registerMcpTool({
            id: 'acme.create',
            name: 'ext.acme.create',
            handler: async () => null,
        })).toThrow(/MCP tool namespace collision/);
    });

    it('rejects secret-shaped runtime MCP server registration fields before storing them', () => {
        const host = createPluginApiHost({
            pluginId: 'acme',
        });
        const rawSecretServerRegistration = {
            id: 'acme.remote',
            name: 'acme-remote',
            transport: { kind: 'http' as const, url: 'https://mcp.example.test' },
            headers: { Authorization: 'Bearer raw-token' },
        };

        expect(() => host.api.registerMcpServer(rawSecretServerRegistration)).toThrow(/raw secret material/);

        expect(host.registrations().mcpServers).toEqual([]);
    });

    it('rejects secret-shaped runtime MCP tool and discovery registrations before storing them', () => {
        const host = createPluginApiHost({
            pluginId: 'acme',
        });
        const rawSecretToolRegistration = {
            id: 'acme.tool',
            name: 'ext.acme.search',
            handler: async () => null,
            headers: { Authorization: 'Bearer raw-token' },
        };
        const rawSecretDiscoveryRegistration = {
            id: 'acme.discovery',
            discover: async () => [],
            token: 'raw-token',
        };

        expect(() => host.api.registerMcpTool(rawSecretToolRegistration)).toThrow(/raw secret material/);
        expect(() => host.api.registerMcpDiscoveryProvider(rawSecretDiscoveryRegistration)).toThrow(/raw secret material/);

        expect(host.registrations().mcpTools).toEqual([]);
        expect(host.registrations().mcpDiscoveryProviders).toEqual([]);
    });

    it('rejects invalid MCP backend-client namespaces at the runtime registration seam', () => {
        const host = createPluginApiHost({
            pluginId: 'acme',
        });

        expect(() => host.api.registerMcpBackendClient({
            id: 'acme.backendClient',
            serverName: 'acme-hosted',
            toolNamespace: 'search',
        })).toThrow(/canonical MCP tool namespace/);

        expect(host.registrations().mcpBackendClients).toEqual([]);
    });
});
