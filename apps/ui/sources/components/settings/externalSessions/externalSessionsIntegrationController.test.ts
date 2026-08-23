import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';

import {
    createExternalSessionsIntegrationOperations,
    refreshExternalSessionsIntegrationStatuses,
    type ExternalSessionsHookManagementTransport,
    type ExternalSessionsKnownAgent,
    useExternalSessionsIntegrationController,
} from './externalSessionsIntegrationController';
import {
    resolveExternalSessionsIntegrationActions,
    type ExternalSessionsIntegrationDescriptor,
} from './externalSessionsIntegrationModel';

const agent = {
    pluginId: 'com.example.external-agent',
    localId: 'assistant',
} as const;
const previewId = `hook-install-preview:v1:${'a'.repeat(64)}` as const;
const installPreview = {
    previewId,
    targets: [{
        targetId: 'settings',
        absolutePath: '/tmp/settings.json',
        changes: [{
            kind: 'append_json_array_entry' as const,
            collectionId: 'hooks',
            eventId: 'session-start',
            nativeEventName: 'SessionStart',
            entry: {
                matcher: null,
                hooks: [{
                    type: 'command' as const,
                    command: 'happier hook',
                    timeout: 500,
                }] as const,
            },
        }],
    }],
} as const;
const refreshedPreviewId = `hook-install-preview:v1:${'b'.repeat(64)}` as const;
const refreshedInstallPreview = {
    ...installPreview,
    previewId: refreshedPreviewId,
} as const;

describe('externalSessionsIntegrationController', () => {
    it('queries a fresh preview before installing and returns to the refreshed review state without retrying', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValue({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'not_installed',
                        installPreview: refreshedInstallPreview,
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            });
        const install = vi.fn<ExternalSessionsHookManagementTransport['install']>()
            .mockResolvedValue({
                ok: false,
                diagnostic: { code: 'concurrent_edit', retryable: true },
            });
        const refresh = vi.fn();
        const operations = createExternalSessionsIntegrationOperations({
            transport: {
                status,
                install,
                disable: vi.fn(),
                enable: vi.fn(),
                uninstall: vi.fn(),
            },
            refresh,
            applyStatus: vi.fn(),
        });
        const integration = {
            key: 'preview',
            machineId: 'machine-1',
            agent,
            agentTitle: 'Third-party assistant',
            state: 'not_installed',
            installPreview,
        } as const;

        await expect(operations.reviewAndInstall(
            integration,
            async () => true,
        )).resolves.toBeUndefined();
        expect(status).toHaveBeenCalledOnce();
        expect(status).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: undefined,
            intent: 'install_preview',
            agent,
        });
        expect(install).toHaveBeenCalledTimes(1);
        expect(install).toHaveBeenCalledWith({
            machineId: 'machine-1',
            agent,
            expectedPreviewId: refreshedPreviewId,
        });
        expect(refresh).toHaveBeenCalledWith(integration);
    });

    it('renders the direct Install result without a hidden status refresh', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValue({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'not_installed',
                        installPreview: refreshedInstallPreview,
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            });
        const install = vi.fn<ExternalSessionsHookManagementTransport['install']>()
            .mockResolvedValue({
                ok: true,
                status: {
                    state: 'installed_enabled',
                    installationId: 'installation-current',
                },
            });
        const refresh = vi.fn();
        const applyStatus = vi.fn();
        const operations = createExternalSessionsIntegrationOperations({
            transport: {
                status,
                install,
                disable: vi.fn(),
                enable: vi.fn(),
                uninstall: vi.fn(),
            },
            refresh,
            applyStatus,
        });
        const integration = {
            key: 'preview',
            machineId: 'machine-1',
            agent,
            agentTitle: 'Third-party assistant',
            state: 'not_installed',
            installPreview,
        } as const;

        await operations.reviewAndInstall(integration, async () => true);

        expect(applyStatus).toHaveBeenCalledWith(integration, {
            state: 'installed_enabled',
            installationId: 'installation-current',
        });
        expect(applyStatus).toHaveBeenCalledTimes(1);
        expect(install).toHaveBeenCalledWith({
            machineId: 'machine-1',
            agent,
            expectedPreviewId: refreshedPreviewId,
        });
        expect(refresh).not.toHaveBeenCalled();
    });

    it('does not dispatch a mutation after its execution scope is no longer current', async () => {
        const disable = vi.fn<ExternalSessionsHookManagementTransport['disable']>()
            .mockResolvedValue({
                ok: true,
                status: {
                    state: 'installed_disabled',
                    installationId: 'installation-current',
                },
            });
        const operations = createExternalSessionsIntegrationOperations({
            transport: {
                status: vi.fn(),
                install: vi.fn(),
                disable,
                enable: vi.fn(),
                uninstall: vi.fn(),
            },
            refresh: vi.fn(),
            applyStatus: vi.fn(),
            isCurrentScope: () => false,
        });
        const integration = {
            key: 'installed',
            machineId: 'machine-1',
            agent,
            agentTitle: 'Third-party assistant',
            state: 'installed_enabled',
            installationId: 'installation-current',
        } as const;

        await operations.disable(integration);

        expect(disable).not.toHaveBeenCalled();
    });

    it('allows a no-custody needs-attention row to request an install preview for any Agent diagnostic', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValue({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'not_installed',
                        installPreview,
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            });
        const install = vi.fn<ExternalSessionsHookManagementTransport['install']>()
            .mockResolvedValue({
                ok: true,
                status: {
                    state: 'installed_enabled',
                    installationId: 'installation-current',
                },
            });
        const applyStatus = vi.fn();
        const operations = createExternalSessionsIntegrationOperations({
            transport: {
                status,
                install,
                disable: vi.fn(),
                enable: vi.fn(),
                uninstall: vi.fn(),
            },
            refresh: vi.fn(),
            applyStatus,
        });
        const integration = {
            key: 'attention',
            machineId: 'machine-1',
            agent,
            agentTitle: 'Third-party assistant',
            state: 'needs_attention',
            diagnostic: {
                code: 'agent.hooks.configuration_attention',
                severity: 'warning',
            },
        } as const;

        await expect(operations.reviewAndInstall(
            integration,
            async () => true,
        )).resolves.toBeUndefined();

        expect(status).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: undefined,
            intent: 'install_preview',
            agent,
        });
        expect(install).toHaveBeenCalledOnce();
        expect(applyStatus).toHaveBeenCalledOnce();
    });

    it('obtains and confirms one install preview in the same Review and Install action', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValue({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'not_installed',
                        installPreview,
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            });
        const install = vi.fn<ExternalSessionsHookManagementTransport['install']>()
            .mockResolvedValue({
                ok: true,
                status: {
                    state: 'installed_enabled',
                    installationId: 'installation-current',
                },
            });
        const confirm = vi.fn(async () => true);
        const refresh = vi.fn();
        const applyStatus = vi.fn();
        const operations = createExternalSessionsIntegrationOperations({
            serverId: 'server-1',
            transport: {
                status,
                install,
                disable: vi.fn(),
                enable: vi.fn(),
                uninstall: vi.fn(),
            },
            refresh,
            applyStatus,
        });
        const integration = {
            key: 'preview-required',
            machineId: 'machine-1',
            agent,
            agentTitle: 'Third-party assistant',
            state: 'not_installed',
        } as const;

        await operations.reviewAndInstall(integration, confirm);

        expect(status).toHaveBeenCalledOnce();
        expect(status).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            intent: 'install_preview',
            agent,
        });
        expect(confirm).toHaveBeenCalledWith(installPreview);
        expect(install).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            agent,
            expectedPreviewId: previewId,
        });
        expect(applyStatus).toHaveBeenCalledOnce();
        expect(applyStatus).toHaveBeenCalledWith(integration, {
            state: 'installed_enabled',
            installationId: 'installation-current',
        });
        expect(refresh).not.toHaveBeenCalled();
    });

    it('requests a new invocation-local preview after cancellation', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'not_installed',
                        installPreview,
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'not_installed',
                        installPreview: refreshedInstallPreview,
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            });
        const install = vi.fn<ExternalSessionsHookManagementTransport['install']>()
            .mockResolvedValue({
                ok: true,
                status: {
                    state: 'installed_enabled',
                    installationId: 'installation-current',
                },
            });
        const confirm = vi.fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const applyStatus = vi.fn();
        const operations = createExternalSessionsIntegrationOperations({
            transport: {
                status,
                install,
                disable: vi.fn(),
                enable: vi.fn(),
                uninstall: vi.fn(),
            },
            refresh: vi.fn(),
            applyStatus,
        });
        const integration = {
            key: 'preview-required',
            machineId: 'machine-1',
            agent,
            agentTitle: 'Third-party assistant',
            state: 'not_installed',
        } as const;

        await operations.reviewAndInstall(integration, confirm);
        await operations.reviewAndInstall(integration, confirm);

        expect(status).toHaveBeenCalledTimes(2);
        expect(confirm).toHaveBeenNthCalledWith(1, installPreview);
        expect(confirm).toHaveBeenNthCalledWith(2, refreshedInstallPreview);
        expect(install).toHaveBeenCalledOnce();
        expect(install).toHaveBeenCalledWith({
            machineId: 'machine-1',
            agent,
            expectedPreviewId: refreshedPreviewId,
        });
        expect(applyStatus).toHaveBeenCalledOnce();
        expect(applyStatus).toHaveBeenCalledWith(integration, {
            state: 'installed_enabled',
            installationId: 'installation-current',
        });
    });

    it('keeps every other row actionable while one row is being rechecked', async () => {
        const agentB = { pluginId: 'com.example.external-agent', localId: 'assistant-b' } as const;
        const rechecked = createDeferred<
            Awaited<ReturnType<ExternalSessionsHookManagementTransport['status']>>
        >();
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [
                    { agent, status: { state: 'installed_enabled', installationId: 'installation-a' } },
                    { agent: agentB, status: { state: 'installed_enabled', installationId: 'installation-b' } },
                ],
                nextCursor: null,
                diagnostics: [],
            })
            .mockImplementationOnce(async () => await rechecked.promise);
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable: vi.fn(),
            uninstall: vi.fn(),
        };
        const hook = await renderHook(
            () => useExternalSessionsIntegrationController({
                machineId: 'machine-1',
                projectionGeneration: 1,
                knownAgents: [
                    { agent, agentTitle: 'Assistant A' },
                    { agent: agentB, agentTitle: 'Assistant B' },
                ],
                transport,
            }),
        );
        expect(hook.getCurrent().integrations).toHaveLength(2);
        const rowA = hook.getCurrent().integrations![0]!;
        const rowB = hook.getCurrent().integrations![1]!;

        let recheck!: Promise<void>;
        act(() => {
            recheck = hook.getCurrent().operations!.checkAgain(rowA);
        });
        await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
        await flushHookEffects();

        // Rechecking one installation is row-local work. The inventory it belongs to is
        // unchanged, so the OTHER rows keep their actions instead of being emptied by a
        // global loading state.
        expect(hook.getCurrent().inventoryState.status).toBe('ready');
        expect(hook.getCurrent().operations).not.toBeNull();
        expect(resolveExternalSessionsIntegrationActions(rowB, hook.getCurrent().operations))
            .toEqual(['disable', 'uninstall', 'check_again']);

        rechecked.resolve({
            ok: false,
            diagnostic: { code: 'listener_unavailable', retryable: true },
        });
        // A failed row-local recheck surfaces through that row's own action, not by
        // retiring the whole inventory behind a global retry.
        await act(async () => {
            await expect(recheck).rejects.toThrow('listener_unavailable');
        });
        expect(hook.getCurrent().inventoryState.status).toBe('ready');
        expect(hook.getCurrent().operations).not.toBeNull();
        expect(resolveExternalSessionsIntegrationActions(rowB, hook.getCurrent().operations))
            .toEqual(['disable', 'uninstall', 'check_again']);
        expect(hook.getCurrent().integrations).toHaveLength(2);

        await hook.unmount();
    });

    it('does not let one row\'s Review and Install invalidate another row\'s in-flight preview', async () => {
        const agentB = { pluginId: 'com.example.external-agent', localId: 'assistant-b' } as const;
        const previewA = createDeferred<
            Awaited<ReturnType<ExternalSessionsHookManagementTransport['status']>>
        >();
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [
                    { agent, status: { state: 'not_installed' } },
                    { agent: agentB, status: { state: 'not_installed' } },
                ],
                nextCursor: null,
                diagnostics: [],
            })
            .mockImplementationOnce(async () => await previewA.promise)
            .mockResolvedValueOnce({
                ok: true,
                rows: [{ agent: agentB, status: { state: 'not_installed', installPreview: refreshedInstallPreview } }],
                nextCursor: null,
                diagnostics: [],
            });
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable: vi.fn(),
            uninstall: vi.fn(),
        };
        const hook = await renderHook(
            () => useExternalSessionsIntegrationController({
                machineId: 'machine-1',
                projectionGeneration: 1,
                knownAgents: [
                    { agent, agentTitle: 'Assistant A' },
                    { agent: agentB, agentTitle: 'Assistant B' },
                ],
                transport,
            }),
        );
        const rowA = hook.getCurrent().integrations![0]!;
        const rowB = hook.getCurrent().integrations![1]!;
        const confirmA = vi.fn(async () => false);
        const confirmB = vi.fn(async () => false);

        let reviewA!: Promise<void>;
        act(() => {
            reviewA = hook.getCurrent().operations!.reviewAndInstall(rowA, confirmA);
        });
        await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));

        // Row B is independently pressable, so starting its review must not silently
        // finish row A's with no confirmation, error or result.
        await act(async () => {
            await hook.getCurrent().operations!.reviewAndInstall(rowB, confirmB);
        });
        expect(confirmB).toHaveBeenCalledWith(refreshedInstallPreview);

        previewA.resolve({
            ok: true,
            rows: [{ agent, status: { state: 'not_installed', installPreview } }],
            nextCursor: null,
            diagnostics: [],
        });
        await act(async () => await reviewA);

        expect(confirmA).toHaveBeenCalledWith(installPreview);
        await hook.unmount();
    });

    it('does not let an earlier preview result override a newer Review and Install intent', async () => {
        const stalePreview = createDeferred<
            Awaited<ReturnType<
                ExternalSessionsHookManagementTransport['status']
            >>
        >();
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'not_installed',
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            })
            .mockImplementationOnce(async () => await stalePreview.promise)
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'not_installed',
                        installPreview: refreshedInstallPreview,
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            });
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable: vi.fn(),
            uninstall: vi.fn(),
        };
        const hook = await renderHook(
            () => useExternalSessionsIntegrationController({
                machineId: 'machine-1',
                projectionGeneration: 1,
                agent: { agent, agentTitle: 'Third-party assistant' },
                transport,
            }),
        );
        const integration = hook.getCurrent().integrations?.[0];
        if (!integration) throw new Error('Expected integration');
        const operations = hook.getCurrent().operations;
        if (!operations) throw new Error('Expected operations');
        const firstConfirm = vi.fn(async () => false);
        const secondConfirm = vi.fn(async () => false);

        let firstReview!: Promise<void>;
        act(() => {
            firstReview = operations.reviewAndInstall(
                integration,
                firstConfirm,
            );
        });
        await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
        await act(async () => {
            await operations.reviewAndInstall(integration, secondConfirm);
        });
        expect(secondConfirm).toHaveBeenCalledWith(refreshedInstallPreview);

        stalePreview.resolve({
            ok: true,
            rows: [{
                agent,
                status: {
                    state: 'not_installed',
                    installPreview,
                },
            }],
            nextCursor: null,
            diagnostics: [],
        });
        await act(async () => await firstReview);

        expect(firstConfirm).not.toHaveBeenCalled();
        expect(hook.getCurrent().integrations?.[0]).not.toHaveProperty(
            'installPreview',
        );
        expect(transport.install).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('refreshes passive truth without confirmation when custody appears before install preview', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValue({
                ok: false,
                diagnostic: {
                    code: 'concurrent_edit',
                    retryable: true,
                },
            });
        const install = vi.fn();
        const confirm = vi.fn(async () => true);
        const refresh = vi.fn();
        const operations = createExternalSessionsIntegrationOperations({
            transport: {
                status,
                install,
                disable: vi.fn(),
                enable: vi.fn(),
                uninstall: vi.fn(),
            },
            refresh,
            applyStatus: vi.fn(),
        });
        const integration = {
            key: 'preview-raced',
            machineId: 'machine-1',
            agent,
            agentTitle: 'Third-party assistant',
            state: 'not_installed',
        } as const;

        await operations.reviewAndInstall(integration, confirm);

        expect(status).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: undefined,
            intent: 'install_preview',
            agent,
        });
        expect(refresh).toHaveBeenCalledWith(integration);
        expect(confirm).not.toHaveBeenCalled();
        expect(install).not.toHaveBeenCalled();
    });

    it('performs one bounded inventory page read and adapts the obtainable rows', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_enabled',
                        installationId: 'installation-1',
                    },
                }],
                nextCursor: 'page-2',
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                        agent: {
                            pluginId: 'com.example.removed-agent',
                            localId: 'removed',
                        },
                        status: {
                            state: 'unavailable',
                            installationId: 'installation-removed',
                        },
                }],
                nextCursor: null,
                diagnostics: [],
            })
            .mockResolvedValue({
                ok: true,
                rows: [],
                nextCursor: null,
                diagnostics: [],
            });
        const integrations = await refreshExternalSessionsIntegrationStatuses({
            machineId: 'machine-1',
            serverId: 'server-1',
            knownAgents: [{
                agent,
                agentTitle: 'Projected assistant title',
            }],
            transport: {
                status,
                install: vi.fn(),
                disable: vi.fn(),
                enable: vi.fn(),
                uninstall: vi.fn(),
            },
        });

        expect(status).toHaveBeenCalledOnce();
        expect(status).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            intent: 'passive_inventory',
            limit: 50,
        });
        expect(integrations).toEqual([
            {
                key: 'machine-1\u0000com.example.external-agent\u0000assistant\u0000installation:installation-1',
                machineId: 'machine-1',
                agent,
                agentTitle: 'Projected assistant title',
                state: 'installed_enabled',
                installationId: 'installation-1',
            },
        ]);
    });

    it('publishes one bounded inventory page and requests the continuation only on demand', async () => {
        const secondPage = createDeferred<Awaited<ReturnType<ExternalSessionsHookManagementTransport['status']>>>();
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_enabled',
                        installationId: 'installation-1',
                    },
                }],
                nextCursor: 'page-2',
                diagnostics: [],
            })
            .mockImplementationOnce(async () => await secondPage.promise);
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable: vi.fn(),
            uninstall: vi.fn(),
        };
        const hook = await renderHook(
            () => useExternalSessionsIntegrationController({
                machineId: 'machine-1',
                projectionGeneration: 1,
                transport,
            }),
        );

        expect(status).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().integrations).toEqual([
            expect.objectContaining({ installationId: 'installation-1' }),
        ]);
        expect(hook.getCurrent().inventoryState.status).toBe('ready');
        expect(hook.getCurrent().hasMoreInventory).toBe(true);
        expect(hook.getCurrent().loadingMoreInventory).toBe(false);
        expect(status).toHaveBeenCalledTimes(1);

        let firstLoadMore!: Promise<void>;
        let duplicateLoadMore!: Promise<void>;
        act(() => {
            firstLoadMore = hook.getCurrent().loadMoreInventory();
            duplicateLoadMore = hook.getCurrent().loadMoreInventory();
        });
        await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
        expect(status).toHaveBeenLastCalledWith({
            machineId: 'machine-1',
            serverId: undefined,
            intent: 'passive_inventory',
            cursor: 'page-2',
            limit: 50,
        });
        expect(hook.getCurrent().loadingMoreInventory).toBe(true);

        secondPage.resolve({
            ok: true,
            rows: [{
                agent,
                status: {
                    state: 'installed_enabled',
                    installationId: 'installation-2',
                },
            }],
            nextCursor: null,
            diagnostics: [],
        });
        await act(async () => {
            await Promise.all([firstLoadMore, duplicateLoadMore]);
        });

        expect(hook.getCurrent().integrations).toEqual([
            expect.objectContaining({ installationId: 'installation-1' }),
            expect.objectContaining({ installationId: 'installation-2' }),
        ]);
        expect(hook.getCurrent().inventoryState.status).toBe('ready');
        expect(hook.getCurrent().hasMoreInventory).toBe(false);
        expect(hook.getCurrent().loadingMoreInventory).toBe(false);
        expect(status).toHaveBeenCalledTimes(2);
        await hook.unmount();
    });

    it('does not append an older continuation after an explicit root refresh becomes current', async () => {
        const staleContinuation = createDeferred<Awaited<ReturnType<ExternalSessionsHookManagementTransport['status']>>>();
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_enabled',
                        installationId: 'installation-old-root',
                    },
                }],
                nextCursor: 'page-2',
                diagnostics: [],
            })
            .mockImplementationOnce(async () => await staleContinuation.promise)
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_enabled',
                        installationId: 'installation-current-root',
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            });
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable: vi.fn(),
            uninstall: vi.fn(),
        };
        const hook = await renderHook(
            () => useExternalSessionsIntegrationController({
                machineId: 'machine-1',
                projectionGeneration: 1,
                transport,
            }),
        );

        let staleLoadMore!: Promise<void>;
        act(() => {
            staleLoadMore = hook.getCurrent().loadMoreInventory();
        });
        await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
        await act(async () => {
            await hook.getCurrent().retryInventory();
        });
        expect(hook.getCurrent().integrations).toEqual([
            expect.objectContaining({ installationId: 'installation-current-root' }),
        ]);

        staleContinuation.resolve({
            ok: true,
            rows: [{
                agent,
                status: {
                    state: 'installed_enabled',
                    installationId: 'installation-stale-page',
                },
            }],
            nextCursor: null,
            diagnostics: [],
        });
        await act(async () => {
            await staleLoadMore;
        });

        expect(hook.getCurrent().integrations).toEqual([
            expect.objectContaining({ installationId: 'installation-current-root' }),
        ]);
        expect(hook.getCurrent().hasMoreInventory).toBe(false);
        await hook.unmount();
    });

    it('does not apply an older root inventory after the Agent scope changes before the refresh effect', async () => {
        const staleRoot = createDeferred<
            Awaited<ReturnType<ExternalSessionsHookManagementTransport['status']>>
        >();
        const currentRoot = createDeferred<
            Awaited<ReturnType<ExternalSessionsHookManagementTransport['status']>>
        >();
        const nextAgent = {
            pluginId: 'com.example.next-agent',
            localId: 'assistant',
        } as const;
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockImplementationOnce(async () => await staleRoot.promise)
            .mockImplementationOnce(async () => await currentRoot.promise);
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable: vi.fn(),
            uninstall: vi.fn(),
        };
        type HookProps = Readonly<{
            agent: ExternalSessionsKnownAgent;
            projectionGeneration: number;
        }>;
        const initialProps: HookProps = {
            agent: { agent, agentTitle: 'Previous assistant' },
            projectionGeneration: 1,
        };
        const nextProps: HookProps = {
            agent: { agent: nextAgent, agentTitle: 'Current assistant' },
            projectionGeneration: 2,
        };
        const hook = await renderHook(
            (props: HookProps) => useExternalSessionsIntegrationController({
                machineId: 'machine-1',
                projectionGeneration: props.projectionGeneration,
                agent: props.agent,
                transport,
            }),
            { initialProps },
        );
        expect(status).toHaveBeenCalledOnce();

        type FiberHook = Readonly<{
            memoizedState: { current: unknown };
        }>;
        const scopeSignatureRef = (
            hook.tree.root as unknown as Readonly<{
                _fiber: Readonly<{ memoizedState: FiberHook }>;
            }>
        )._fiber.memoizedState.memoizedState;
        // Advance the render-owned scope ref without flushing its passive refresh effect.
        scopeSignatureRef.current = 'scope-changed-during-render';
        await act(async () => {
            staleRoot.resolve({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_enabled',
                        installationId: 'installation-stale-root',
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            });
            await staleRoot.promise;
            await Promise.resolve();
        });
        expect(status).toHaveBeenCalledOnce();
        expect(hook.getCurrent().integrations).toBeNull();

        const rerendering = hook.rerender(nextProps);
        await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
        await rerendering;
        expect(hook.getCurrent().integrations).toBeNull();
        expect(hook.getCurrent().inventoryState.status).toBe('loading');

        currentRoot.resolve({
            ok: true,
            rows: [{
                agent: nextAgent,
                status: {
                    state: 'installed_enabled',
                    installationId: 'installation-current-root',
                },
            }],
            nextCursor: null,
            diagnostics: [],
        });
        await act(async () => {
            await currentRoot.promise;
            await flushHookEffects();
        });

        expect(hook.getCurrent().integrations).toEqual([
            expect.objectContaining({
                agent: nextAgent,
                agentTitle: 'Current assistant',
                installationId: 'installation-current-root',
            }),
        ]);
        expect(hook.getCurrent().inventoryState.status).toBe('ready');
        await hook.unmount();
    });

    it('fails closed instead of rendering a partial inventory when a page reports diagnostics', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValue({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_enabled',
                        installationId: 'installation-1',
                    },
                }],
                nextCursor: null,
                diagnostics: [{
                    code: 'installation_record_read_failed',
                    retryable: true,
                }],
            });

        await expect(refreshExternalSessionsIntegrationStatuses({
            machineId: 'machine-1',
            transport: {
                status,
                install: vi.fn(),
                disable: vi.fn(),
                enable: vi.fn(),
                uninstall: vi.fn(),
            },
        })).resolves.toBeNull();
    });

    it('keeps obtainable rows and diagnostics while stopping a repeated continuation cursor', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_enabled',
                        installationId: 'installation-1',
                    },
                }],
                nextCursor: 'repeated',
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_enabled',
                        installationId: 'installation-2',
                    },
                }],
                nextCursor: 'repeated',
                diagnostics: [{
                    code: 'installation_record_read_failed',
                    retryable: true,
                }],
            });
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable: vi.fn(),
            uninstall: vi.fn(),
        };

        const hook = await renderHook(
            () => useExternalSessionsIntegrationController({
                machineId: 'machine-1',
                projectionGeneration: 1,
                transport,
            }),
        );
        expect(status).toHaveBeenCalledOnce();
        expect(hook.getCurrent().hasMoreInventory).toBe(true);

        await act(async () => {
            await hook.getCurrent().loadMoreInventory();
        });

        expect(status).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().integrations).toEqual([
            expect.objectContaining({ installationId: 'installation-1' }),
            expect.objectContaining({ installationId: 'installation-2' }),
        ]);
        expect(hook.getCurrent().hasMoreInventory).toBe(false);
        expect(hook.getCurrent().inventoryState).toEqual({
            status: 'partial',
            diagnosticCodes: [
                'installation_record_read_failed',
                'inventory_cursor_repeated',
            ],
        });
        await hook.unmount();
    });

    it('continues bounded pagination after partial diagnostics and keeps obtainable rows actionable', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_enabled',
                        installationId: 'installation-current',
                    },
                }],
                nextCursor: 'page-2',
                diagnostics: [{
                    code: 'installation_record_read_failed',
                    retryable: true,
                }],
            })
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent: {
                        pluginId: 'com.example.removed-agent',
                        localId: 'removed',
                    },
                    status: {
                        state: 'unavailable',
                        installationId: 'installation-removed',
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            });
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable: vi.fn(),
            uninstall: vi.fn().mockResolvedValue({
                ok: true,
                status: { state: 'not_installed' },
            }),
        };
        const hook = await renderHook(
            () => useExternalSessionsIntegrationController({
                machineId: 'machine-1',
                projectionGeneration: 1,
                transport,
            }),
        );

        expect(status).toHaveBeenCalledOnce();
        expect(hook.getCurrent().integrations?.map((integration) => (
            'installationId' in integration ? integration.installationId : null
        ))).toEqual(['installation-current']);

        await act(async () => {
            await hook.getCurrent().loadMoreInventory();
        });

        expect(status).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().integrations?.map((integration) => (
            'installationId' in integration ? integration.installationId : null
        ))).toEqual(['installation-current', 'installation-removed']);
        expect(hook.getCurrent().inventoryState).toEqual({
            status: 'partial',
            diagnosticCodes: ['installation_record_read_failed'],
        });
        expect(hook.getCurrent().operations).not.toBeNull();

        await act(async () => {
            await hook.getCurrent().operations?.uninstall(
                hook.getCurrent().integrations?.[1]!,
            );
        });
        expect(transport.uninstall).toHaveBeenCalledWith({
            machineId: 'machine-1',
            agent: {
                pluginId: 'com.example.removed-agent',
                localId: 'removed',
            },
            installationId: 'installation-removed',
        });
        expect(hook.getCurrent().integrations).toEqual([
            expect.objectContaining({
                installationId: 'installation-current',
                state: 'installed_enabled',
            }),
            expect.objectContaining({
                agent: {
                    pluginId: 'com.example.removed-agent',
                    localId: 'removed',
                },
                state: 'not_installed',
            }),
        ]);
        expect(hook.getCurrent().inventoryState).toEqual({
            status: 'partial',
            diagnosticCodes: ['installation_record_read_failed'],
        });

        await hook.unmount();
    });

    it('preserves passive inventory diagnostics when Check Again refreshes one installation', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_enabled',
                        installationId: 'installation-current',
                    },
                }],
                nextCursor: null,
                diagnostics: [{
                    code: 'installation_record_read_failed',
                    retryable: true,
                }],
            })
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_disabled',
                        installationId: 'installation-current',
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            });
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable: vi.fn(),
            uninstall: vi.fn(),
        };
        const hook = await renderHook(
            () => useExternalSessionsIntegrationController({
                machineId: 'machine-1',
                projectionGeneration: 1,
                transport,
            }),
        );

        const integration = hook.getCurrent().integrations?.[0];
        if (!integration) throw new Error('Expected integration');
        expect(hook.getCurrent().inventoryState).toEqual({
            status: 'partial',
            diagnosticCodes: ['installation_record_read_failed'],
        });

        await act(async () => {
            await hook.getCurrent().operations?.checkAgain(integration);
        });

        expect(hook.getCurrent().integrations).toEqual([
            expect.objectContaining({
                state: 'installed_disabled',
                installationId: 'installation-current',
            }),
        ]);
        expect(hook.getCurrent().inventoryState).toEqual({
            status: 'partial',
            diagnosticCodes: ['installation_record_read_failed'],
        });
        await hook.unmount();
    });

    it.each([
        { targetIndex: 0, action: 'enable' as const },
        { targetIndex: 1, action: 'uninstall' as const },
    ])(
        'preserves row order and unchanged row identity when $action updates row $targetIndex',
        async ({ targetIndex, action }) => {
            const agents = ['first', 'middle', 'last'].map((localId) => ({
                pluginId: `com.example.${localId}`,
                localId,
            }));
            const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
                .mockResolvedValue({
                    ok: true,
                    rows: agents.map((rowAgent) => ({
                        agent: rowAgent,
                        status: {
                            state: 'installed_disabled' as const,
                            installationId: `installation-${rowAgent.localId}`,
                        },
                    })),
                    nextCursor: null,
                    diagnostics: [],
                });
            const enable = vi.fn<ExternalSessionsHookManagementTransport['enable']>()
                .mockImplementation(async (input) => ({
                    ok: true,
                    status: {
                        state: 'installed_enabled',
                        installationId: input.installationId,
                    },
                }));
            const uninstall = vi.fn<ExternalSessionsHookManagementTransport['uninstall']>()
                .mockResolvedValue({
                    ok: true,
                    status: { state: 'not_installed' },
                });
            const transport = {
                status,
                install: vi.fn(),
                disable: vi.fn(),
                enable,
                uninstall,
            } satisfies ExternalSessionsHookManagementTransport;
            const hook = await renderHook(
                () => useExternalSessionsIntegrationController({
                    machineId: 'machine-1',
                    projectionGeneration: 1,
                    transport,
                }),
            );
            const before = hook.getCurrent().integrations;
            const target = before?.[targetIndex];
            if (!before || !target) throw new Error('Expected integration rows');

            await act(async () => {
                if (action === 'enable') {
                    await hook.getCurrent().operations?.enable(target);
                } else {
                    await hook.getCurrent().operations?.uninstall(target);
                }
            });

            const after = hook.getCurrent().integrations;
            expect(after?.map((integration) => integration.agent.localId)).toEqual([
                'first',
                'middle',
                'last',
            ]);
            expect(after?.[targetIndex]?.state).toBe(
                action === 'enable' ? 'installed_enabled' : 'not_installed',
            );
            if (action === 'enable') {
                expect(after?.[targetIndex]).toEqual(expect.objectContaining({
                    installationId: `installation-${target.agent.localId}`,
                }));
            }
            before.forEach((integration, index) => {
                if (index !== targetIndex) expect(after?.[index]).toBe(integration);
            });
            expect(action === 'enable' ? enable : uninstall).toHaveBeenCalledOnce();
            expect(status).toHaveBeenCalledOnce();
            await hook.unmount();
        },
    );

    it('renders the direct Enable result without a hidden status refresh', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_disabled',
                        installationId: 'installation-next',
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            });
        const enable = vi.fn<ExternalSessionsHookManagementTransport['enable']>()
            .mockResolvedValue({
                ok: true,
                status: {
                    state: 'installed_enabled',
                    installationId: 'installation-current',
                },
            });
        const refresh = vi.fn();
        const applyStatus = vi.fn();
        const operations = createExternalSessionsIntegrationOperations({
            serverId: 'server-1',
            transport: {
                status,
                install: vi.fn(),
                disable: vi.fn(),
                enable,
                uninstall: vi.fn(),
            },
            refresh,
            applyStatus,
        });
        const integration = {
            key: 'machine-1\u0000com.example.external-agent\u0000assistant',
            machineId: 'machine-1',
            agent,
            agentTitle: 'Third-party assistant',
            state: 'installed_disabled',
            installationId: 'installation-current',
        } as const;

        await operations.enable(integration);

        expect(enable).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            agent,
            installationId: 'installation-current',
        });
        expect(applyStatus).toHaveBeenCalledWith(integration, {
            state: 'installed_enabled',
            installationId: 'installation-current',
        });
        expect(refresh).not.toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
    });

    it('renders the direct Uninstall result without a hidden status refresh', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>();
        const uninstall = vi.fn<ExternalSessionsHookManagementTransport['uninstall']>()
            .mockResolvedValue({
                ok: true,
                status: {
                    state: 'not_installed',
                },
            });
        const refresh = vi.fn();
        const applyStatus = vi.fn();
        const operations = createExternalSessionsIntegrationOperations({
            serverId: 'server-1',
            transport: {
                status,
                install: vi.fn(),
                disable: vi.fn(),
                enable: vi.fn(),
                uninstall,
            },
            refresh,
            applyStatus,
        });
        const integration = {
            key: 'machine-1\u0000com.example.external-agent\u0000assistant\u0000installation:installation-current',
            machineId: 'machine-1',
            agent,
            agentTitle: 'Third-party assistant',
            state: 'installed_enabled',
            installationId: 'installation-current',
        } as const;

        await operations.uninstall(integration);

        expect(uninstall).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            agent,
            installationId: 'installation-current',
        });
        expect(applyStatus).toHaveBeenCalledWith(integration, {
            state: 'not_installed',
        });
        expect(refresh).not.toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
    });

    it('keeps a direct action result authoritative over an older passive refresh', async () => {
        const staleInventory = createDeferred<
            Awaited<ReturnType<
                ExternalSessionsHookManagementTransport['status']
            >>
        >();
        const disabledStatus = {
            ok: true as const,
            rows: [{
                agent,
                status: {
                    state: 'installed_disabled' as const,
                    installationId: 'installation-current',
                },
            }],
            nextCursor: null,
            diagnostics: [],
        };
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce(disabledStatus)
            .mockImplementationOnce(async () => await staleInventory.promise);
        const enableResult = createDeferred<
            Awaited<ReturnType<
                ExternalSessionsHookManagementTransport['enable']
            >>
        >();
        const enable = vi.fn<ExternalSessionsHookManagementTransport['enable']>(
            async () => await enableResult.promise,
        );
        const enabledResult = {
                ok: true,
                status: {
                    state: 'installed_enabled' as const,
                    installationId: 'installation-current',
                },
            } as const;
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable,
            uninstall: vi.fn(),
        };
        const hook = await renderHook(
            () => useExternalSessionsIntegrationController({
                machineId: 'machine-1',
                projectionGeneration: 1,
                agent: { agent, agentTitle: 'Third-party assistant' },
                transport,
            }),
        );
        const integration = hook.getCurrent().integrations?.[0];
        if (!integration) throw new Error('Expected integration');

        const operations = hook.getCurrent().operations;
        if (!operations) throw new Error('Expected operations');
        let enabling!: Promise<void>;
        act(() => {
            enabling = operations.enable(integration);
        });
        await vi.waitFor(() => expect(enable).toHaveBeenCalledOnce());
        let staleRefresh!: Promise<void>;
        act(() => {
            staleRefresh = hook.getCurrent().retryInventory();
        });
        await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
        enableResult.resolve(enabledResult);
        await act(async () => {
            await enabling;
        });
        expect(hook.getCurrent().integrations?.[0]?.state)
            .toBe('installed_enabled');

        staleInventory.resolve(disabledStatus);
        await act(async () => await staleRefresh);

        expect(hook.getCurrent().integrations?.[0]?.state)
            .toBe('installed_enabled');
        expect(hook.getCurrent().inventoryState.status).toBe('ready');
        await hook.unmount();
    });

    it.each([
        {
            action: 'enable',
            initialState: 'installed_disabled',
            directState: 'installed_enabled',
        },
        {
            action: 'disable',
            initialState: 'installed_enabled',
            directState: 'installed_disabled',
        },
    ] as const)(
        'ignores a stale direct $action result after switching machine scope without cancelling the new inventory',
        async ({ action, initialState, directState }) => {
            const machineTwoInventory = createDeferred<
                Awaited<ReturnType<
                    ExternalSessionsHookManagementTransport['status']
                >>
            >();
            const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
                .mockResolvedValueOnce({
                    ok: true,
                    rows: [{
                        agent,
                        status: {
                            state: initialState,
                            installationId: 'installation-current',
                        },
                    }],
                    nextCursor: null,
                    diagnostics: [],
                })
                .mockImplementationOnce(async () => await machineTwoInventory.promise);
            const mutationResult = createDeferred<
                Awaited<ReturnType<
                    ExternalSessionsHookManagementTransport[typeof action]
                >>
            >();
            const mutation = vi.fn<
                ExternalSessionsHookManagementTransport[typeof action]
            >(async () => await mutationResult.promise);
            const transport = {
                status,
                install: vi.fn(),
                disable: action === 'disable' ? mutation : vi.fn(),
                enable: action === 'enable' ? mutation : vi.fn(),
                uninstall: vi.fn(),
            } satisfies ExternalSessionsHookManagementTransport;
            const hook = await renderHook(
                (props: { machineId: string }) => (
                    useExternalSessionsIntegrationController({
                        machineId: props.machineId,
                        projectionGeneration: 1,
                        agent: { agent, agentTitle: 'Third-party assistant' },
                        transport,
                    })
                ),
                { initialProps: { machineId: 'machine-1' } },
            );
            const integration = hook.getCurrent().integrations?.[0];
            if (!integration) throw new Error('Expected integration');
            let mutating!: Promise<void>;

            act(() => {
                mutating = hook.getCurrent().operations![action](integration);
            });
            await vi.waitFor(() => expect(mutation).toHaveBeenCalledOnce());
            await hook.rerender({ machineId: 'machine-2' });
            await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));

            mutationResult.resolve({
                ok: true,
                status: {
                    state: directState,
                    installationId: 'installation-current',
                },
            });
            await act(async () => await mutating);
            expect(hook.getCurrent().inventoryState.status).toBe('loading');

            machineTwoInventory.resolve({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_disabled',
                        installationId: 'installation-current',
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            });
            await act(async () => {
                await flushHookEffects();
            });

            expect(hook.getCurrent().integrations).toEqual([
                expect.objectContaining({
                    machineId: 'machine-2',
                    state: 'installed_disabled',
                }),
            ]);
            expect(hook.getCurrent().inventoryState.status).toBe('ready');
            await hook.unmount();
        },
    );

    it('ignores a stale Uninstall result after switching machine scope without cancelling the new inventory', async () => {
        const machineTwoInventory = createDeferred<
            Awaited<ReturnType<
                ExternalSessionsHookManagementTransport['status']
            >>
        >();
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_enabled',
                        installationId: 'installation-current',
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            })
            .mockImplementationOnce(async () => await machineTwoInventory.promise)
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: { state: 'not_installed' },
                }],
                nextCursor: null,
                diagnostics: [],
            });
        const uninstallResult = createDeferred<
            Awaited<ReturnType<
                ExternalSessionsHookManagementTransport['uninstall']
            >>
        >();
        const uninstall = vi.fn<ExternalSessionsHookManagementTransport['uninstall']>(
            async () => await uninstallResult.promise,
        );
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable: vi.fn(),
            uninstall,
        } satisfies ExternalSessionsHookManagementTransport;
        const hook = await renderHook(
            (props: { machineId: string }) => (
                useExternalSessionsIntegrationController({
                    machineId: props.machineId,
                    projectionGeneration: 1,
                    agent: { agent, agentTitle: 'Third-party assistant' },
                    transport,
                })
            ),
            { initialProps: { machineId: 'machine-1' } },
        );
        const integration = hook.getCurrent().integrations?.[0];
        if (!integration) throw new Error('Expected integration');
        let uninstalling!: Promise<void>;

        act(() => {
            uninstalling = hook.getCurrent().operations!.uninstall(integration);
        });
        await vi.waitFor(() => expect(uninstall).toHaveBeenCalledOnce());
        await hook.rerender({ machineId: 'machine-2' });
        await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));

        uninstallResult.resolve({
            ok: true,
            status: { state: 'not_installed' },
        });
        await act(async () => await uninstalling);

        expect(status).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().inventoryState.status).toBe('loading');

        machineTwoInventory.resolve({
            ok: true,
            rows: [{
                agent,
                status: { state: 'not_installed' },
            }],
            nextCursor: null,
            diagnostics: [],
        });
        await act(async () => {
            await flushHookEffects();
        });

        expect(hook.getCurrent().integrations).toEqual([
            expect.objectContaining({
                machineId: 'machine-2',
                state: 'not_installed',
            }),
        ]);
        expect(hook.getCurrent().inventoryState.status).toBe('ready');
        await hook.unmount();
    });

    it('ignores a stale direct Enable result after the global Agent scope changes without cancelling the new inventory', async () => {
        const secondAgent = {
            pluginId: 'com.example.second-agent',
            localId: 'assistant',
        } as const;
        const initialKnownAgents: readonly ExternalSessionsKnownAgent[] = [{
            agent,
            agentTitle: 'Third-party assistant',
        }];
        const expandedKnownAgents: readonly ExternalSessionsKnownAgent[] = [
            ...initialKnownAgents,
            {
                agent: secondAgent,
                agentTitle: 'Second assistant',
            },
        ];
        const expandedInventory = createDeferred<
            Awaited<ReturnType<
                ExternalSessionsHookManagementTransport['status']
            >>
        >();
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_disabled',
                        installationId: 'installation-current',
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            })
            .mockImplementationOnce(async () => await expandedInventory.promise);
        const enableResult = createDeferred<
            Awaited<ReturnType<
                ExternalSessionsHookManagementTransport['enable']
            >>
        >();
        const enable = vi.fn<ExternalSessionsHookManagementTransport['enable']>(
            async () => await enableResult.promise,
        );
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable,
            uninstall: vi.fn(),
        } satisfies ExternalSessionsHookManagementTransport;
        const hook = await renderHook(
            (props: { knownAgents: readonly ExternalSessionsKnownAgent[] }) => (
                useExternalSessionsIntegrationController({
                    machineId: 'machine-1',
                    projectionGeneration: 1,
                    knownAgents: props.knownAgents,
                    transport,
                })
            ),
            { initialProps: { knownAgents: initialKnownAgents } },
        );
        const integration = hook.getCurrent().integrations?.[0];
        if (!integration) throw new Error('Expected integration');
        let enabling!: Promise<void>;

        act(() => {
            enabling = hook.getCurrent().operations!.enable(integration);
        });
        await vi.waitFor(() => expect(enable).toHaveBeenCalledOnce());
        await hook.rerender({ knownAgents: expandedKnownAgents });
        await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));

        enableResult.resolve({
            ok: true,
            status: {
                state: 'installed_enabled',
                installationId: 'installation-current',
            },
        });
        await act(async () => await enabling);
        expect(hook.getCurrent().inventoryState.status).toBe('loading');

        expandedInventory.resolve({
            ok: true,
            rows: [
                {
                    agent,
                    status: {
                        state: 'installed_disabled',
                        installationId: 'installation-current',
                    },
                },
                {
                    agent: secondAgent,
                    status: { state: 'not_installed' },
                },
            ],
            nextCursor: null,
            diagnostics: [],
        });
        await act(async () => {
            await flushHookEffects();
        });

        expect(hook.getCurrent().integrations).toEqual([
            expect.objectContaining({
                agent,
                state: 'installed_disabled',
            }),
            expect.objectContaining({
                agent: secondAgent,
                state: 'not_installed',
            }),
        ]);
        expect(hook.getCurrent().inventoryState.status).toBe('ready');
        await hook.unmount();
    });

    it('ignores a stale direct Install result after switching machine scope without cancelling the new inventory', async () => {
        const machineTwoInventory = createDeferred<
            Awaited<ReturnType<
                ExternalSessionsHookManagementTransport['status']
            >>
        >();
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: { state: 'not_installed' },
                }],
                nextCursor: null,
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'not_installed',
                        installPreview,
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            })
            .mockImplementationOnce(async () => await machineTwoInventory.promise);
        const installResult = createDeferred<
            Awaited<ReturnType<
                ExternalSessionsHookManagementTransport['install']
            >>
        >();
        const install = vi.fn<ExternalSessionsHookManagementTransport['install']>(
            async () => await installResult.promise,
        );
        const transport = {
            status,
            install,
            disable: vi.fn(),
            enable: vi.fn(),
            uninstall: vi.fn(),
        } satisfies ExternalSessionsHookManagementTransport;
        const hook = await renderHook(
            (props: { machineId: string }) => (
                useExternalSessionsIntegrationController({
                    machineId: props.machineId,
                    projectionGeneration: 1,
                    agent: { agent, agentTitle: 'Third-party assistant' },
                    transport,
                })
            ),
            { initialProps: { machineId: 'machine-1' } },
        );
        const integration = hook.getCurrent().integrations?.[0];
        if (!integration) throw new Error('Expected integration');
        let installing!: Promise<void>;

        act(() => {
            installing = hook.getCurrent().operations!.reviewAndInstall(
                integration,
                async () => true,
            );
        });
        await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
        await hook.rerender({ machineId: 'machine-2' });
        await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(3));

        installResult.resolve({
            ok: true,
            status: {
                state: 'installed_enabled',
                installationId: 'installation-current',
            },
        });
        await act(async () => await installing);
        expect(hook.getCurrent().inventoryState.status).toBe('loading');

        machineTwoInventory.resolve({
            ok: true,
            rows: [{
                agent,
                status: { state: 'not_installed' },
            }],
            nextCursor: null,
            diagnostics: [],
        });
        await act(async () => {
            await flushHookEffects();
        });

        expect(hook.getCurrent().integrations).toEqual([
            expect.objectContaining({
                machineId: 'machine-2',
                state: 'not_installed',
            }),
        ]);
        expect(hook.getCurrent().inventoryState.status).toBe('ready');
        await hook.unmount();
    });

    it('deduplicates the direct action next key when a newer passive refresh already projected it', async () => {
        const installResult = createDeferred<
            Awaited<ReturnType<
                ExternalSessionsHookManagementTransport['install']
            >>
        >();
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'not_installed',
                        installPreview,
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'not_installed',
                        installPreview: refreshedInstallPreview,
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_enabled',
                        installationId: 'installation-current',
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            });
        const install = vi.fn<
            ExternalSessionsHookManagementTransport['install']
        >(async () => await installResult.promise);
        const transport = {
            status,
            install,
            disable: vi.fn(),
            enable: vi.fn(),
            uninstall: vi.fn(),
        };
        const hook = await renderHook(
            () => useExternalSessionsIntegrationController({
                machineId: 'machine-1',
                projectionGeneration: 1,
                agent: { agent, agentTitle: 'Third-party assistant' },
                transport,
            }),
        );
        const integration = hook.getCurrent().integrations?.[0];
        if (!integration) throw new Error('Expected integration');

        let installing!: Promise<void>;
        act(() => {
            installing = hook.getCurrent().operations!.reviewAndInstall(
                integration,
                async () => true,
            );
        });
        await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
        await act(async () => {
            await hook.getCurrent().retryInventory();
        });
        installResult.resolve({
            ok: true,
            status: {
                state: 'installed_enabled',
                installationId: 'installation-current',
            },
        });
        await act(async () => await installing);

        expect(hook.getCurrent().integrations).toHaveLength(1);
        expect(hook.getCurrent().integrations?.[0]?.state)
            .toBe('installed_enabled');
        await hook.unmount();
    });

    it('keeps multiple installations for one Agent distinct and refreshes the selected installation without duplicates', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce({
                ok: true,
                rows: [
                    {
                        agent,
                        status: {
                            state: 'installed_disabled',
                            installationId: 'installation-a',
                        },
                    },
                    {
                        agent,
                        status: {
                            state: 'installed_enabled',
                            installationId: 'installation-b',
                        },
                    },
                ],
                nextCursor: null,
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                ok: true,
                rows: [
                    {
                        agent,
                        status: {
                            state: 'installed_enabled',
                            installationId: 'installation-b',
                        },
                    },
                ],
                nextCursor: null,
                diagnostics: [],
            });
        const enable = vi.fn<ExternalSessionsHookManagementTransport['enable']>()
            .mockResolvedValue({
                ok: true,
                status: {
                    state: 'installed_enabled',
                    installationId: 'installation-a',
                },
            });
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable,
            uninstall: vi.fn(),
        };
        const hook = await renderHook(
            () => useExternalSessionsIntegrationController({
                machineId: 'machine-1',
                serverId: 'server-1',
                projectionGeneration: 1,
                agent: { agent, agentTitle: 'Third-party assistant' },
                transport,
            }),
        );

        const initial = hook.getCurrent().integrations!;
        expect(initial).toHaveLength(2);
        expect(new Set(initial.map((integration) => integration.key)).size).toBe(2);

        await act(async () => {
            await hook.getCurrent().operations!.enable(initial[0]!);
        });

        expect(enable).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            agent,
            installationId: 'installation-a',
        });
        const refreshed = hook.getCurrent().integrations!;
        expect(status).toHaveBeenCalledTimes(1);
        expect(refreshed).toHaveLength(2);
        expect(new Set(refreshed.map((integration) => integration.key)).size).toBe(2);
        expect(refreshed.map((integration) => (
            'installationId' in integration ? integration.installationId : null
        )).sort())
            .toEqual(['installation-a', 'installation-b']);

        const selected = refreshed.find((integration) => (
            'installationId' in integration
            && integration.installationId === 'installation-b'
        ));
        if (!selected) throw new Error('Expected selected installation');
        await act(async () => {
            await hook.getCurrent().operations!.checkAgain(selected);
        });
        expect(status).toHaveBeenCalledTimes(2);
        expect(status).toHaveBeenLastCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            intent: 'installation_recheck',
            agent,
            installationId: 'installation-b',
        });
        expect(hook.getCurrent().integrations).toHaveLength(2);

        await hook.unmount();
    });

    it('does not refresh after a failed mutation and requests review data for passive not-installed truth', async () => {
        const disable = vi.fn<ExternalSessionsHookManagementTransport['disable']>()
            .mockResolvedValue({
                ok: false,
                diagnostic: {
                    code: 'concurrent_edit',
                    retryable: true,
                },
            });
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValue({
                ok: false,
                diagnostic: {
                    code: 'operation_failed',
                    retryable: true,
                },
            });
        const refresh = vi.fn();
        const operations = createExternalSessionsIntegrationOperations({
            serverId: null,
            transport: {
                status,
                install: vi.fn(),
                disable,
                enable: vi.fn(),
                uninstall: vi.fn(),
            },
            refresh,
            applyStatus: vi.fn(),
        });
        const integration = {
            key: 'machine-1\u0000com.example.external-agent\u0000assistant',
            machineId: 'machine-1',
            agent,
            agentTitle: 'Third-party assistant',
            state: 'installed_enabled',
            installationId: 'installation-current',
        } as const;

        await expect(operations.disable(integration)).rejects.toThrow('concurrent_edit');
        expect(refresh).not.toHaveBeenCalled();
        await expect(operations.reviewAndInstall({
            key: 'machine-1\u0000com.example.external-agent\u0000assistant',
            machineId: 'machine-1',
            agent,
            agentTitle: 'Third-party assistant',
            state: 'not_installed',
        } as unknown as ExternalSessionsIntegrationDescriptor, async () => true))
            .rejects.toThrow('operation_failed');
        expect(status).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: null,
            intent: 'install_preview',
            agent,
        });
    });

    it('surfaces a first-load failure with retry and no mutation operations', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValue({
                ok: false,
                diagnostic: {
                    code: 'operation_failed',
                    retryable: true,
                },
            });
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable: vi.fn(),
            uninstall: vi.fn(),
        };
        const hook = await renderHook(
            () => useExternalSessionsIntegrationController({
                machineId: 'machine-1',
                projectionGeneration: 1,
                transport,
            }),
        );

        expect(hook.getCurrent().integrations).toBeNull();
        expect(hook.getCurrent().inventoryState).toEqual({
            status: 'error',
            diagnosticCodes: ['operation_failed'],
        });
        expect(hook.getCurrent().operations).toBeNull();
        expect(hook.getCurrent().retryInventory).toEqual(expect.any(Function));

        await hook.unmount();
    });

    it('keeps last-known rows non-actionable after reconnect failure and restores actions after retry', async () => {
        const ready = {
            ok: true as const,
            rows: [{
                agent,
                status: {
                    state: 'installed_enabled' as const,
                    installationId: 'installation-current',
                },
            }],
            nextCursor: null,
            diagnostics: [],
        };
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValueOnce(ready)
            .mockResolvedValueOnce({
                ok: false,
                diagnostic: {
                    code: 'listener_unavailable',
                    retryable: true,
                },
            })
            .mockResolvedValueOnce(ready);
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable: vi.fn(),
            uninstall: vi.fn(),
        };
        const hook = await renderHook(
            (generation: number) => useExternalSessionsIntegrationController({
                machineId: 'machine-1',
                projectionGeneration: generation,
                transport,
            }),
            { initialProps: 1 },
        );
        expect(hook.getCurrent().inventoryState.status).toBe('ready');
        expect(hook.getCurrent().operations).not.toBeNull();

        await hook.rerender(2);
        expect(hook.getCurrent().integrations).toHaveLength(1);
        expect(hook.getCurrent().inventoryState).toEqual({
            status: 'error',
            diagnosticCodes: ['listener_unavailable'],
        });
        expect(hook.getCurrent().operations).toBeNull();

        await act(async () => {
            await hook.getCurrent().retryInventory();
        });
        expect(hook.getCurrent().inventoryState.status).toBe('ready');
        expect(hook.getCurrent().operations).not.toBeNull();

        await hook.unmount();
    });

    it('refreshes once per selected scope/generation and Check Again, without recurring polling', async () => {
        const status = vi.fn<ExternalSessionsHookManagementTransport['status']>()
            .mockResolvedValue({
                ok: true,
                rows: [{
                    agent,
                    status: {
                        state: 'installed_enabled',
                        installationId: 'installation-current',
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            });
        const transport = {
            status,
            install: vi.fn(),
            disable: vi.fn(),
            enable: vi.fn(),
            uninstall: vi.fn(),
        };
        const hook = await renderHook(
            (props: { machineId: string; generation: number }) => (
                useExternalSessionsIntegrationController({
                    machineId: props.machineId,
                    serverId: 'server-1',
                    projectionGeneration: props.generation,
                    agent: { agent, agentTitle: 'Third-party assistant' },
                    transport,
                })
            ),
            {
                initialProps: {
                    machineId: 'machine-1',
                    generation: 1,
                },
            },
        );

        expect(status).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().integrations).toHaveLength(1);
        expect(status).toHaveBeenLastCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            intent: 'passive_inventory',
            agent,
            limit: 50,
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(status).toHaveBeenCalledTimes(1);

        await hook.rerender({
            machineId: 'machine-1',
            generation: 2,
        });
        expect(status).toHaveBeenCalledTimes(2);

        await act(async () => {
            await hook.getCurrent().operations?.checkAgain(
                hook.getCurrent().integrations![0]!,
            );
        });
        expect(status).toHaveBeenCalledTimes(3);
        expect(status).toHaveBeenLastCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            intent: 'installation_recheck',
            agent,
            installationId: 'installation-current',
        });

        await hook.rerender({
            machineId: 'machine-2',
            generation: 2,
        });
        expect(status).toHaveBeenCalledTimes(4);
        expect(status.mock.calls.at(-1)?.[0].machineId).toBe('machine-2');

        await hook.unmount();
    });
});
