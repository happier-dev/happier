import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { standardCleanup, renderScreen } from '@/dev/testkit';
import { createBrowserWorkspaceOpeningFixture } from '@/dev/testkit/fixtures/browserWorkspaceOpening';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/browser';
import type { BrowserDaemonViewV1 } from '@happier-dev/protocol/browser/control/v1';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { storage } from '@/sync/domains/state/storage';
import { localSettingsDefaults, localSettingsParse } from '@/sync/domains/settings/localSettings';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

const external = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: external }));

// The daemon discovery transport is the genuine external boundary; address/engine/Action logic stays real.
const daemon = vi.hoisted(() => ({ views: [] as BrowserDaemonViewV1[] }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (input: { method: string }) => {
        if (input.method === 'daemon.browser.view.list') return { protocolVersion: 1, views: daemon.views };
        throw new Error('Unexpected Machine RPC');
    },
}));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const originalState = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(originalState, true); });

describe('chat link location Action (CHAT-LINKS-1109)', () => {
    it('is a device-local preference an agent reads and sets without approval, Your browser by default', async () => {
        expect(localSettingsDefaults.chatLinkOpenLocation).toBe('browser');
        const account = await createSecretSettingsTestHarness({});
        try {
            const executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => null });
            const context = { surface: 'agent', serverId: account.scope.serverId, authority: 'account_automation', actionCaller: { kind: 'host' } } as const;
            const anchor = 'transcript.chatLinkOpenLocation';
            await act(async () => {
                expect(await executor.execute('settings.get', { anchor }, context))
                    .toMatchObject({ ok: true, result: expect.objectContaining({ value: 'browser' }) });
            });
            for (const value of ['managed', 'embedded', 'browser'] as const) {
                await act(async () => {
                    expect(await executor.execute('settings.set', { anchor, value }, context)).toMatchObject({ ok: true });
                });
                expect(storage.getState().localSettings.chatLinkOpenLocation).toBe(value);
            }
            await act(async () => {
                expect(await executor.execute('settings.set', { anchor, value: 'invalid' }, context)).toMatchObject({ ok: false });
            });
            expect(storage.getState().localSettings.chatLinkOpenLocation).toBe('browser');
            expect(account.artifacts.list()).toEqual([]);
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('reads an unknown stored value as the default', () => {
        expect(localSettingsParse({ chatLinkOpenLocation: 'invalid' }).chatLinkOpenLocation).toBe('browser');
        expect(localSettingsParse({ chatLinkOpenLocation: 'managed' }).chatLinkOpenLocation).toBe('managed');
    });
});


it.each([
    { preference: 'browser', url: 'https://example.com/docs', platform: 'web', inApp: false },
    { preference: 'managed', url: 'https://example.com/docs', platform: 'web', inApp: true },
    { preference: 'browser', url: 'http://localhost:5173/docs?tab=1#intro', platform: 'web', inApp: true },
    { preference: 'browser', url: 'http://[::1]:5173/docs?tab=1#intro', platform: 'web', inApp: true },
    { preference: 'embedded', url: 'https://example.com/docs', platform: 'ios', inApp: true },
] as const)('rendered chat click: $preference, $url, $platform', async ({ preference, url, platform, inApp }) => {
    const sessionId = 'chat-session';
    const accountId = 'chat-link-account';
    const openedUrls: string[] = [];
    daemon.views = [];
    const account = await createSecretSettingsTestHarness({ accountId,
        features: createRootLayoutFeaturesResponse({ features: { browser: {
            enabled: true, internal: { enabled: true }, viewTargets: { enabled: true },
        } } }),
        handleRequest: async (path, init) => {
            const machine = createPlainMachineReadHttpResponseFixture(path, init, accountId);
            if (machine) return machine;
            if (path !== '/v1/actions/browser.view.open') return null;
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            const command = BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS['browser.view.open'].parse(envelope.input);
            if (command.target.kind !== 'externalUrl') throw new Error('Expected external URL');
            openedUrls.push(command.target.url);
            const sourceId = `source:${command.viewId}`;
            daemon.views = [{ browserSessionId: command.browserSessionId, viewId: command.viewId,
                sourceId, target: command.target, platform, adapterKind: 'chromiumSidecar', events: [],
                captureSource: { v: 1, sourceId, sourceKind: 'browser', supportedCodecs: ['image.mjpeg'],
                    inputMode: 'shared', sidebands: [], health: { status: 'available' } } }];
            return Response.json({ v: 1, actionId: 'browser.view.open', requestId: envelope.requestId,
                execution: { ok: true, result: { v: 1, commandId: command.commandId,
                    status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] } } });
        },
    });
    const tabs: DetailsTab[] = [];
    const fixture = createBrowserWorkspaceOpeningFixture({
        scope: 'sessionDetails', scopeId: createSessionPaneScopeId(sessionId, account.scope.serverId),
        accountLifetime: { scope: account.scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
        platform, localServiceTargets: [], localServiceAddressScope: { machineId: 'chat-machine', sessionId },
        browserFeatureDecision: { featureId: 'browser', state: 'enabled', blockedBy: null, blockerCode: 'none',
            diagnostics: [], evaluatedAt: 1000, scope: { scopeKind: 'runtime' } },
        openDetailsTab: tab => { tabs.push(tab); },
    });
    const source = createReadOnlySessionTranscriptSource({ sessionId, serverId: account.scope.serverId,
        messages: [], reducerState: null, metadata: null, agentState: null });
    const { MarkdownView } = await import('@/components/markdown/MarkdownView');
    storage.setState({ localSettings: { ...localSettingsDefaults, chatLinkOpenLocation: preference } });
    external.mockClear();
    try {
        const screen = await renderScreen(<SessionTranscriptSourceProvider source={source}>
            <MarkdownView markdown={`[Documentation](${url})`} profile="transcript" />
        </SessionTranscriptSourceProvider>);
        await act(async () => { screen.findByType('EnrichedMarkdownText').props.onLinkPress({ url }); });
        if (inApp) {
            await vi.waitFor(() => expect(tabs).toHaveLength(1));
            expect(external).not.toHaveBeenCalled();
            if (preference !== 'embedded') expect(openedUrls).toEqual([url]);
        } else {
            await vi.waitFor(() => expect(external).toHaveBeenCalledWith(url));
            expect(tabs).toEqual([]);
            expect(openedUrls).toEqual([]);
        }
    } finally { fixture.dispose(); daemon.views = []; standardCleanup(); await account.dispose(); }
});

it('offers only supported destinations on the web settings row', async () => {
    const { ChatLinkOpenLocationSetting } = await import('@/components/settings/session/ChatLinkOpenLocationSetting');
    const screen = await renderScreen(<ChatLinkOpenLocationSetting />);
    expect(screen.getTextContent()).toContain('Your browser');
    expect(screen.getTextContent()).toContain('Managed');
    expect(screen.getTextContent()).not.toContain('Embedded');
});

it('shows a refused in-app chat open without sending the URL to this device', async () => {
    const account = await createSecretSettingsTestHarness({});
    const source = createReadOnlySessionTranscriptSource({ sessionId: 'unmounted-chat', serverId: account.scope.serverId,
        messages: [], reducerState: null, metadata: null, agentState: null });
    const { MarkdownView } = await import('@/components/markdown/MarkdownView');
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.alert).mockClear();
    external.mockClear();
    storage.setState({ localSettings: { ...localSettingsDefaults, chatLinkOpenLocation: 'managed' } });
    try {
        const screen = await renderScreen(<SessionTranscriptSourceProvider source={source}>
            <MarkdownView markdown="[Local](http://localhost:5173/)" profile="transcript" />
        </SessionTranscriptSourceProvider>);
        await act(async () => { screen.findByType('EnrichedMarkdownText').props.onLinkPress({ url: 'http://localhost:5173/' }); });
        await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledTimes(1));
        expect(external).not.toHaveBeenCalled();
    } finally { standardCleanup(); await account.dispose(); }
});
