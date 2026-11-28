import 'fake-indexeddb/auto';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { resetSavedSecretCatalogEngineForTests, refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resetSavedSecretCatalogSnapshotsForTests, resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { settingsParse } from '@/sync/domains/settings/settings';
import { act } from 'react-test-renderer';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { readCurrentUiContextActionReader } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { SecretsList } from '@/components/secrets/SecretsList';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { createCommittedFiberRenderCounter, readTestRendererRoot } from '@/dev/testkit/performance/committedFiberCounts';
import { View } from 'react-native';
import { COLLECTION_LIST_SEARCH_THRESHOLD } from '@/components/ui/lists/collection/CollectionList';
import { SavedSecretChoiceList as SavedSecretRows } from '@/components/secrets/SavedSecretChoiceList';
import { sharedSecretStatusLabel } from '@/components/secrets/savedSecretRowCopy';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await vi.hoisted(async () => {
    const { installValueRefsCommonModuleMocks } = await import('./valueRefsTestHelpers');
    installValueRefsCommonModuleMocks({
        storage: importOriginal => importOriginal(),
        modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
    });
});

// The real store, catalog, host presentation and public plugin component, below the network/platform boundaries.
const { SavedSecretChoiceList } = await import('@happier-dev/plugin-ui/components');
const { PluginUiPresentationHostProviderInternal } = await import('../../../../../../../packages/plugin-ui/src/presentationHost/context');
const { createPluginUiPrivatePresentationHost } = await import('@/components/plugins/surfaces/pluginUiPrivatePresentationHost');
const { SavedSecretReferenceChoice } = await import('./SavedSecretPickerModal');
let home: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

beforeEach(async () => {
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
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

describe('plugin saved-secret choice', () => {
    it('embeds database secret creation with a connection-string field and the enclosing form’s Cancel', async () => {
        const screen = await renderScreen(
            <PluginUiPresentationHostProviderInternal host={createPluginUiPrivatePresentationHost(undefined)}>
                <SavedSecretChoiceList testIDPrefix="database-connect-secret" selectedRef={null} onSelect={vi.fn()}
                    connectionStringLabel="Connection string" />
            </PluginUiPresentationHostProviderInternal>,
        );
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-create-value')).not.toBeNull());
        const value = screen.findAllByTestId('saved-secret-create-value').find(node => node.props.secureTextEntry);
        expect(value?.props.accessibilityLabel).toBe('Connection string');
        expect(value?.props.placeholder).toBeFalsy();
        expect(screen.findAllByTestId('saved-secret-create-name').find(node => node.props.placeholder)).toBeUndefined();
        expect(screen.findByTestId('saved-secret-create-submit')).not.toBeNull();
        expect(screen.findByTestId('saved-secret-create-cancel')).toBeNull();
        await act(async () => {
            screen.changeTextByTestId('saved-secret-create-name', 'Billing database');
            screen.changeTextByTestId('saved-secret-create-value', 'postgresql://fixture@localhost/billing');
        });
        await screen.pressByTestIdAsync('saved-secret-create-submit');
        await vi.waitFor(() => expect(home!.creations).toMatchObject([{ displayName: 'Billing database', kind: 'other' }]));
    });

    it('keeps an unavailable configured reference listed with its rendered refusal reason', async () => {
        const { entry } = await home!.addOwnerResource();
        home!.resources.length = 0;
        await refreshSavedSecretCatalog(home!.scope, { includeMaterial: false });
        const onSelectId = vi.fn();
        const screen = await renderMountedCurrentUiContext(<SecretsList secrets={[]} sharedEntries={[]}
            selectedId={entry.ref} onSelectId={onSelectId} referenceCommands allowEdit={false} allowAdd={false}
            resolveSharedReference={ref => resolveSavedSecretReference(home!.scope, [], ref)} />);
        const row = screen.findAllByTestId(`saved-secret:${entry.ref}`).find(node => typeof node.props.subtitle === 'string')!;
        const commands = readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!.commands;
        expect(commands.map(({ title, description }) => ({ title, description })))
            .toEqual([{ title: row.props.title, description: row.props.subtitle }]);
        expect(row.props.onPress).toBeUndefined();
        const executor = createDefaultActionExecutor();
        expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: commands[0]!.id },
            { surface: 'agent' })).toMatchObject({ ok: false, errorCode: 'unavailable' });
        expect(onSelectId).not.toHaveBeenCalled();
    });

    it('keeps a disabled choice with its existing reason unavailable and omits one without a reason', async () => {
        const { entry } = await home!.addOwnerResource();
        const reason = sharedSecretStatusLabel('access_removed');
        const onChoose = vi.fn();
        await renderMountedCurrentUiContext(<SavedSecretRows selectedRef={null} onChoose={onChoose}
            referenceCommands testIDPrefix="disabled-choice" rows={[
                { entry, disabled: true, note: reason },
                { entry: { ...entry, ref: `${entry.ref}-unexplained`, name: 'Unexplained key' }, disabled: true },
            ]} />);
        const commands = readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!.commands;
        expect(commands.map(({ title, description }) => ({ title, description }))).toEqual([{ title: entry.name, description: reason }]);
        const executor = createDefaultActionExecutor();
        expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: commands[0]!.id },
            { surface: 'agent' })).toMatchObject({ ok: false, errorCode: 'unavailable' });
        expect(onChoose).not.toHaveBeenCalled();
    });

    it('does not render saved-secret rows when another mounted control changes', async () => {
        await home!.addOwnerResource();
        await refreshSavedSecretCatalog(home!.scope, { includeMaterial: false });
        function OtherControl() {
            const [expanded, setExpanded] = React.useState(false);
            const toggle = () => setExpanded(value => !value);
            useCurrentUiContextLocalCommands([{ key: 'toggle', title: expanded ? 'Collapse other control' : 'Expand other control', invoke: toggle }]);
            return <View testID="other-control" onTouchEnd={toggle} />;
        }
        const counter = createCommittedFiberRenderCounter();
        let readRoot: ReturnType<typeof readTestRendererRoot> | null = null;
        const screen = await renderMountedCurrentUiContext(<React.Profiler id="reference-rows"
            onRender={() => { if (readRoot) counter.onCommitRoot(readRoot()); }}>
            <OtherControl />
            <SavedSecretReferenceChoice scope={home!.scope} selectedRef={null} onSelect={() => {}} testIDPrefix="perf-choice" />
        </React.Profiler>);
        readRoot = readTestRendererRoot(screen.root);
        counter.start();
        await act(async () => { screen.findByTestId('other-control')!.props.onTouchEnd(); });
        counter.stop();
        expect(counter.read().rendersFor(SelectableRow)).toBe(0);
        expect(screen.findByTestId('perf-choice:saved')).not.toBeNull();
    });

    it('publishes only mounted ready reference choices and shares selection with the picker press', async () => {
        const { entry } = await home!.addOwnerResource();
        await refreshSavedSecretCatalog(home!.scope, { includeMaterial: false });
        const onSelect = vi.fn();
        const screen = await renderMountedCurrentUiContext(<SavedSecretReferenceChoice scope={home!.scope}
            selectedRef={null} onSelect={onSelect} testIDPrefix="pending-field" />);
        const commands = () => readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!.commands;
        expect(commands().map(command => command.title)).toEqual([entry.name]);
        const command = commands()[0]!;
        const executor = createDefaultActionExecutor();
        home!.request.mockClear();
        await act(async () => {
            expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: command.id },
                { surface: 'agent' })).toMatchObject({ ok: true });
        });
        await screen.pressByTestIdAsync(`pending-field:saved:${entry.ref}`);
        expect(onSelect.mock.calls).toEqual([
            [{ ref: entry.ref, resourceRevision: entry.revision }],
            [{ ref: entry.ref, resourceRevision: entry.revision }],
        ]);
        expect(home!.settingsWrites).toEqual([]);
        expect(home!.request.mock.calls.some(([input]) => new URL(String(input)).pathname.endsWith('/materials'))).toBe(false);
        await screen.pressByTestIdAsync('pending-field:mode:new');
        expect(commands()).toEqual([]);
        expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: command.id },
            { surface: 'agent' })).toMatchObject({ ok: false });
        expect(onSelect).toHaveBeenCalledTimes(2);
    });

    it('opts pending Session rows into reference commands without exposing values and retires hidden choices', async () => {
        const { entry } = await home!.addOwnerResource();
        const secret = { id: 'personal-key', name: 'Personal key', kind: 'apiKey' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'private-fixture-value' }, createdAt: 1, updatedAt: 1 };
        const personal = Array.from({ length: COLLECTION_LIST_SEARCH_THRESHOLD + 1 }, (_, index) => ({
            ...secret, id: `${secret.id}-${index}`, name: `${secret.name} ${index}`,
        }));
        const onSelectId = vi.fn();
        const screen = await renderMountedCurrentUiContext(<SecretsList secrets={personal}
            sharedEntries={[entry, { ...entry, ref: `${entry.ref}-removed`, name: 'Removed key', materialStatus: 'access_removed', capabilities: { ...entry.capabilities, use: false } }]}
            onSelectId={onSelectId} referenceCommands allowEdit={false} allowAdd={false} />);
        const commands = () => readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!.commands;
        expect(commands().map(command => command.title)).toEqual([...personal.map(row => row.name), entry.name, 'Removed key']);
        expect(JSON.stringify(commands())).not.toContain(secret.encryptedValue.value);
        const command = commands()[0]!;
        const executor = createDefaultActionExecutor();
        await act(async () => {
            expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: command.id },
                { surface: 'agent' })).toMatchObject({ ok: true });
        });
        await screen.pressByTestIdAsync(`saved-secret:${personal[0]!.id}`);
        expect(onSelectId.mock.calls).toEqual([[personal[0]!.id], [personal[0]!.id]]);
        await act(async () => { screen.changeTextByTestId('saved-secret-search', personal[1]!.name); });
        expect(commands().map(command => command.title)).toEqual([personal[1]!.name]);
        expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: command.id },
            { surface: 'agent' })).toMatchObject({ ok: false });
        const filteredCommand = commands()[0]!;
        await screen.update(<SecretsList secrets={personal} onSelectId={onSelectId} allowEdit={false} allowAdd={false} />);
        expect(commands()).toEqual([]);
        expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: filteredCommand.id },
            { surface: 'agent' })).toMatchObject({ ok: false });
        expect(onSelectId).toHaveBeenCalledTimes(2);
    });

    it('draws the host list over the signed-in Account catalog and returns the chosen reference', async () => {
        const { entry } = await home!.addOwnerResource();
        await refreshSavedSecretCatalog(home!.scope, { includeMaterial: true });
        const onSelect = vi.fn();
        const screen = await renderScreen(
            <PluginUiPresentationHostProviderInternal host={createPluginUiPrivatePresentationHost(undefined)}>
                <SavedSecretChoiceList testIDPrefix="author" selectedRef={null} onSelect={onSelect} />
            </PluginUiPresentationHostProviderInternal>,
        );
        const rowID = `author:saved:${entry.ref}`;
        await vi.waitFor(() => expect(screen.findAllByTestId(rowID)
            .find(node => node.props.title === entry.name)?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync(rowID);
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect.mock.calls[0]![0]).toEqual({ ref: entry.ref, resourceRevision: expect.any(Number) });
    });

    it('offers the create form where nothing is saved yet, and keeps it one tab away once something is (R14-D6)', async () => {
        const screen = await renderScreen(<SavedSecretReferenceChoice scope={home!.scope} selectedRef={null}
            onSelect={() => {}} testIDPrefix="picker" />);
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-create-name')).not.toBeNull());
        expect(screen.findByTestId('picker:no-matches')).toBeNull();
        await screen.unmount();

        await home!.addOwnerResource();
        await refreshSavedSecretCatalog(home!.scope);
        const listed = await renderScreen(<SavedSecretReferenceChoice scope={home!.scope} selectedRef={null}
            onSelect={() => {}} testIDPrefix="picker" />);
        await vi.waitFor(() => expect(listed.findByTestId('picker:mode:new')).not.toBeNull());
        expect(listed.findByTestId('saved-secret-create-name')).toBeNull();
        await listed.pressByTestIdAsync('picker:mode:new');
        expect(listed.findByTestId('saved-secret-create-name')).not.toBeNull();
    });

    it('shows a newly saved key by name and marks it selected when other keys already exist', async () => {
        await home!.addOwnerResource();
        await refreshSavedSecretCatalog(home!.scope, { includeMaterial: false });
        function InlineChoice() {
            const [selectedRef, setSelectedRef] = React.useState<string | null>(null);
            return <SavedSecretChoiceList testIDPrefix="inline" selectedRef={selectedRef}
                onSelect={({ ref }) => setSelectedRef(ref)} />;
        }
        const screen = await renderScreen(
            <PluginUiPresentationHostProviderInternal host={createPluginUiPrivatePresentationHost(undefined)}>
                <InlineChoice />
            </PluginUiPresentationHostProviderInternal>,
        );
        await screen.pressByTestIdAsync('inline:mode:new');
        await act(async () => {
            screen.changeTextByTestId('saved-secret-create-name', 'Database key');
            screen.changeTextByTestId('saved-secret-create-value', 'synthetic-connection-address');
        });
        await screen.pressByTestIdAsync('saved-secret-create-submit');
        await vi.waitFor(() => expect(home!.creations).toHaveLength(1));
        const createdRef = home!.resources.at(-1)!.entry.ref;
        await vi.waitFor(() => expect(screen.findAllByTestId(`inline:saved:${createdRef}`)
            .find(node => node.props.title === 'Database key')).toBeDefined());
        expect(screen.findByTestId(`inline:selected:${createdRef}`)).not.toBeNull();
    });
});
