import { describe, expect, it, vi } from 'vitest';
import { peekTempData, storeTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { createManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { SessionAuthoringExecutionTargetV2Schema } from '@happier-dev/protocol/sessions/authoring/fieldCatalog';

import {
    buildNewSessionPickerFallbackHref,
    pickNewSessionRouteParams,
    resolveNewSessionPickerReturnRouteKey,
    setNewSessionPickerReturnParams,
    completeNewSessionPickerReturn,
} from './setNewSessionPickerReturnParams';

describe('pickNewSessionRouteParams', () => {
    it('preserves the embedded host identity across nested picker routes', () => {
        expect(pickNewSessionRouteParams({ newSessionHostDraftId: 'host-draft', unrelated: 'drop' }))
            .toEqual({ newSessionHostDraftId: 'host-draft' });
    });
    it('preserves a no-folder choice on the pushed folder picker round trip', () => {
        expect(pickNewSessionRouteParams({ directoryKind: 'managed', directory: undefined }))
            .toEqual({ directoryKind: 'managed' });
    });
    it('preserves ordinary-entry origin across picker round trips without admitting unrelated params', () => {
        expect(pickNewSessionRouteParams({
            draftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45',
            draftOrigin: 'ordinary',
            machinePoolId: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
            unrelated: 'drop-me',
        })).toEqual({
            draftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45',
            draftOrigin: 'ordinary',
            machinePoolId: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
        });
    });
});

describe('buildNewSessionPickerFallbackHref', () => {
    it('preserves the exact current draft identity in an emergency picker fallback', () => {
        expect(buildNewSessionPickerFallbackHref({
            draftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45',
            directory: '/repo with space',
            unrelated: 'drop-me',
        })).toEqual({
            pathname: '/new',
            params: {
                draftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45',
                directory: '/repo with space',
            },
        });
    });
});

describe('resolveNewSessionPickerReturnRouteKey', () => {
    it('does not mistake Add pages carrying the composer draft for the composer', () => {
        expect(resolveNewSessionPickerReturnRouteKey({ index: 3, routes: [
            { key: 'composer', name: 'new/index', params: { draftId: 'original' } },
            { key: 'picker', name: 'new/pick/machine', params: { draftId: 'original' } },
            { key: 'add', name: 'settings/machines/add', params: { draftId: 'original' } },
            { key: 'pair', name: 'settings/machines/add', params: { draftId: 'original', path: 'pair' } },
        ] })).toBe('composer');
    });
    it('applies the joined machine to the original route and unwinds the entire Add flow', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();
        completeNewSessionPickerReturn({ navigation: { dispatch, getState: () => ({ index: 3, routes: [
            { key: 'home', name: 'index' },
            { key: 'composer', name: 'new/index', params: { draftId: 'original' } },
            { key: 'add', name: 'settings/machines/add', params: { draftId: 'original' } },
            { key: 'pair', name: 'settings/machines/add', params: { draftId: 'original', path: 'pair' } },
        ] }) }, router: { replace }, currentParams: { draftId: 'original' },
            routeParams: { machineId: 'joined' } });
        expect(dispatch.mock.calls).toEqual([
            [{ type: 'SET_PARAMS', source: 'composer', payload: { params: { machineId: 'joined' } } }],
            [{ type: 'POP', payload: { count: 2 } }],
        ]);
        expect(replace).not.toHaveBeenCalled();
    });
    it('recognizes a route carrying only the exact new-session draft identity', () => {
        expect(resolveNewSessionPickerReturnRouteKey({
            index: 2,
            routes: [
                { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                { key: 'new-route', params: { draftId: 'draft-id' } },
                { key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' },
            ],
        })).toBe('new-route');
    });
    it('prefers the nearest prior /new route over an unrelated modal parent', () => {
        expect(resolveNewSessionPickerReturnRouteKey({
            index: 2,
            routes: [
                { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                { key: 'new-route', name: '(app)/new/index', path: '/new', params: { machineId: 'm1' } },
                { key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' },
            ],
        })).toBe('new-route');
    });

    it('skips nested picker routes and keeps the actual /new screen as the return target', () => {
        expect(resolveNewSessionPickerReturnRouteKey({
            index: 3,
            routes: [
                { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                { key: 'new-route', name: '(app)/new/index', path: '/new', params: { machineId: 'm1' } },
                { key: 'profile-picker', name: '(app)/new/pick/profile', path: '/new/pick/profile', params: { profileId: 'profile-1' } },
                { key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' },
            ],
        })).toBe('new-route');
    });

    it('falls back to null when the stack has no prior new-session route', () => {
        expect(resolveNewSessionPickerReturnRouteKey({
            index: 1,
            routes: [
                { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                { key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' },
            ],
        })).toBeNull();
    });

    it('does not treat legacy workspace-only params as a new-session return target', () => {
        expect(resolveNewSessionPickerReturnRouteKey({
            index: 2,
            routes: [
                { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                { key: 'legacy-workspace-route', name: 'workspace-legacy', path: '/legacy', params: { workspaceId: 'ws_payments' } },
                { key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' },
            ],
        })).toBeNull();
    });

    it('falls back to the immediate previous route when expo-router state is sparse but the current route is a new-session picker', () => {
        expect(resolveNewSessionPickerReturnRouteKey({
            index: 1,
            routes: [
                { key: 'new-route' },
                { key: 'server-picker-route', name: '(app)/new/pick/server', path: '/new/pick/server' },
            ],
        })).toBe('new-route');
    });

    it('treats canonical backend target params as a new-session return target', () => {
        expect(resolveNewSessionPickerReturnRouteKey({
            index: 2,
            routes: [
                { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                { key: 'new-route', name: '(app)/new/index', path: '/new', params: { backendTargetKey: 'backend:review-bot:configured:review-bot' } },
                { key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' },
            ],
        })).toBe('new-route');
    });
});

describe('setNewSessionPickerReturnParams', () => {
    it('returns a picker result to its live embedded host before considering a stacked /new route', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();
        const returnToHost = vi.fn(() => true);
        const result = setNewSessionPickerReturnParams({
            navigation: { dispatch, getState: () => ({ index: 1, routes: [
                { key: 'old-new', name: '(app)/new/index' },
                { key: 'picker', name: '(app)/new/pick/profile-edit' },
            ] }) },
            router: { replace },
            currentParams: { newSessionHostDraftId: 'host-draft' },
            routeParams: { profileId: 'saved-profile' },
            returnToHost,
        });
        expect(result).toBe('dispatch');
        expect(returnToHost).toHaveBeenCalledWith('host-draft', { profileId: 'saved-profile' });
        expect(dispatch).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
    });
    it('retains the route fallback when the embedded draft is no longer hosted', () => {
        const replace = vi.fn();
        const returnToHost = vi.fn(() => false);
        const result = setNewSessionPickerReturnParams({
            navigation: { dispatch: vi.fn(), getState: () => ({ routes: [] }) },
            router: { replace },
            currentParams: { newSessionHostDraftId: 'retired-draft', draftId: 'retired-draft' },
            routeParams: { profileId: 'saved-profile' },
            returnToHost,
        });
        expect(result).toBe('replace');
        expect(replace).toHaveBeenCalledWith({ pathname: '/new', params: {
            newSessionHostDraftId: 'retired-draft', draftId: 'retired-draft', profileId: 'saved-profile',
        } });
    });
    it.each([false, true])('returns reviewed managed intent through the existing one-shot draft channel (send: %s)', send => {
        const selection = createManagedMachineSelectionDraft({ selection: { kind: 'preset', homeId: 'srv_home', id: 'recipe', revision: 3 },
            receipt: { controller: { machineId: 'controller', installationId: 'installation' },
                launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Work', choices: {} },
                optionStatus: 'current', prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'billed' },
                retentionCapabilities: { supportedIntents: ['delete'] }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const staleTarget = SessionAuthoringExecutionTargetV2Schema.parse({ kind: 'machine', target: { serverId: 'home', machineId: 'old' } });
        const dataId = storeTempData({ prompt: 'Keep my prompt', machineId: 'old', executionTarget: staleTarget } satisfies NewSessionData);
        const dispatch = vi.fn();
        setNewSessionPickerReturnParams({ navigation: { dispatch, getState: () => ({ index: 1, routes: [
            { key: 'composer', name: '(app)/new/index' }, { key: 'picker', name: '(app)/new/pick/machine' },
        ] }) }, router: { replace: vi.fn() }, currentParams: { dataId }, routeParams: { machineId: undefined, spawnServerId: 'home' },
            managedMachineSelection: selection, managedMachineUseOptions: { send } });
        const returnedDataId = dispatch.mock.calls[0][0].payload.params.dataId as string;
        expect(peekTempData<NewSessionData>(returnedDataId)).toEqual(expect.objectContaining({
            prompt: 'Keep my prompt', executionTarget: null, managedMachineSelection: selection, managedMachineUseOptions: { send },
        }));
        expect(peekTempData<NewSessionData>(returnedDataId)?.machineId).toBeUndefined();
        const temporaryTarget = SessionAuthoringExecutionTargetV2Schema.parse({
            kind: 'temporary_computer', serverId: 'home', artifactTarget: 'darwin-arm64', workspace: { kind: 'choose_on_endpoint' },
        });
        setNewSessionPickerReturnParams({ navigation: { dispatch, getState: () => ({ index: 1, routes: [
            { key: 'composer', name: '(app)/new/index' }, { key: 'picker', name: '(app)/new/pick/machine' },
        ] }) }, router: { replace: vi.fn() }, currentParams: { dataId: returnedDataId }, routeParams: { machineId: undefined },
            authoringExecutionTarget: temporaryTarget });
        const temporaryDataId = dispatch.mock.calls[1][0].payload.params.dataId as string;
        expect(peekTempData<NewSessionData>(temporaryDataId)).toEqual(expect.objectContaining({
            prompt: 'Keep my prompt', executionTarget: temporaryTarget, managedMachineSelection: null,
        }));
        expect(peekTempData<NewSessionData>(temporaryDataId)?.managedMachineUseOptions).toBeUndefined();
        setNewSessionPickerReturnParams({ navigation: { dispatch, getState: () => ({ index: 1, routes: [
            { key: 'composer', name: '(app)/new/index' }, { key: 'picker', name: '(app)/new/pick/machine' },
        ] }) }, router: { replace: vi.fn() }, currentParams: { dataId: returnedDataId }, routeParams: { machineId: 'chosen' },
            managedMachineSelection: null });
        const machineDataId = dispatch.mock.calls[2][0].payload.params.dataId as string;
        expect(peekTempData<NewSessionData>(machineDataId)).toEqual(expect.objectContaining({
            prompt: 'Keep my prompt', executionTarget: undefined, managedMachineSelection: null,
        }));
        expect(dispatch.mock.calls[2][0].payload.params.machineId).toBe('chosen');
    });
    it('preserves the exact draft identity through replace fallback', () => {
        const replace = vi.fn();

        setNewSessionPickerReturnParams({
            navigation: {
                dispatch: vi.fn(),
                getState: () => ({
                    index: 1,
                    routes: [
                        { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1' },
                        { key: 'picker-route', name: '(app)/new/pick/path', path: '/new/pick/path' },
                    ],
                }),
            },
            router: { replace },
            currentParams: { draftId: 'draft-id' },
            routeParams: { directory: '/repo/selected' },
        });

        expect(replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: 'draft-id',
                directory: '/repo/selected',
            },
        });
    });
    it('dispatches params onto the new-session route when it is still on the stack', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();

        const mode = setNewSessionPickerReturnParams({
            navigation: {
                dispatch,
                getState: () => ({
                    index: 2,
                    routes: [
                        { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                        { key: 'new-route', name: '(app)/new/index', path: '/new', params: { machineId: 'm1' } },
                        { key: 'picker-route', name: '(app)/new/pick/path', path: '/new/pick/path' },
                    ],
                }),
            },
            router: { replace },
            routeParams: { path: '/repo/selected' },
        });

        expect(mode).toBe('dispatch');
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            source: 'new-route',
            payload: expect.objectContaining({
                params: expect.objectContaining({
                    path: '/repo/selected',
                }),
            }),
        }));
        expect(replace).not.toHaveBeenCalled();
    });

    it('treats directory as canonical new-session path state when dispatching back from pickers', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();

        const mode = setNewSessionPickerReturnParams({
            navigation: {
                dispatch,
                getState: () => ({
                    index: 2,
                    routes: [
                        { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                        { key: 'new-route', name: '(app)/new/index', path: '/new', params: { machineId: 'm1' } },
                        { key: 'picker-route', name: '(app)/new/pick/path', path: '/new/pick/path' },
                    ],
                }),
            },
            router: { replace },
            routeParams: { directory: '/repo/selected' },
        });

        expect(mode).toBe('dispatch');
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            source: 'new-route',
            payload: expect.objectContaining({
                params: expect.objectContaining({
                    directory: '/repo/selected',
                }),
            }),
        }));
        expect(replace).not.toHaveBeenCalled();
    });

    it('dispatches params to the actual /new route instead of an intermediate picker route', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();

        const mode = setNewSessionPickerReturnParams({
            navigation: {
                dispatch,
                getState: () => ({
                    index: 3,
                    routes: [
                        { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                        { key: 'new-route', name: '(app)/new/index', path: '/new', params: { machineId: 'm1' } },
                        { key: 'profile-picker', name: '(app)/new/pick/profile', path: '/new/pick/profile', params: { profileId: 'profile-1' } },
                        { key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' },
                    ],
                }),
            },
            router: { replace },
            routeParams: { path: '/repo/selected' },
        });

        expect(mode).toBe('dispatch');
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            source: 'new-route',
            payload: expect.objectContaining({
                params: expect.objectContaining({
                    path: '/repo/selected',
                }),
            }),
        }));
        expect(replace).not.toHaveBeenCalled();
    });

    it('replaces back to /new when the picker was opened over a non-new route', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();

        const mode = setNewSessionPickerReturnParams({
            navigation: {
                dispatch,
                getState: () => ({
                    index: 1,
                    routes: [
                        { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                        { key: 'picker-route', name: '(app)/new/pick/path', path: '/new/pick/path' },
                    ],
                }),
            },
            router: { replace },
            routeParams: { path: '/repo/selected' },
            replaceParams: { machineId: 'm1', path: '/repo/selected' },
        });

        expect(mode).toBe('replace');
        expect(dispatch).not.toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'm1',
                path: '/repo/selected',
            },
        });
    });

    it('preserves the current new-session context when replace fallback is needed', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();

        const mode = setNewSessionPickerReturnParams({
            navigation: {
                dispatch,
                getState: () => ({
                    index: 1,
                    routes: [
                        { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                        { key: 'picker-route', name: '(app)/new/pick/path', path: '/new/pick/path' },
                    ],
                }),
            },
            router: { replace },
            routeParams: { path: '/repo/selected' },
            replaceParams: {
                dataId: 'draft-1',
                machineId: 'm1',
                spawnServerId: 'server-b',
                path: '/repo/selected',
            },
        });

        expect(mode).toBe('replace');
        expect(dispatch).not.toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                dataId: 'draft-1',
                machineId: 'm1',
                spawnServerId: 'server-b',
                path: '/repo/selected',
            },
        });
    });

    it('preserves previewMachineId when replace fallback returns to /new', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();

        const mode = setNewSessionPickerReturnParams({
            navigation: {
                dispatch,
                getState: () => ({
                    index: 1,
                    routes: [
                        { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                        { key: 'picker-route', name: '(app)/new/pick/preview-machine', path: '/new/pick/preview-machine' },
                    ],
                }),
            },
            router: { replace },
            routeParams: { previewMachineId: 'machine-picked' },
            replaceParams: {
                dataId: 'draft-1',
                machineId: 'm1',
                previewMachineId: 'machine-picked',
            },
        });

        expect(mode).toBe('replace');
        expect(dispatch).not.toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                dataId: 'draft-1',
                machineId: 'm1',
                previewMachineId: 'machine-picked',
            },
        });
    });

    it('preserves worktree when replace fallback returns to /new', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();

        const mode = setNewSessionPickerReturnParams({
            navigation: {
                dispatch,
                getState: () => ({
                    index: 1,
                    routes: [
                        { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                        {
                            key: 'picker-route',
                            name: '(app)/new/pick/path',
                            path: '/new/pick/path',
                            params: {
                                dataId: 'draft-1',
                                worktree: 'new',
                            },
                        },
                    ],
                }),
            },
            router: { replace },
            routeParams: { directory: '/repo/selected' },
            replaceParams: {
                machineId: 'm1',
                directory: '/repo/selected',
            },
        });

        expect(mode).toBe('replace');
        expect(dispatch).not.toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                dataId: 'draft-1',
                machineId: 'm1',
                directory: '/repo/selected',
                worktree: 'new',
            },
        });
    });

    it('preserves canonical backend target params from the current picker route during replace fallback', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();
        const serializedBackendTarget = JSON.stringify({
            kind: 'backend',
            backendId: 'review-bot',
            configuredBackendId: 'review-bot',
        });

        const mode = setNewSessionPickerReturnParams({
            navigation: {
                dispatch,
                getState: () => ({
                    index: 1,
                    routes: [
                        { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                        {
                            key: 'picker-route',
                            name: '(app)/new/pick/path',
                            path: '/new/pick/path',
                            params: {
                                backendTarget: serializedBackendTarget,
                                backendTargetKey: 'backend:review-bot:configured:review-bot',
                                dataId: 'draft-1',
                            },
                        },
                    ],
                }),
            },
            router: { replace },
            routeParams: { path: '/repo/selected' },
            replaceParams: {
                machineId: 'm1',
                path: '/repo/selected',
            },
        });

        expect(mode).toBe('replace');
        expect(dispatch).not.toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                backendTarget: JSON.stringify({ kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-bot' }),
                backendTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot',
                dataId: 'draft-1',
                machineId: 'm1',
                path: '/repo/selected',
            },
        });
    });

    it('demotes legacy customAcp route params to the discovered built-in backend id during replace fallback', () => {
        const dispatch = vi.fn();
        const replace = vi.fn();
        const serializedBackendTarget = JSON.stringify({
            kind: 'backend',
            backendId: 'acme.review.backend',
        });

        const mode = setNewSessionPickerReturnParams({
            navigation: {
                dispatch,
                getState: () => ({
                    index: 1,
                    routes: [
                        { key: 'session-route', name: '(app)/session/[id]', path: '/session/s1', params: { id: 's1' } },
                        {
                            key: 'picker-route',
                            name: '(app)/new/pick/path',
                            path: '/new/pick/path',
                            params: {
                                backendTarget: serializedBackendTarget,
                                backendTargetKey: 'backend:acme.review.backend',
                                dataId: 'draft-1',
                            },
                        },
                    ],
                }),
            },
            router: { replace },
            routeParams: {
                backendTarget: serializedBackendTarget,
                backendTargetKey: 'backend:acme.review.backend',
            },
            replaceParams: {
                backendTarget: serializedBackendTarget,
                backendTargetKey: 'backend:acme.review.backend',
                dataId: 'draft-1',
                machineId: 'm1',
            },
        });

        expect(mode).toBe('replace');
        expect(dispatch).not.toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                backendTarget: serializedBackendTarget,
                backendTargetKey: 'backend:acme.review.backend',
                dataId: 'draft-1',
                machineId: 'm1',
            },
        });
    });
});

describe('completeNewSessionPickerReturn to a docked composer from a pane', () => {
    it('steps the pane back once when the picker lives in the pane history, not a navigator stack (#5)', () => {
        // Live shape (13:33Z, 14:02Z): Add hosted in a workspace pane sees only the root stack.
        const hostParams: Record<string, unknown> = { draftId: 'original' };
        const dispatch = vi.fn();
        const back = vi.fn();
        const add = { draftId: 'original', newSessionHostDraftId: 'original' };
        completeNewSessionPickerReturn({
            navigation: { dispatch, getState: () => ({ index: 0, routes: [{ key: 'root', name: '__root' }] }) },
            router: { replace: vi.fn(), back }, currentParams: add,
            returnToHost: (id, patch) => { if (id !== 'original') return false; Object.assign(hostParams, patch); return true; },
            routeParams: { machineId: 'joined', spawnServerId: 'home' },
        });
        expect(hostParams).toMatchObject({ machineId: 'joined', spawnServerId: 'home' });
        expect(back).toHaveBeenCalledOnce();
        expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'POP' }));
    });
});
