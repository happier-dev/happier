import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMessageViewCommonModuleMocks } from '../messageViewTestHelpers';
import type { UserTextMessage, AgentTextMessage } from '@happier-dev/session-core/messages';
import type { TranscriptForkCommon } from '../transcriptSessionCommon';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
installMessageViewCommonModuleMocks({ reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default ?? values.web } });
} });
// Home fixtures can reach React Native too: configure its native boundary before importing them.
const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// Load consumers after the canonical native and HTTP boundaries are configured.
const { View } = await import('react-native');
const { renderScreen, standardCleanup, createTestSessionTranscriptSource, wrapWithSessionTranscriptSource } = await import('@/dev/testkit');
const { TranscriptMessageSelectionProvider } = await import('../messageSelection/TranscriptMessageSelectionContext');
const { ContextMenu } = await import('@/components/ui/forms/dropdown/ContextMenu');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const featuresClient = await import('@/sync/api/capabilities/serverFeaturesClient');
const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
const { CommittedMessageActions } = await import('./CommittedMessageActions');
const { createPluginMessageActionHost, PluginMessageActionHostProvider } = await import('./PluginMessageActions');
const { resolveSelectableMessageText } = await import('../messageSelection/resolveSelectableMessageText');
let serverId = '';
let activeFeatureSubscriptions = 0;
let restoreFeatureSubscriptionObservation = () => {};
beforeEach(async () => {
    bodyRenders = 0;
    await home.reset();
    serverId = await home.addHome({ serverUrl: 'https://committed-actions.test', name: 'Action test', accountId: 'account-a' });
    getStorage().setState({ profileScope: { serverId, accountId: 'account-a' }, settings: settingsDefaults });
    getStorage().getState().applySettingsLocal({ experiments: true, featureToggles: { automations: true, workflows: true } });
    await featuresClient.getServerFeaturesSnapshot({ serverId, force: true });
    activeFeatureSubscriptions = 0;
    const subscribe = featuresClient.subscribeServerFeaturesSnapshot;
    // Observe the real feature-store lifetime without replacing its decision or subscriber.
    const observation = vi.spyOn(featuresClient, 'subscribeServerFeaturesSnapshot').mockImplementation((listener) => {
        activeFeatureSubscriptions += 1;
        const dispose = subscribe(listener);
        return () => { activeFeatureSubscriptions -= 1; dispose(); };
    });
    restoreFeatureSubscriptionObservation = () => observation.mockRestore();
});
afterEach(() => { standardCleanup(); restoreFeatureSubscriptionObservation(); });

const forkCommon: TranscriptForkCommon = {
    sessionReplayEnabled: true, sessionReplayMaxSeedChars: 1000, sessionReplayStrategy: 'recent_messages', sessionReplaySummaryRunnerV1: null,
    executionRunsEnabled: false, agentSwitchingEnabled: false,
    sessionForkSupportSource: { metadata: null },
};
const noop = () => {};
let nextBodyId = 0;
let bodyRenders = 0;

function MessageBody(props: Readonly<{ row: React.ReactNode }>) {
    bodyRenders += 1;
    const [identity] = React.useState(() => String(++nextBodyId));
    return <View accessibilityLabel={identity} testID="committed-message-body">{props.row}</View>;
}

function element(kind: 'user-text' | 'agent-text', overrides: Partial<typeof settingsDefaults> = {}, structured = false, id = 'm1', pinned = false, text = 'Useful prompt', unsupported = false, thinking = false) {
    const message: UserTextMessage | AgentTextMessage = { kind, id, localId: id, text, createdAt: 1, seq: 5, transcriptBlockIndex: 0,
        ...(kind === 'agent-text' ? { isThinking: thinking } : {}),
        messageActionReference: { v: 1, sessionId: 's1', messageId: id, observedRevision: 'r1' } };
    return wrapWithSessionTranscriptSource(<TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={[id]}>
        <CommittedMessageActions message={message} sessionId="s1" serverId={serverId}
            selectableText={resolveSelectableMessageText({ message, isStructuredOnly: structured, hasAttachmentBlockToStrip: true })}
            copyText={message.text} isStructuredOnly={structured} hasUnsupportedContent={unsupported}
            canFork forkCommon={forkCommon} isForkAllowed={() => true}
            settings={{ ...settingsDefaults, ...overrides, workspacePath: null, debugInformationEnabled: false }}
            rollbackAction={{ target: { type: 'before_user_message', userMessageSeq: 5 }, restoredDraftText: message.text }}
            onToggleMessagePin={noop} messagePins={pinned ? [{ version: 1, sessionId: 's1', seq: 5, transcriptBlockIndex: 0,
                routeMessageId: `local:${id}`, role: kind === 'user-text' ? 'user' : 'assistant', pinnedAtMs: 1, label: null }] : []}
            showActions showPinAction timestampText={null} invertTimestampAndActions={false}
            onActionsFocus={noop} onActionsBlur={noop}>
            {(row) => <MessageBody row={row} />}
        </CommittedMessageActions>
    </TranscriptMessageSelectionProvider>, createTestSessionTranscriptSource({ sessionId: 's1', serverId }));
}

describe('Committed row and native menu availability', () => {
    it('does not republish an unavailable workflow capability into a second message-body render', async () => {
        const features = createRootLayoutFeaturesResponse();
        features.features.workflows.enabled = false;
        home.answer(serverId, '/v1/features', { body: features });
        home.answer(serverId, '/v1/features/authenticated', { body: features });
        await featuresClient.getServerFeaturesSnapshot({ serverId, force: true });
        const screen = await renderScreen(element('agent-text'));
        expect(screen.findHostByTestId('transcript-message-repeatable:m1')).toBeNull();
        expect(screen.findAllByType(ContextMenu)[0]?.props.items.some((item: { id: string }) => item.id === 'makeRepeatable')).toBe(false);
        expect(bodyRenders).toBe(1);
    });

    it('subscribes only while Make repeatable is eligible, preserving a view-only recycled body and row/menu parity', async () => {
        const off = { transcriptMessageMakeRepeatableActionEnabled: false };
        const screen = await renderScreen(element('agent-text', off));
        const bodyIdentity = screen.findHostByTestId('committed-message-body')?.props.accessibilityLabel;
        const menu = () => screen.findAllByType(ContextMenu)[0]?.props.items ?? [];
        expect(activeFeatureSubscriptions).toBe(0);
        expect(screen.findHostByTestId('transcript-message-repeatable:m1')).toBeNull();
        await screen.update(element('agent-text'));
        expect(screen.findHostByTestId('transcript-message-repeatable:m1')).not.toBeNull();
        expect(menu().some((item: { id: string }) => item.id === 'makeRepeatable')).toBe(true);
        expect(activeFeatureSubscriptions).toBeGreaterThan(0);
        await screen.update(element('agent-text', off));
        expect(screen.findHostByTestId('transcript-message-repeatable:m1')).toBeNull();
        expect(menu().some((item: { id: string }) => item.id === 'makeRepeatable')).toBe(false);
        expect(activeFeatureSubscriptions).toBe(0);
        await screen.update(element('agent-text', off, false, 'recycled'));
        expect(screen.findHostByTestId('transcript-message-repeatable:recycled')).toBeNull();
        await screen.update(element('agent-text', {}, false, 'recycled'));
        expect(screen.findHostByTestId('transcript-message-repeatable:recycled')).not.toBeNull();
        for (const next of [
            element('agent-text', {}, false, 'thinking', false, 'Thinking', false, true),
            element('user-text', {}, false, 'user'),
            element('agent-text', {}, true, 'structured'),
            element('agent-text', {}, false, 'empty', false, '   '),
        ]) {
            await screen.update(next);
            expect(activeFeatureSubscriptions).toBe(0);
            expect(menu().some((item: { id: string }) => item.id === 'makeRepeatable')).toBe(false);
            expect(screen.findHostByTestId('committed-message-body')?.props.accessibilityLabel).toBe(bodyIdentity);
        }
    });

    it('leaves no committed actions when all switches are off, even with workflow eligibility', async () => {
        const screen = await renderScreen(element('agent-text', {
            transcriptMessageCopyActionEnabled: false, transcriptMessageForkActionEnabled: false,
            transcriptMessageRollbackActionEnabled: false, transcriptMessageSelectionEnabled: false,
            transcriptMessagePinActionEnabled: false, transcriptMessageSavePromptActionEnabled: false,
            transcriptMessageMakeRepeatableActionEnabled: false, transcriptMessagePluginActionsEnabled: false,
        }));
        expect(screen.findAllByType(ContextMenu)).toHaveLength(0);
        expect(screen.findHostByTestId('transcript-message-repeatable:m1')).toBeNull();
    });

    it.each([
        ['copy', 'transcriptMessageCopyActionEnabled'], ['fork', 'transcriptMessageForkActionEnabled'],
        ['rollback', 'transcriptMessageRollbackActionEnabled'], ['select', 'transcriptMessageSelectionEnabled'],
        ['pin', 'transcriptMessagePinActionEnabled'], ['savePrompt', 'transcriptMessageSavePromptActionEnabled'],
    ] as const)('%s disappears from mounted/recycled rows and menus when off', async (id, setting) => {
        const testSuffix = id === 'savePrompt' ? 'save-prompt' : id;
        for (const [kind, structured] of [['user-text', false], ['user-text', true], ['agent-text', false]] as const) {
            if (id === 'savePrompt' && (structured || kind === 'agent-text')) continue;
            const screen = await renderScreen(element(kind, {}, structured));
            expect(screen.findHostByTestId(`transcript-message-${testSuffix}:m1`) !== null).toBe(true);
            expect(screen.findAllByType(ContextMenu)[0].props.items.some((item: { id: string }) => item.id === id)).toBe(true);
            await screen.update(element(kind, { [setting]: false }, structured));
            expect(screen.findHostByTestId(`transcript-message-${testSuffix}:m1`) === null).toBe(true);
            expect(screen.findAllByType(ContextMenu)[0].props.items.some((item: { id: string }) => item.id === id)).toBe(false);
            await screen.update(element(kind, { [setting]: false }, structured, 'recycled'));
            expect(screen.findHostByTestId(`transcript-message-${testSuffix}:recycled`) === null).toBe(true);
            await screen.unmount();
        }
    });

    it('keeps an existing pin removable with the Pin preference off', async () => {
        const screen = await renderScreen(element('agent-text', { transcriptMessagePinActionEnabled: false }, false, 'm1', true));
        expect(screen.findHostByTestId('transcript-message-pin:m1')?.props.accessibilityLabel).toBe('session.transcriptNavigation.unpinMessageA11y');
        expect(screen.findAllByType(ContextMenu)[0].props.items.some((item: { id: string }) => item.id === 'pin')).toBe(false);
    });

    it('does not offer Save for assistant or structured-only text', async () => {
        const screen = await renderScreen(element('agent-text'));
        expect(screen.findHostByTestId('transcript-message-save-prompt:m1') === null).toBe(true);
        await screen.update(element('user-text', {}, true));
        expect(screen.findHostByTestId('transcript-message-save-prompt:m1') === null).toBe(true);
    });

    it.each(['   ', '[attachments]\nfile\n[/attachments]'])('does not offer Save for empty or attachment-only text', async (text) => {
        const screen = await renderScreen(element('user-text', {}, false, 'm1', false, text));
        expect(screen.findHostByTestId('transcript-message-save-prompt:m1')).toBeNull();
    });

    it('does not save an unsupported-content placeholder as a prompt', async () => {
        const screen = await renderScreen(element('user-text', {}, false, 'm1', false, 'Useful prompt', true));
        expect(screen.findHostByTestId('transcript-message-save-prompt:m1')).toBeNull();
    });

    it('removes plugin row and long-press actions on mounted and recycled rows', async () => {
        const contribution: PluginProjectionEntry = {
            pluginId: 'acme.preview', title: 'Preview', description: null, version: '1.0.0', enabled: true,
            generation: 7, generationLabel: '7', status: null, provenance: null, diagnostics: [], resources: [], editableSettingsGroups: [],
            actions: [{ id: 'preview', occurrenceId: null, title: 'Preview', description: null, icon: null,
                scopes: ['message'], surfaces: ['ui'], placementBindings: ['rowAction', 'message.menu'],
                inputHints: null, priority: null, dangerLevel: 'safe', confirmation: null, available: true }],
        };
        const host = createPluginMessageActionHost({ sessionId: 's1', resolveCurrent: () => ({
            pluginProjectionById: { 'acme.preview': contribution }, host: { machineId: 'machine-1', serverId: 'server-a',
                expectedContributorOccurrenceId: 7, sessionId: 's1', isCurrent: () => true },
        }) });
        const row = (enabled: boolean, id = 'm1') => <PluginMessageActionHostProvider host={host}>
            {element('user-text', { transcriptMessagePluginActionsEnabled: enabled }, false, id)}
        </PluginMessageActionHostProvider>;
        const screen = await renderScreen(row(true));
        expect(screen.findHostByTestId('plugin-message-action:acme.preview/preview')).not.toBeNull();
        expect(screen.findAllByType(ContextMenu)[0].props.items.some((item: { id: string }) => item.id === 'plugin:acme.preview/preview')).toBe(true);
        await screen.update(row(false));
        expect(screen.findHostByTestId('plugin-message-action:acme.preview/preview')).toBeNull();
        expect(screen.findAllByType(ContextMenu)[0].props.items.some((item: { id: string }) => item.id === 'plugin:acme.preview/preview')).toBe(false);
        await screen.update(row(false, 'recycled'));
        expect(screen.findHostByTestId('plugin-message-action:acme.preview/preview')).toBeNull();
    });
});
