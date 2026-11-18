import 'fake-indexeddb/auto';
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { resetSavedSecretCatalogEngineForTests, refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { settingsParse } from '@/sync/domains/settings/settings';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const modalShowSpy = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await vi.hoisted(async () => {
    const { installValueRefsCommonModuleMocks } = await import('./valueRefsTestHelpers');
    installValueRefsCommonModuleMocks({
        storage: importOriginal => importOriginal(),
        modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
            spies: { show: modalShowSpy },
        }).module,
    });
});

// Load the real store, catalog and Action graph after the network/platform boundaries.
const { ValueRefEditorModal } = await import('./ValueRefEditorModal');
const { SavedSecretPickerModal } = await import('./SavedSecretPickerModal');
const { useConnectKeySheetModel } = await import('@/components/settings/connectedServices/setup/useConnectKeySheetModel');
let home: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

function namedRow(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    return screen.findAllByTestId(testID).find(node => typeof node.props.title === 'string');
}

beforeEach(async () => {
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    modalShowSpy.mockReset().mockReturnValue('connect-sheet');
    home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
    await refreshSavedSecretCatalog(home.scope);
});
afterEach(async () => {
    await standardCleanup();
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    await home?.dispose();
    home = undefined;
});

describe('value ref saved secrets live updates', () => {
    it('keeps named rows while material resolves, shows loading, and settles without outage copy', async () => {
        const { entry } = await home!.addOwnerResource();
        await refreshSavedSecretCatalog(home!.scope, { includeMaterial: false });
        const request = home!.request.getMockImplementation()!;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        home!.request.mockImplementation(async (input, init) => {
            if (new URL(String(input)).pathname.endsWith('/materials')) await gate;
            return request(input, init);
        });
        let pending!: Promise<void>;
        await act(async () => { pending = refreshSavedSecretCatalog(home!.scope, { includeMaterial: true }); });
        const screen = await renderScreen(<SavedSecretPickerModal scope={home!.scope} onClose={vi.fn()}
            referenceSelection={{ selected: null, onSelect: vi.fn() }} />);
        const row = () => namedRow(screen, `saved-secret-picker:saved:${entry.ref}`);
        try {
            expect(row()?.props.title).toBe(entry.name);
            expect(row()?.props.subtitle).toContain('common.loading');
            expect(row()?.props.subtitle).not.toContain('secrets.catalog.status.temporarily_unavailable');
        } finally {
            await act(async () => { release(); await pending; });
        }
        await vi.waitFor(() => expect(row()?.props.disabled).toBe(false));
    });
    it('keeps a disconnected Home unavailable after its material read fails', async () => {
        const { entry } = await home!.addOwnerResource();
        await refreshSavedSecretCatalog(home!.scope, { includeMaterial: false });
        const screen = await renderScreen(<SavedSecretPickerModal scope={home!.scope} onClose={vi.fn()}
            referenceSelection={{ selected: null, onSelect: vi.fn() }} />);
        home!.request.mockRejectedValue(new TypeError('Network unavailable'));
        await act(async () => { await refreshSavedSecretCatalog(home!.scope, { includeMaterial: true }).catch(() => {}); });
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-picker:stale')).not.toBeNull());
        const row = namedRow(screen, `saved-secret-picker:saved:${entry.ref}`);
        expect(row?.props.disabled).toBe(true);
        expect(row?.props.subtitle).not.toContain('common.loading');
        expect(row?.props.onPress).toBeUndefined();
    });
    it('opens a bare key request on Saved and keeps its keys reachable after visiting New', async () => {
        const { entry } = await home!.addOwnerResource();
        await refreshSavedSecretCatalog(home!.scope, { includeMaterial: false });
        const { presentConnectSheet } = await import('@/components/settings/connectedServices/setup/ConnectedServiceSetupModal');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const result = presentConnectSheet({ service: { kind: 'key' }, intent: 'link' });
        const presentation = modalShowSpy.mock.calls.at(-1)?.[0];
        if (!presentation?.component) throw new Error('Expected the composed Connect sheet');
        expect(presentation.props.request).toEqual({ service: { kind: 'key' }, intent: 'link', scope: home!.scope });
        const screen = await renderScreen(React.createElement(InjectedAuthProvider, { credentials: home!.credentials,
            children: React.createElement(presentation.component, { ...presentation.props, onClose: presentation.onRequestClose }) }));
        await vi.waitFor(() => expect(screen.findByTestId(`connect-key-sheet:saved:${entry.ref}`)).not.toBeNull());
        expect(screen.findByTestId('saved-secret-create-value')).toBeNull();
        expect(screen.findByTestId('connect-key-sheet:mode:saved')).not.toBeNull();
        await screen.pressByTestIdAsync('connect-key-sheet:mode:new');
        expect(screen.findByTestId('saved-secret-create-value')).not.toBeNull();
        expect(screen.findByTestId(`connect-key-sheet:saved:${entry.ref}`)).toBeNull();
        await screen.pressByTestIdAsync('connect-key-sheet:mode:saved');
        await screen.pressByTestIdAsync(`connect-key-sheet:saved:${entry.ref}`);
        await screen.pressByTestIdAsync('connect-key-sheet:use');
        await expect(result).resolves.toEqual({ kind: 'selected', secretRef: entry.ref });
        expect(home!.creations).toEqual([]);
        expect(home!.settingsWrites).toEqual([]);
        await screen.unmount();
    });

    it('opens Saved without preselecting an unrelated key when the current key is inaccessible', async () => {
        const unavailable = await home!.addOwnerResource();
        const usableRef = 'happier:shared-secret:v1:resource-b';
        const index = home!.resources.findIndex(row => 'resourceId' in row && row.entry.ref === unavailable.entry.ref);
        const resource = home!.resources[index];
        if (!resource || !('resourceId' in resource)) throw new Error('Expected the current key resource');
        home!.resources.push({ ...resource, resourceId: 'resource-b', entry: { ...resource.entry, ref: usableRef, name: 'Other key' } });
        home!.resources[index] = { ...resource, entry: { ...resource.entry,
            materialStatus: 'access_removed', capabilities: { use: false, rename: false, rotate: false, manageAccess: false, delete: false } } };
        home!.request.mockClear();
        await refreshSavedSecretCatalog(home!.scope, { includeMaterial: false });
        const hook = await renderHook(() => useConnectKeySheetModel({ scope: home!.scope,
            service: { kind: 'key' }, intent: 'link', current: unavailable.entry.ref }));
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().initialMode).toBe('saved');
        expect(hook.getCurrent().preselected).toBeNull();
        expect(hook.getCurrent().linkableEntries.map(entry => entry.ref)).toEqual([usableRef]);
        expect(home!.request.mock.calls.some(([input]) => new URL(String(input)).pathname.endsWith('/materials'))).toBe(false);
        await hook.unmount();
    });

    it('preserves a template header reference when saving without changing its value', async () => {
        const onSubmit = vi.fn(() => true);
        const initialValueRef = {
            t: 'template', template: 'Bearer {api_key}',
            vars: { api_key: { t: 'savedSecret', secretId: 'personal-key' } },
        } as const;
        const screen = await renderScreen(React.createElement(ValueRefEditorModal, {
            onClose: vi.fn(), kind: 'header', initialKey: 'Authorization',
            initialValueRef, secrets: [], onSubmit, scope: home!.scope,
        }));
        await screen.pressByTestIdAsync('mcp.valueRefEditor.save');
        expect(onSubmit).toHaveBeenCalledWith({ key: 'Authorization', valueRef: initialValueRef });
    });

    it('preserves an attested header reference when saving its existing editor value', async () => {
        const onSubmit = vi.fn(() => true);
        const initialValueRef = { t: 'sessionAttested', field: 'externalPrincipalId' } as const;
        const screen = await renderScreen(React.createElement(ValueRefEditorModal, {
            onClose: vi.fn(), kind: 'header', initialKey: 'X-Wilson-On-Behalf-Of',
            initialValueRef, secrets: [], onSubmit, scope: home!.scope,
        }));
        await screen.pressByTestIdAsync('mcp.valueRefEditor.save');
        expect(onSubmit).toHaveBeenCalledWith({ key: 'X-Wilson-On-Behalf-Of', valueRef: initialValueRef });
    });

    // The one saved-secret picker (owner 2026-11-11, OWNER-1357-CONNECT 03): rows from the live catalog, by reference.
    it('SavedSecretPickerModal lists secrets added while it is open and settles the exact reference without material', async () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        home!.request.mockClear();
        const screen = await renderScreen(React.createElement(SavedSecretPickerModal, {
            onClose, scope: home!.scope, referenceSelection: { selected: null, onSelect },
        }));
        const { entry } = await home!.addOwnerResource();
        await act(async () => {
            publishHomeAccountChange(home!.scope.serverId);
            await refreshSavedSecretCatalog(home!.scope, { includeMaterial: false });
        });
        await vi.waitFor(() => expect(namedRow(screen, `saved-secret-picker:saved:${entry.ref}`)?.props.disabled).toBe(false));
        expect(screen.findByTestId('saved-secret-add')).toBeNull();
        await screen.pressByTestIdAsync(`saved-secret-picker:saved:${entry.ref}`);
        expect(onSelect).toHaveBeenCalledWith({ ref: entry.ref, resourceRevision: entry.revision });
        expect(onClose).toHaveBeenCalledOnce();
        expect(home!.settingsWrites).toEqual([]);
        expect(home!.request.mock.calls.some(([input]) => new URL(String(input)).pathname.endsWith('/materials'))).toBe(false);
    });

    it('SavedSecretPickerModal keeps a secret it cannot use listed with its status, not choosable', async () => {
        const unavailable = await home!.addOwnerResource();
        const index = home!.resources.findIndex(row => 'resourceId' in row && row.entry.ref === unavailable.entry.ref);
        const resource = home!.resources[index];
        if (!resource || !('resourceId' in resource)) throw new Error('Expected the key resource');
        home!.resources[index] = { ...resource, entry: { ...resource.entry,
            materialStatus: 'access_removed', capabilities: { use: false, rename: false, rotate: false, manageAccess: false, delete: false } } };
        await refreshSavedSecretCatalog(home!.scope, { includeMaterial: false });
        const onSelect = vi.fn();
        const screen = await renderScreen(React.createElement(SavedSecretPickerModal, {
            onClose: vi.fn(), scope: home!.scope, referenceSelection: { selected: null, onSelect },
        }));
        await vi.waitFor(() => expect(namedRow(screen, `saved-secret-picker:saved:${unavailable.entry.ref}`)).toBeTruthy());
        const row = namedRow(screen, `saved-secret-picker:saved:${unavailable.entry.ref}`);
        expect(row?.props.disabled).toBe(true);
        expect(row?.props.onPress).toBeUndefined();
        expect(row?.props.subtitle).toBeTruthy();
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('ValueRefEditorModal resolves saved-secret names from its live scoped catalog', async () => {
        const ref = 'happier:shared-secret:v1:resource-a';
        const screen = await renderScreen(React.createElement(ValueRefEditorModal, {
            onClose: vi.fn(), kind: 'header', initialKey: 'Authorization',
            initialValueRef: { t: 'savedSecret', secretId: ref }, secrets: [],
            onSubmit: () => true, scope: home!.scope,
        }));
        expect(namedRow(screen, 'mcp.valueRefEditor.secret')?.props.title).toBe('settings.mcpServersValueSecretSelect');
        expect(namedRow(screen, 'mcp.valueRefEditor.secret')?.props.subtitle).toBe(ref);
        const { entry } = await home!.addOwnerResource();
        await act(async () => { publishHomeAccountChange(home!.scope.serverId); });
        await vi.waitFor(() => expect(namedRow(screen, 'mcp.valueRefEditor.secret')?.props.title).toBe(entry.name));
        expect(namedRow(screen, 'mcp.valueRefEditor.secret')?.props.subtitle).toBe(ref);
        expect(home!.settingsWrites).toEqual([]);
    });

    it('ValueRefEditorModal opens Connect with its captured scope', async () => {
        const screen = await renderScreen(React.createElement(ValueRefEditorModal, {
            onClose: vi.fn(), kind: 'header', initialKey: 'Authorization',
            initialValueRef: { t: 'literal', v: 'token' }, secrets: [],
            onSubmit: () => true, scope: home!.scope,
        }));
        const dropdown = screen.findAll(node => typeof node.props.onSelect === 'function'
            && node.props.items?.some((item: { id: string }) => item.id === 'savedSecret'))[0];
        if (!dropdown) throw new Error('Missing value source menu');
        await act(async () => { dropdown.props.onSelect('savedSecret'); });
        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        expect(modalShowSpy.mock.calls[0]?.[0]).toMatchObject({
            props: { request: { scope: home!.scope, service: { kind: 'key' } } },
            closeOnBackdrop: true,
        });
    });

    it('explicitly clearing the key disables save until another saved secret is selected', async () => {
        const onSubmit = vi.fn(() => true);
        const onClose = vi.fn();
        const screen = await renderScreen(React.createElement(ValueRefEditorModal, {
            onClose, kind: 'header', initialKey: 'Authorization',
            initialValueRef: { t: 'savedSecret', secretId: 'original-key' }, secrets: [],
            onSubmit, scope: home!.scope,
        }));
        await screen.pressByTestIdAsync('mcp.valueRefEditor.secret.clear');
        expect(namedRow(screen, 'mcp.valueRefEditor.save')?.props.disabled).toBe(true);
        expect(namedRow(screen, 'mcp.valueRefEditor.secret')?.props.subtitle).toBe('settings.mcpServersValueSecretSelectSubtitle');
        expect(onSubmit).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('mcp.valueRefEditor.secret');
        const picker = modalShowSpy.mock.calls.at(-1)?.[0];
        await act(async () => { picker.props.onResult({ kind: 'selected', secretRef: 'replacement-key' }); });
        expect(namedRow(screen, 'mcp.valueRefEditor.save')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('mcp.valueRefEditor.save');
        expect(onSubmit).toHaveBeenCalledWith({ key: 'Authorization', valueRef: { t: 'savedSecret', secretId: 'replacement-key' } });
        expect(onClose).toHaveBeenCalledOnce();
    });
});
