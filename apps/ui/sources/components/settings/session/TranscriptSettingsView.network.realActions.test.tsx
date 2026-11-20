import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { settingsParse } from '@/sync/domains/settings/settings';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// The native Markdown SDK is outside this settings contract. Preserve its text output;
// renderer animation/package installation is covered by the SDK's own lanes.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: ({ text, startOffset }: { text: string; startOffset: number }) =>
        [{ text, startOffset, animated: false }],
}));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storageStore');
await loadSyncSingletonForTests();
const { TranscriptSettingsView } = await import('./TranscriptSettingsView');

describe('Transcript preferences through Actions', () => {
    it('refuses disabled UI settings writes and accepts them after explicit waiver', async () => {
        await homes.reset();
        const serverId = await homes.addHome({ name: 'Home', serverUrl: 'https://visual-settings.test', accountId: 'alice' });
        let saved: Record<string, unknown> = { agentHtmlNetworkPolicy: 'allowed', transcriptShowToolCalls: false, transcriptShowTurnDuration: true,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } };
        let version = 1;
        const writes: unknown[] = [];
        homes.answer(serverId, 'GET /v2/account/settings', { select: () => ({ body: { version, content: { t: 'plain', v: saved } } }) });
        homes.answer(serverId, 'POST /v2/account/settings', { select: input => {
            writes.push(input);
            const update = AccountSettingsV2UpdateRequestSchema.parse(input);
            if (update.content?.t !== 'plain') throw new Error('Plain Account must retain plain settings');
            if (typeof update.content.v !== 'object' || update.content.v === null || Array.isArray(update.content.v))
                throw new Error('Account settings must be an object');
            saved = update.content.v;
            version += 1;
            return { body: { success: true, version } };
        } });
        // Sync's first read must see this case's disabled policy, not the Home's empty baseline.
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://visual-settings.test', accountId: 'alice', request: homes.request });
        installHomeGovernanceBoundaries(homes);
        onTestFinished(async () => { standardCleanup(); await connection.dispose(); });
        const scope = { serverId: connection.home.id, accountId: 'alice' };
        storage.getState().applySettingsForScope(scope, settingsParse(saved), version);
        const screen = await renderScreen(<TranscriptSettingsView />);
        await screen.pressByTestIdAsync('settings-session-transcript-agent-html-network:ask');
        await screen.pressByTestIdAsync('settings-session-transcript-show-turn-duration');
        expect(storage.getState().settings.agentHtmlNetworkPolicy).toBe('allowed');
        expect(storage.getState().settings.transcriptShowTurnDuration).toBe(true);
        expect(writes).toEqual([]);
        expect(saved.agentHtmlNetworkPolicy).toBe('allowed');
        saved = { ...saved, actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } } };
        version += 1;
        await act(async () => { storage.getState().applySettingsForScope(scope, settingsParse(saved), version); });
        await screen.pressByTestIdAsync('settings-session-transcript-agent-html-network:ask');
        await vi.waitFor(() => expect(saved.agentHtmlNetworkPolicy).toBe('ask'));
        await screen.pressByTestIdAsync('settings-session-transcript-show-turn-duration');
        await vi.waitFor(() => expect(saved.transcriptShowTurnDuration).toBe(false));
        expect(saved.transcriptShowToolCalls).toBe(false);
    });
});
