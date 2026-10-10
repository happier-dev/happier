import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { Switch } from '@/components/ui/forms/Switch';
import { AccountMemoryDefaultsSection } from './AccountMemoryDefaultsSection';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const originalState = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(originalState, true); });

describe('Account memory creation defaults admission', () => {
    it('persists the admitted creation default without replacing neighboring Account preferences', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
        try {
            const screen = await renderScreen(<AccountMemoryDefaultsSection />);
            const sessions = screen.findAllByType(Switch).find(node => node.props.testID === 'context.memoryDefaults.sessions.switch');
            if (!sessions) throw new Error('Sessions default missing');
            act(() => account.replaceSettings(settingsParse({ ...account.settings, memoryUseInNewBots: false })));
            await act(async () => sessions.props.onValueChange(true));
            await vi.waitFor(() => expect(account.persistedSettings).toMatchObject({ memoryUseInNewSessions: true, memoryUseInNewBots: false }));
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('keeps all creation defaults unchanged when their declared settings Action is disabled', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ actionsSettingsV1: {
            v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } },
        } }));
        try {
            const screen = await renderScreen(<AccountMemoryDefaultsSection />);
            for (const control of screen.findAllByType(Switch)) {
                await act(async () => control.props.onValueChange(!control.props.value));
            }
            expect(account.settings).toMatchObject({ memoryUseInNewSessions: false, memoryUseInNewBots: true, memoryUpkeepInNewBots: true });
            expect(account.writes).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
