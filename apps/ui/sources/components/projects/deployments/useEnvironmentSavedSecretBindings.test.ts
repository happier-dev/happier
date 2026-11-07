import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { act, createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resetSavedSecretCatalogEngineForTests } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { resetTeamActionClientForTests } from '@/sync/ops/teams/teamActionClient';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const { useEnvironmentSecretBindingsEditor } = await import('./useEnvironmentSecretBindingsEditor');
const { useEnvironmentSavedSecretBindings } = await import('./useEnvironmentSavedSecretBindings');
let home: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | null = null;
beforeEach(() => { resetSavedSecretCatalogEngineForTests(); resetSavedSecretCatalogSnapshotsForTests(); resetTeamActionClientForTests(); });
afterEach(async () => { await standardCleanup(); resetSavedSecretCatalogEngineForTests(); await home?.dispose(); home = null; });

function mount(initialBindings: readonly EnvironmentSecretBindingV1[] = []) {
    return renderHook((scopeKey: string) => {
        const [bindings, setBindings] = React.useState(initialBindings);
        const editor = useEnvironmentSecretBindingsEditor({ bindings, scopeKey, onChangeBindings: setBindings });
        const creation = useEnvironmentSavedSecretBindings({ scope: home!.scope, scopeKey, editor });
        return { editor, creation, bindings };
    }, { initialProps: 'environment-a' });
}

describe('Environment Saved Secret creation through the existing owner', () => {
    it.each(['plain', 'e2ee'] as const)('creates only secret rows, applies the whole bulk once, and never binds raw bytes (%s)', async mode => {
        home = await createSecretSettingsTestHarness({ mode, settings: settingsParse({ secrets: [] }) });
        const hook = await mount();
        await act(async () => { hook.getCurrent().editor.stageBulk('TOKEN=local-secret-sentinel\nPORT=3000', 'runtime'); });
        await act(async () => { hook.getCurrent().editor.classifyBulk('PORT', 'plain'); });
        await act(async () => { expect(await hook.getCurrent().creation.applyBulk()).toMatchObject({ ok: true }); });
        expect(home.creations).toHaveLength(1);
        const resource = home.resources.find(row => 'resourceId' in row);
        if (!resource || !('resourceId' in resource)) throw new Error('Missing created resource');
        expect(hook.getCurrent().bindings).toEqual([
            { purpose: 'variable', name: 'TOKEN', phase: 'runtime', source: { kind: 'secret', ref: resource.entry.ref, resourceRevision: 1 } },
            { purpose: 'variable', name: 'PORT', phase: 'runtime', source: { kind: 'value', value: '3000' } },
        ]);
        expect(JSON.stringify(hook.getCurrent().bindings).includes('local-secret-sentinel')).toBe(false);
        expect(hook.getCurrent().editor.bulk).toBeNull();
        expect(home.settingsWrites).toEqual([]);
        expect(home.request.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/materials'))).toHaveLength(0);
        expect(hook.getCurrent().creation.busy).toBe(false);
    });

    it('binds a newly created Saved Secret to Both and refuses a duplicate before creating another resource', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        const hook = await mount();
        await act(async () => { expect(await hook.getCurrent().creation.createAndBind({ name: 'TOKEN', value: 'local-value', phase: 'both' }))
            .toMatchObject({ ok: true }); });
        expect(hook.getCurrent().bindings.map(row => row.purpose === 'variable' ? row.phase : null)).toEqual(['build', 'runtime']);
        await act(async () => { expect(await hook.getCurrent().creation.createAndBind({ name: 'TOKEN', value: 'other-value', phase: 'runtime' }))
            .toMatchObject({ ok: false, error: 'duplicate_identity' }); });
        expect(home.creations).toHaveLength(1);
    });

    it.each(['constructor', '__proto__'])('creates a valid variable named %s without inheriting an object property', async name => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        const hook = await mount();
        await act(async () => { expect(hook.getCurrent().editor.stageBulk(`${name}=local-variable`, 'runtime')).toEqual({ ok: true }); });
        await act(async () => { hook.getCurrent().editor.classifyBulk(name, 'secret'); });
        await act(async () => { expect(await hook.getCurrent().creation.applyBulk()).toMatchObject({ ok: true }); });
        expect(home.creations).toHaveLength(1);
        const resource = home.resources.find(row => 'resourceId' in row);
        if (!resource || !('resourceId' in resource)) throw new Error('Missing created resource');
        expect(hook.getCurrent().bindings).toEqual([{
            purpose: 'variable', name, phase: 'runtime',
            source: { kind: 'secret', ref: resource.entry.ref, resourceRevision: 1 },
        }]);
    });

    it('does not bind a completed creation into a replacement bulk draft and retains the created reference', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        const request = home.request.getMockImplementation()!;
        home.request.mockImplementation(async (url, init) => {
            if (new URL(String(url)).pathname === '/v1/account/saved-secrets/resources' && init?.method === 'POST') {
                started.resolve(); await release.promise;
            }
            return request(url, init);
        });
        const hook = await mount();
        await act(async () => { hook.getCurrent().editor.stageBulk('TOKEN=local-draft', 'runtime'); });
        const applying = hook.getCurrent().creation.applyBulk();
        try {
            await started.promise;
            await act(async () => { hook.getCurrent().editor.stageBulk('NEXT=next-draft', 'runtime'); });
            await act(async () => { release.resolve(); });
            const result = await applying;
            expect(result).toMatchObject({ ok: false, error: 'no_draft' });
            expect(Object.keys(result.sources)).toEqual(['TOKEN']);
            expect(hook.getCurrent().bindings).toEqual([]);
            expect(hook.getCurrent().editor.bulk?.map(row => row.name)).toEqual(['NEXT']);
        } finally { release.resolve(); }
    });

    it('rejects a conflicting bulk destination before creating any Saved Secret', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        const hook = await mount([{ purpose: 'variable', name: 'PORT', phase: 'runtime', source: { kind: 'value', value: '4000' } }]);
        await act(async () => { hook.getCurrent().editor.stageBulk('PORT=4000\nTOKEN=local-draft\nSESSION_KEY=3000', 'runtime'); });
        // The draft moved under the staged file: its TOKEN destination is taken before any Saved Secret exists.
        await act(async () => { hook.getCurrent().editor.setVariable({ name: 'TOKEN', phase: 'runtime', source: { kind: 'value', value: 'x' } }); });
        await act(async () => { expect(await hook.getCurrent().creation.applyBulk()).toMatchObject({ ok: false, error: 'duplicate_identity' }); });
        expect(home.creations).toEqual([]);
        expect(hook.getCurrent().editor.bulk).toHaveLength(2);
    });

    it('returns completed references when a later creation fails and allows explicit reuse without recreating them', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        const request = home.request.getMockImplementation()!;
        let attempts = 0;
        home.request.mockImplementation(async (url, init) => {
            if (new URL(String(url)).pathname === '/v1/account/saved-secrets/resources' && init?.method === 'POST' && ++attempts === 2) {
                return Response.json({ error: 'unavailable' }, { status: 503 });
            }
            return request(url, init);
        });
        const hook = await mount();
        await act(async () => { hook.getCurrent().editor.stageBulk('FIRST=first-local\nSECOND=second-local', 'build'); });
        await act(async () => { hook.getCurrent().editor.classifyBulk('FIRST', 'secret'); hook.getCurrent().editor.classifyBulk('SECOND', 'secret'); });
        let recovery: Parameters<ReturnType<typeof useEnvironmentSavedSecretBindings>['applyBulk']>[0] = {};
        await act(async () => {
            const failed = await hook.getCurrent().creation.applyBulk();
            expect(failed).toMatchObject({ ok: false });
            expect(Object.keys(failed.sources)).toEqual(['FIRST']);
            recovery = failed.sources;
        });
        expect(hook.getCurrent().bindings).toEqual([]);
        expect(hook.getCurrent().editor.bulk).toHaveLength(2);
        expect(hook.getCurrent().creation.busy).toBe(false);
        await act(async () => { expect(await hook.getCurrent().creation.applyBulk(recovery)).toMatchObject({ ok: true }); });
        expect(home.creations).toHaveLength(2);
        expect(hook.getCurrent().bindings).toHaveLength(2);
    });

    it('retires an Environment creation and releases local busy state on cancellation without changing bindings', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        const request = home.request.getMockImplementation()!;
        home.request.mockImplementation(async (url, init) => {
            if (new URL(String(url)).pathname === '/v1/account/saved-secrets/resources' && init?.method === 'POST') {
                started.resolve(); await release.promise;
            }
            return request(url, init);
        });
        const hook = await mount();
        const applying = hook.getCurrent().creation.createAndBind({ name: 'TOKEN', value: 'local-cancelled', phase: 'runtime' });
        try {
            await started.promise;
            await act(async () => { hook.getCurrent().creation.cancel(); });
            await act(async () => { expect(await applying).toMatchObject({ ok: false, error: 'canceled' }); });
            expect(hook.getCurrent().creation.busy).toBe(false);
            expect(hook.getCurrent().bindings).toEqual([]);
            await hook.rerender('environment-b');
            await act(async () => { release.resolve(); });
            expect(hook.getCurrent().bindings).toEqual([]);
        } finally { release.resolve(); }
    });

    it('projects an existing Action approval wait and cancels it without creating or binding a resource', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [], actionsSettingsV1: {
            v: 1, actions: { 'secrets.create': { approvalRequiredSurfaces: ['ui'] } },
        } }) });
        const pending = createDeferred<void>();
        const onApprovalPending = vi.fn(() => { pending.resolve(); });
        const hook = await mount();
        const creating = hook.getCurrent().creation.createAndBind({ name: 'TOKEN', value: 'local-approval', phase: 'runtime' }, { onApprovalPending });
        try {
            await pending.promise;
            await act(async () => {});
            expect(hook.getCurrent().creation.status).toBe('waitingApproval');
            expect(hook.getCurrent().creation.busy).toBe(true);
            expect(onApprovalPending).toHaveBeenCalledOnce();
            expect(home.creations).toEqual([]);
            await act(async () => { hook.getCurrent().creation.cancel(); });
            await act(async () => { expect(await creating).toMatchObject({ ok: false, error: 'canceled' }); });
            expect(hook.getCurrent().bindings).toEqual([]);
            expect(hook.getCurrent().creation.busy).toBe(false);
        } finally { hook.getCurrent().creation.cancel(); }
    });
});
