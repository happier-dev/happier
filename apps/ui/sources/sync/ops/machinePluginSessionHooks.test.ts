import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope,
}));

describe('machinePluginSessionHooks', () => {
    beforeEach(() => {
        machineRpcWithServerScope.mockReset();
    });

    it('executes the canonical status ActionSpec through its existing server-scoped machine RPC', async () => {
        const installPreview = {
            previewId: `hook-install-preview:v1:${'a'.repeat(64)}`,
            targets: [{
                targetId: 'settings',
                absolutePath: '/tmp/settings.json',
                changes: [{
                    kind: 'append_json_array_entry',
                    collectionId: 'hooks',
                    eventId: 'session-start',
                    nativeEventName: 'SessionStart',
                    entry: {
                        matcher: null,
                        hooks: [{
                            type: 'command',
                            command: 'happier hook',
                            timeout: 500,
                        }],
                    },
                }],
            }],
        };
        machineRpcWithServerScope.mockResolvedValue({
            ok: true,
            rows: [{
                agent: {
                    pluginId: 'com.example.external-agent',
                    localId: 'assistant',
                },
                status: { state: 'not_installed', installPreview },
            }],
            nextCursor: null,
            diagnostics: [],
        });
        const { machinePluginSessionHookStatusGet } = await import('./machinePluginSessionHooks');

        await expect(machinePluginSessionHookStatusGet({
            machineId: 'machine-1',
            serverId: 'server-1',
            intent: 'passive_inventory',
            agent: {
                pluginId: 'com.example.external-agent',
                localId: 'assistant',
            },
            limit: 50,
        })).resolves.toEqual({
            ok: true,
            rows: [{
                agent: {
                    pluginId: 'com.example.external-agent',
                    localId: 'assistant',
                },
                status: { state: 'not_installed', installPreview },
            }],
            nextCursor: null,
            diagnostics: [],
        });
        expect(machineRpcWithServerScope).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: 'daemon.plugins.sessionHooks.status.get',
            payload: {
                machineId: 'machine-1',
                intent: 'passive_inventory',
                agent: {
                    pluginId: 'com.example.external-agent',
                    localId: 'assistant',
                },
                limit: 50,
            },
        });
    });

    it('uses the exact current installation id for state-changing ActionSpecs', async () => {
        machineRpcWithServerScope
            .mockResolvedValueOnce({
                ok: true,
                status: {
                    state: 'installed_disabled',
                    installationId: 'installation-current',
                },
            })
            .mockResolvedValueOnce({
                ok: true,
                status: { state: 'not_installed' },
            });
        const {
            machinePluginSessionHookEnable,
            machinePluginSessionHookUninstall,
        } = await import('./machinePluginSessionHooks');
        const target = {
            machineId: 'machine-1',
            serverId: 'server-1',
            agent: {
                pluginId: 'com.example.external-agent',
                localId: 'assistant',
            },
            installationId: 'installation-current',
        } as const;

        await expect(machinePluginSessionHookEnable(target)).resolves.toMatchObject({
            ok: true,
            status: { state: 'installed_disabled' },
        });
        await expect(machinePluginSessionHookUninstall(target)).resolves.toEqual({
            ok: true,
            status: { state: 'not_installed' },
        });

        expect(machineRpcWithServerScope.mock.calls).toEqual([
            [{
                machineId: 'machine-1',
                serverId: 'server-1',
                method: 'daemon.plugins.sessionHooks.enable',
                payload: {
                    machineId: 'machine-1',
                    agent: target.agent,
                    installationId: 'installation-current',
                },
            }],
            [{
                machineId: 'machine-1',
                serverId: 'server-1',
                method: 'daemon.plugins.sessionHooks.uninstall',
                payload: {
                    machineId: 'machine-1',
                    agent: target.agent,
                    installationId: 'installation-current',
                },
            }],
        ]);
    });

    it('rejects malformed daemon output through the ActionSpec output schema', async () => {
        machineRpcWithServerScope.mockResolvedValue({
            ok: true,
            rows: [{
                agent: {
                    pluginId: 'com.example.external-agent',
                    localId: 'assistant',
                },
                status: {
                    state: 'installed_enabled',
                },
            }],
            nextCursor: null,
            diagnostics: [],
        });
        const { machinePluginSessionHookStatusGet } = await import('./machinePluginSessionHooks');

        await expect(machinePluginSessionHookStatusGet({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            agent: {
                pluginId: 'com.example.external-agent',
                localId: 'assistant',
            },
            limit: 50,
        })).rejects.toThrow();
    });
});
