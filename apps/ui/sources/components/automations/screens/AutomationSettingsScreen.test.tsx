import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';

import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { AutomationV3SettingsSchema, type AutomationV3Settings } from '@happier-dev/protocol';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

let record: AutomationV3Settings;
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let restoreActionLoader: (() => void) | null = null;
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const modalPromptSpy = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn());

installAutomationScreensCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: modalPromptSpy,
                alert: modalAlertSpy,
            },
        }).module;
    },
    storage: async (importOriginal) => await importOriginal(),
});

installDisconnectedServerSocketBoundary((socket) => {
    vi.spyOn(socket, 'emit').mockReturnValue(socket);
    vi.spyOn(socket, 'disconnect').mockImplementation(() => { socket.connected = false; return socket; });
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
});
vi.mock('@/components/ui/lists/Item', () => createPassThroughModule(['Item']));
vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemList']));
vi.mock('@/components/ui/forms/Switch', () => createPassThroughModule(['Switch']));
vi.mock('@/components/ui/surfaces/SurfaceStateCard', () => ({
    SurfaceStateCard: createPassThroughComponent('SurfaceStateCard'),
}));

/** The limit's field: the `rightElement` the `FieldValueItem` row hands to `Item` (a pass-through here). */
function maxActiveRunsField(screen: Pick<Awaited<ReturnType<typeof renderScreen>>, 'root'>): React.ReactElement<{
    value: string;
    editable?: boolean;
    error: string | null;
    onChangeText(value: string): void;
    onBlur(): void;
    onSubmitEditing(): void;
}> {
    const row = screen.root.findAll((node) => node.props?.testID === 'automation-settings-max-active-runs' && node.props?.rightElement)[0];
    if (!row) throw new Error('Run capacity field is not rendered');
    return row.props.rightElement;
}

describe('AutomationSettingsScreen', () => {
    beforeEach(async () => {
        await harness.reset();
        await loadSyncSingletonForTests();
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        serverId = await harness.addHome({ name: 'Run settings', serverUrl: 'https://run-settings.test', accountId: 'account-a' });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://run-settings.test', accountId: 'account-a' });
        const { storage } = await import('@/sync/domains/state/storage');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const scope = { serverId, accountId: 'account-a' };
        storage.setState({ profileScope: scope, settingsScope: scope, profile: { ...profileDefaults, id: 'account-a' }, settings: settingsParse({}) });
        record = { maxActiveRunsPerMachine: 4, runRetention: 'thirtyDays' };
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { tryWriteServerEnabledBitInPlace } = await import('@happier-dev/protocol');
        const features = createRootLayoutFeaturesResponse();
        tryWriteServerEnabledBitInPlace(features, 'automations', true);
        harness.answer(serverId, '/v1/features', { body: features });
        harness.answer(serverId, '/v1/features/authenticated', { body: features });
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        harness.answer(serverId, '/v3/automations/settings', { select: () => ({ body: record }) });
        harness.answer(serverId, 'PUT /v3/automations/settings', { select: (input) => {
            record = AutomationV3SettingsSchema.parse(input);
            return { body: record };
        } });
        modalPromptSpy.mockReset();
        modalPromptSpy.mockResolvedValue('2');
        modalAlertSpy.mockReset();
    });

    afterEach(async () => {
        await connection?.dispose();
        connection = null;
        restoreActionLoader?.();
        restoreActionLoader = null;
        await harness.reset();
    });

    it('loads the settings projection and applies both controls through the real Action and server writer', async () => {
        const { AutomationSettingsScreen } = await import('./AutomationSettingsScreen');

        const screen = await renderScreen(<AutomationSettingsScreen />);
        await flushHookEffects();

        await waitForHomeGovernance(() => expect(maxActiveRunsField(screen).props.value).toBe('4'));
        // The limit is typed in place (no prompt) and commits on blur through the same writer.
        const field = () => maxActiveRunsField(screen);
        expect(field().props.value).toBe('4');

        await act(async () => {
            field().props.onChangeText('2');
        });

        await act(async () => {
            field().props.onBlur();
            await Promise.resolve();
        });

        await waitForHomeGovernance(() => {
            expect(record.maxActiveRunsPerMachine).toBe(2);
            expect(field().props.editable).not.toBe(false);
        });

        expect(modalPromptSpy).not.toHaveBeenCalled();
        expect(record).toEqual({
            maxActiveRunsPerMachine: 2,
            runRetention: 'thirtyDays',
        });

        // The row renders through its search declaration (`SettingRow`), which hands its props to `Item`.
        const retentionItem = screen.root.findAll((node) => node.props?.testID === 'automation-settings-run-retention' && node.props?.rightElement)[0]!;
        const retentionSwitch = retentionItem.props.rightElement as React.ReactElement<{ onValueChange: (value: boolean) => void }>;
        await act(async () => {
            retentionSwitch.props.onValueChange(true);
            await Promise.resolve();
        });

        await waitForHomeGovernance(() => expect(record.runRetention).toBe('keepForever'));

        expect(record).toEqual({
            maxActiveRunsPerMachine: 2,
            runRetention: 'keepForever',
        });
        expect(harness.requestsFor('/v3/automations/settings').filter(request => request.input !== null)).toHaveLength(2);
    });

    it('refuses a limit the settings contract rejects, says why in place, and keeps the saved value', async () => {
        const { AutomationSettingsScreen } = await import('./AutomationSettingsScreen');

        const screen = await renderScreen(<AutomationSettingsScreen />);
        await flushHookEffects();
        const field = () => maxActiveRunsField(screen);
        await waitForHomeGovernance(() => expect(field().props.value).toBe('4'));

        await act(async () => {
            field().props.onChangeText('0');
        });
        await act(async () => {
            field().props.onSubmitEditing();
            await Promise.resolve();
        });

        expect(harness.requestsFor('/v3/automations/settings').filter(request => request.input !== null)).toHaveLength(0);
        expect(field().props.error).toBe('automations.settings.maxActiveRunsPerMachineInvalid');
        expect(field().props.value).toBe('0');

        // Correcting the draft clears the refusal before anything is written.
        await act(async () => {
            field().props.onChangeText('3');
        });
        expect(field().props.error).toBeNull();
    });

    it('honors settings Action refusal without bypassing it through the Sync writer', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const settings = settingsParse({ actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } });
        storage.setState({ settings });
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        const { AutomationSettingsScreen } = await import('./AutomationSettingsScreen');
        const screen = await renderScreen(<AutomationSettingsScreen />);
        await waitForHomeGovernance(() => expect(maxActiveRunsField(screen).props.value).toBe('4'));
        await act(async () => { maxActiveRunsField(screen).props.onChangeText('2'); });
        await act(async () => { maxActiveRunsField(screen).props.onBlur(); });
        await waitForHomeGovernance(() => expect(record.maxActiveRunsPerMachine !== 4 || modalAlertSpy.mock.calls.length > 0).toBe(true));
        expect(record).toEqual({ maxActiveRunsPerMachine: 4, runRetention: 'thirtyDays' });
        expect(modalAlertSpy).toHaveBeenCalled();
        expect(harness.requestsFor('/v3/automations/settings').filter(request => request.input !== null)).toHaveLength(0);
    });

    it('retires stale Account work and reloads settings for the newly active Account', async () => {
        const accountASettings = createDeferred<void>();
        const accountBSettings = { maxActiveRunsPerMachine: 2, runRetention: 'keepForever' as const };
        let firstRead = true;
        harness.answer(serverId, '/v3/automations/settings', { select: () => {
            if (!firstRead) return { body: accountBSettings };
            firstRead = false;
            return { body: { maxActiveRunsPerMachine: 9, runRetention: 'thirtyDays' }, respondAfter: accountASettings.promise };
        } });
        const { AutomationSettingsScreen } = await import('./AutomationSettingsScreen');

        const screen = await renderScreen(<AutomationSettingsScreen />);
        await flushHookEffects();
        await waitForHomeGovernance(() => expect(firstRead).toBe(false));

        await act(async () => {
            await harness.switchAccount(serverId, 'account-b');
            await connection?.dispose();
            connection = await restoreServerAccountForTest({ serverUrl: 'https://run-settings.test', accountId: 'account-b' });
            const { storage } = await import('@/sync/domains/state/storage');
            const scope = { serverId, accountId: 'account-b' };
            storage.setState({ profileScope: scope, settingsScope: scope, profile: { ...storage.getState().profile, id: 'account-b' } });
        });
        await screen.update(<AutomationSettingsScreen />);
        await flushHookEffects();

        await waitForHomeGovernance(() => expect(maxActiveRunsField(screen).props.value).toBe('2'));

        accountASettings.resolve();
        await act(async () => {
            await accountASettings.promise;
            await Promise.resolve();
        });
        expect(maxActiveRunsField(screen).props.value).toBe('2');
    });
});
