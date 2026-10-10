import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { PROMPTS_CONTEXT_SETTINGS } from '@/components/settings/prompts/context/promptsContextSettings';
import { useSettingActionWriter } from './useSettingActionWriter';

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

describe('declared setting Action writer', () => {
    it('propagates an admitted Account setting result from the real Action owner', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
        let write: ReturnType<typeof useSettingActionWriter> | undefined;
        function Probe() { write = useSettingActionWriter(); return null; }
        try {
            await renderScreen(<Probe />);
            if (!write) throw new Error('Writer missing');
            let result: Awaited<ReturnType<typeof write>> | undefined;
            await act(async () => { result = await write!(PROMPTS_CONTEXT_SETTINGS.settings.memoryUseInNewSessions, true); });
            expect(result).toMatchObject({ ok: true });
            expect(account.persistedSettings.memoryUseInNewSessions).toBe(true);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('refuses the same Account setting when the viewed Home is not its captured owner', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
        let write: ReturnType<typeof useSettingActionWriter> | undefined;
        function Probe() { write = useSettingActionWriter({ serverId: 'another-home' }); return null; }
        try {
            await renderScreen(<Probe />);
            if (!write) throw new Error('Writer missing');
            let result: Awaited<ReturnType<typeof write>> | undefined;
            await act(async () => { result = await write!(PROMPTS_CONTEXT_SETTINGS.settings.memoryUseInNewSessions, true); });
            expect(result).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
            expect(account.persistedSettings.memoryUseInNewSessions).toBe(false);
            expect(account.writes).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
