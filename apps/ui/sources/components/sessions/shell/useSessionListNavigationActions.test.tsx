import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { clearTempData, peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

const routerPushSpy = vi.hoisted(() => vi.fn());
const rememberLastProjectSessionSelections = vi.hoisted(() => ({ value: true }));
const sessionById = vi.hoisted(() => ({ value: {} as Record<string, any> }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: routerPushSpy,
        },
    }).module;
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            storage: Object.assign(
                ((selector?: (state: any) => unknown) => {
                    const state = { sessions: sessionById.value };
                    return typeof selector === 'function' ? selector(state) : state;
                }) as any,
                {
                    getState: () => ({ sessions: sessionById.value }),
                    getInitialState: () => ({ sessions: sessionById.value }),
                    setState: () => undefined,
                    subscribe: () => () => undefined,
                    destroy: () => undefined,
                },
            ),
            useSetting: createUseSettingMock({ fallback: (name) => {
                if (name === 'rememberLastProjectSessionSelections') {
                    return rememberLastProjectSessionSelections.value;
                }
                return undefined;
            } }),
        },
    });
});

describe('useSessionListNavigationActions', () => {
    beforeEach(() => {
        routerPushSpy.mockClear();
        rememberLastProjectSessionSelections.value = true;
        sessionById.value = {};
        clearTempData();
    });

    afterEach(() => {
        clearTempData();
    });

    it('routes project create-session actions into a prefilled new-session flow', async () => {
        const { useSessionListNavigationActions } = await import('./useSessionListNavigationActions');
        const hook = await renderHook(() => useSessionListNavigationActions());

        await act(async () => {
            hook.getCurrent().handleCreateSessionFromWorkspaceScope({
                serverId: 'server_a',
                machineId: 'machine_a',
                rootPath: '/repo',
            });
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                machineId: 'machine_a',
                directory: '/repo',
                spawnServerId: 'server_a',
            },
        });

        await hook.unmount();
    });

    it('uses the latest project session configuration when the remember setting is enabled', async () => {
        sessionById.value = {
            seed_sess: {
                id: 'seed_sess',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                encryptionMode: 'plain',
                metadata: {
                    machineId: 'machine-source',
                    path: '/old/repo',
                    flavor: 'codex',
                    backendTarget: { kind: 'backend', backendId: 'codex' },
                    profileId: 'profile-1',
                    transcriptStorage: 'direct',
                    codexBackendMode: 'appServer',
                    sessionModeOverrideV1: {
                        v: 1,
                        updatedAt: 100,
                        modeId: 'plan',
                    },
                },
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 101,
                modelMode: 'gpt-5',
                modelModeUpdatedAt: 102,
            },
        };

        const { useSessionListNavigationActions } = await import('./useSessionListNavigationActions');
        const hook = await renderHook(() => useSessionListNavigationActions());

        await act(async () => {
            (hook.getCurrent().handleCreateSessionFromWorkspaceScope as any)({
                serverId: 'server_a',
                machineId: 'machine_target',
                rootPath: '/repo',
            }, { seedSessionId: 'seed_sess' });
        });

        const pushArg = routerPushSpy.mock.calls[0]?.[0] as any;
        expect(pushArg).toEqual({
            pathname: '/new',
            params: {
                dataId: expect.any(String),
                draftId: expect.any(String),
                machineId: 'machine_target',
                directory: '/repo',
                spawnServerId: 'server_a',
            },
        });
        const tempData = peekTempData<NewSessionData>(pushArg.params.dataId);
        expect(tempData).toEqual(expect.objectContaining({
            prompt: '',
            replacePersistedDraftSelections: true,
            machineId: 'machine_target',
            directory: '/repo',
            agentType: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            selectedProfileId: 'profile-1',
            transcriptStorage: 'direct',
            permissionMode: 'safe-yolo',
            modelSelection: {
                v: 1,
                ref: {
                    agentTargetKey: 'backend:codex',
                    modelId: 'gpt-5',
                    providerConnectionId: null,
                },
                updatedAt: 102,
            },
            codexBackendMode: 'appServer',
            acpSessionModeId: 'plan',
        }));

        await hook.unmount();
    });

    it('starts a project session from the owning machine workspace path', async () => {
        rememberLastProjectSessionSelections.value = false;
        sessionById.value = {
            seed_sess: {
                id: 'seed_sess',
                active: false,
                metadata: {
                    machineId: 'machine_target',
                    path: '/home/coder/repo',
                    sessionWorkspaceLocationV1: {
                        v: 1,
                        machineId: 'machine_target',
                        agentPath: '/home/coder/repo',
                        machinePath: '/Users/alice/repo',
                    },
                },
            },
        };

        const { useSessionListNavigationActions } = await import('./useSessionListNavigationActions');
        const hook = await renderHook(() => useSessionListNavigationActions());

        await act(async () => {
            hook.getCurrent().handleCreateSessionFromWorkspaceScope({
                serverId: 'server_a',
                machineId: 'machine_target',
                rootPath: '/home/coder/repo',
            }, { seedSessionId: 'seed_sess' });
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                machineId: 'machine_target',
                directory: '/Users/alice/repo',
                spawnServerId: 'server_a',
            },
        });

        await hook.unmount();
    });
});
