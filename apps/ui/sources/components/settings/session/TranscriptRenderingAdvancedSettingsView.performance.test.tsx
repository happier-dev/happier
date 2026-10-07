import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            TextInput: 'TextInput',
        });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

beforeEach(async () => {
    await loadSyncSingletonForTests();
    storage.setState({ settings: { ...settingsDefaults, transcriptStreamingCoalesceEnabled: true, transcriptStreamingCoalesceWindowMs: 16 },
        settingsScope: { serverId: 'server-a', accountId: 'account-a' }, settingsVersion: 1 });
});
afterEach(() => {
    standardCleanup();
});

describe('Transcript advanced settings (performance)', () => {
    async function renderView() {
        const mod = await import('./TranscriptRenderingAdvancedSettingsView');
        return renderSettingsView(React.createElement(mod.default));
    }

    it('toggles streaming coalescing enabled', async () => {
        const screen = await renderView();

        expect(screen.findRowByTitle('settingsSession.transcript.advanced.coalesceEnabledTitle')).toBeTruthy();

        await act(async () => {
            screen.pressRowByTitle('settingsSession.transcript.advanced.coalesceEnabledTitle');
        });

        expect(storage.getState().settings.transcriptStreamingCoalesceEnabled).toBe(false);
    });

    it('omits the obsolete renderer menu without reading a writable renderer setting', async () => {
        const screen = await renderView();

        expect(screen.findRowByTitle('settingsSession.transcript.advanced.coalesceWindowPromptTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.transcript.advanced.listImplementationTitle')).toBeNull();
    });

    it('edits a number in place and saves the full accepted preference when the field is left', async () => {
        const screen = await renderView();
        const findField = () => screen.findAll((node) => String(node.type) === 'TextInput'
            && node.props?.accessibilityLabel === 'settingsSession.transcript.advanced.coalesceWindowPromptTitle')[0] ?? null;

        expect(findField()?.props.value).toBe('16');
        await act(async () => {
            findField()?.props.onChangeText('900ms');
        });
        expect(findField()?.props.value).toBe('900');
        await act(async () => {
            findField()?.props.onBlur();
        });

        expect(storage.getState().settings.transcriptStreamingCoalesceWindowMs).toBe(900);
        expect(findField()?.props.value).toBe('900');
    });
});
