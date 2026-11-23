import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { Item } from '@/components/ui/lists/Item';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSettingsEntryModuleMocks();
installDisconnectedServerSocketBoundary();
// Cold route transformation is fixture preparation, not the mounted choice deadline.
await import('@/app/(app)/settings/session/composer');
const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

beforeEach(() => {
    sessionSettingsEntryState.settingsState = {
        agentInputEnterToSend: true,
        agentInputEnterToSendNative: false,
        sessionMessageSendMode: 'server_pending',
        sessionBusySteerSendPolicy: 'steer_immediately',
        sessionPendingQueueDrainMode: 'drain_all',
        sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
        alwaysShowContextSize: true,
    };
});

afterEach(async () => {
    standardCleanup();
    await account?.dispose();
    account = undefined;
    storage.setState(initialStorage, true);
    resetSessionSettingsEntryState();
});

type SettingsScreen = Awaited<ReturnType<typeof renderSettingsView>>;

/** Inspect the real row and its segmented-choice accessory. */
function segmentedRow(screen: SettingsScreen, testID: string) {
    const row = screen.findAllByType(Item).find(node => node.props.testID === testID);
    if (!row) throw new Error(`Missing segmented row ${testID}`);
    return row;
}

function segmentIds(screen: SettingsScreen, testID: string): string[] {
    return segmentedRow(screen, testID).props.rightElement.props.tabs.map((tab: { id: string }) => tab.id);
}

async function renderComposerSettings(): Promise<SettingsScreen> {
    account = await createSecretSettingsTestHarness({ settings: settingsParse(sessionSettingsEntryState.settingsState), sharedEnabled: false });
    const mod = await import('@/app/(app)/settings/session/composer');
    const credentials = account.credentials;
    const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
    return renderSettingsView(React.createElement(mod.default), { wrapper });
}

describe('Session composer settings pending queue drain mode', () => {
    it('offers delivery timing while keeping the stored drain preference off the screen', async () => {
        const screen = await renderComposerSettings();

        expect(screen.findAllByType(Item).some(node => node.props.testID === 'settings-composer-pending-drain')).toBe(false);

        const timing = segmentedRow(screen, 'settings-composer-pending-timing');
        expect(timing.props.title).toBe('settingsSession.messageSending.pendingDeliveryTimingTitle');
        expect(timing.props.disabled).toBeFalsy();
        expect(segmentIds(screen, 'settings-composer-pending-timing')).toEqual(['after_foreground_ready', 'after_runtime_idle']);
        expect(timing.props.rightElement.props.activeTabId).toBe('after_foreground_ready');
    });

    it('updates delivery timing and preserves the stored legacy preference', async () => {
        const screen = await renderComposerSettings();

        await act(async () => {
            segmentedRow(screen, 'settings-composer-pending-timing').props.rightElement.props.onSelectTab('after_runtime_idle');
        });

        await vi.waitFor(() => expect(account?.persistedSettings.sessionPendingQueueDeliveryTiming).toBe('after_runtime_idle'));
        expect(storage.getState().settings.sessionPendingQueueDeliveryTiming).toBe('after_runtime_idle');
        expect(storage.getState().settings.sessionPendingQueueDrainMode).toBe('drain_all');
    });

    // The rows stay (so search never lands on a missing row) but offer no choice, and the section says why.
    it('disables the pending queue choices and says why when the pending queue cannot be used', async () => {
        sessionSettingsEntryState.settingsState.sessionMessageSendMode = 'interrupt';
        sessionSettingsEntryState.settingsState.sessionBusySteerSendPolicy = 'steer_immediately';

        const screen = await renderComposerSettings();

        expect(screen.findGroup('settingsSessionPages.composer.pendingSection')?.props.description)
            .toBe('settingsSessionPages.composer.pendingInactive');
        for (const testID of ['settings-composer-pending-timing']) {
            const row = segmentedRow(screen, testID);
            expect(row.props.disabled).toBe(true);
            expect(row.props.rightElement.props.disabled).toBe(true);
        }
    });
});
