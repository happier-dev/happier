import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginProjectedActionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { type MessageActionReferenceV1 } from '@happier-dev/protocol/sessions/messages/messageActionReferenceV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type {
    PluginProjectionAction,
    PluginProjectionEntry,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { createPlainMachineRowFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

const network = await installSessionOpsNetworkBoundary();
const { createPluginUiTranslationRuntime, PluginUiTranslationRuntimeProvider } = await import('@/sync/domains/plugins/ui/i18n');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const { commitPreferredLanguage, getPreferredLanguage } = await import('@/text/preferredLanguage');
const { storage } = await import('@/sync/domains/state/storageStore');
const { fetchAndApplyMachines } = await import('@/sync/engine/machines/syncMachines');
const { runtimeFetch } = await import('@/utils/system/runtimeFetch');
const {
    createPluginMessageActionHost,
    PluginMessageActionHostProvider,
    PluginMessageActions,
} = await import('./PluginMessageActions');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let serverId = '';
const executeRequests = () => network.requests.filter(request => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: <T,>(values: { ios?: T; native?: T; default?: T }) =>
                values.ios ?? values.native ?? values.default,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                state: { neutral: { background: '#eeeeee' } },
                text: { secondary: '#666666' },
            },
        },
    });
});

const messageReference: MessageActionReferenceV1 = {
    v: 1,
    sessionId: 'session-1',
    messageId: 'message-1',
    observedRevision: 'revision-1',
};

function action(input: Partial<PluginProjectionAction> & Readonly<{ id: string }>): PluginProjectionAction {
    return {
        id: input.id,
        occurrenceId: input.occurrenceId ?? '7',
        title: input.title ?? input.id,
        description: input.description ?? null,
        icon: input.icon ?? null,
        scopes: input.scopes ?? ['message'],
        surfaces: input.surfaces ?? ['ui'],
        placementBindings: input.placementBindings ?? ['rowAction'],
        inputHints: input.inputHints ?? null,
        ...(input.localizedPresentation ? { localizedPresentation: input.localizedPresentation } : {}),
        priority: input.priority ?? null,
        dangerLevel: input.dangerLevel ?? 'safe',
        confirmation: input.confirmation ?? null,
        available: input.available ?? true,
    };
}

function entry(actions: readonly PluginProjectionAction[]): PluginProjectionEntry {
    return {
        pluginId: 'acme.preview',
        title: 'Preview',
        description: null,
        version: '1.0.0',
        enabled: true,
        generation: 7,
        generationLabel: '7',
        status: null,
        provenance: null,
        diagnostics: [],
        actions,
        resources: [],
        editableSettingsGroups: [],
    };
}

describe('PluginMessageActions', () => {
    it('demands copy for a visible message Action through its scoped translation owner', async () => {
        const projection: PluginUiProjectionModel = { ...EMPTY_PLUGIN_UI_PROJECTION, translationsByPluginId: {
            'acme.preview': { id: 'translations:acme.preview', pluginId: 'acme.preview', contributionKind: 'translations',
                locales: ['en'], resourceIdsByLocale: { en: 'copy-en' } },
        } };
        let reads = 0;
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async () => {
            reads++;
            return new TextEncoder().encode('{"preview.title":"Localized preview"}');
        } });
        const declared = action({ id: 'open-preview', localizedPresentation: { title: { key: 'preview.title', fallback: 'Preview' } } });
        const host = createPluginMessageActionHost({ sessionId: 'session-1', resolveCurrent: () => ({
            pluginProjectionById: { 'acme.preview': entry([declared]) }, pluginUiProjection: projection,
            resolveContributedAction: () => PluginProjectedActionV2Schema.parse({ id: 'open-preview', pluginId: 'acme.preview', occurrenceId: '7',
                title: 'Preview', scopes: ['message'], surfaces: ['ui'], placementBindings: ['rowAction'], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true }),
            host: { machineId: 'machine-1', serverId, sessionId: 'session-1', isCurrent: () => true },
        }) });
        const screen = await renderScreen(<PluginUiTranslationRuntimeProvider runtime={runtime}>
            <PluginMessageActionHostProvider host={host}>
                <PluginMessageActions messageActionReference={messageReference} invertedActionsLayout={false} />
            </PluginMessageActionHostProvider>
        </PluginUiTranslationRuntimeProvider>);
        try {
            await vi.waitFor(() => expect(screen.findByTestId('plugin-message-action:acme.preview/open-preview')?.props.accessibilityLabel).toBe('Localized preview'));
            expect(reads).toBe(1);
        } finally { await screen.unmount(); runtime.dispose(); }
    });

    it.each(['contextMenu', 'message.menu'] as const)('loads %s copy only when overflow opens and retains its trigger while copy arrives', async (placement) => {
        const previousLanguage = getPreferredLanguage();
        vi.useFakeTimers();
        commitPreferredLanguage('fr');
        const projection: PluginUiProjectionModel = { ...EMPTY_PLUGIN_UI_PROJECTION, translationsByPluginId: {
            'acme.preview': { id: 'translations:acme.preview', pluginId: 'acme.preview', contributionKind: 'translations',
                locales: ['en', 'fr', 'de'], resourceIdsByLocale: { en: 'copy-en', fr: 'copy-fr', de: 'copy-de' } },
        } };
        const reads: string[] = [];
        const finish = new Map<string, (bytes: Uint8Array) => void>();
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async (_projection, _pluginId, resourceId) => {
            reads.push(resourceId);
            return new Promise<Uint8Array>((resolve) => { finish.set(resourceId, resolve); });
        } });
        const declared = action({ id: 'menu-preview', placementBindings: [placement],
            localizedPresentation: { title: { key: 'preview.title', fallback: 'Preview' } } });
        const host = createPluginMessageActionHost({ sessionId: 'session-1', resolveCurrent: () => ({
            pluginProjectionById: { 'acme.preview': entry([declared]) }, pluginUiProjection: projection,
            resolveContributedAction: () => PluginProjectedActionV2Schema.parse({ id: declared.id, pluginId: 'acme.preview', occurrenceId: '7',
                title: 'Preview', scopes: ['message'], surfaces: ['ui'], placementBindings: [placement], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true }),
            host: { machineId: 'machine-1', serverId, sessionId: 'session-1', isCurrent: () => true },
        }) });
        const screen = await renderScreen(<PluginUiTranslationRuntimeProvider runtime={runtime}>
            <PluginMessageActionHostProvider host={host}>
                <PluginMessageActions messageActionReference={messageReference} invertedActionsLayout={false} />
            </PluginMessageActionHostProvider>
        </PluginUiTranslationRuntimeProvider>);
        try {
            const trigger = screen.findByTestId('plugin-message-actions-overflow');
            expect(trigger).toBeTruthy();
            expect(reads).toEqual([]);
            await screen.pressByTestIdAsync('plugin-message-actions-overflow');
            await act(async () => { await vi.runOnlyPendingTimersAsync(); });
            expect(reads).toEqual(['copy-en', 'copy-fr']);
            await act(async () => {
                finish.get('copy-en')!(new TextEncoder().encode('{"preview.title":"English preview"}'));
                finish.get('copy-fr')!(new TextEncoder().encode('{"preview.title":"Aperçu"}'));
            });
            expect(screen.getTextContent()).toContain('Aperçu');
            expect(screen.findByTestId('plugin-message-actions-overflow')).toBe(trigger);
            await screen.pressByTestIdAsync('plugin-message-actions-overflow');
            await screen.pressByTestIdAsync('plugin-message-actions-overflow');
            await act(async () => { await vi.runOnlyPendingTimersAsync(); });
            expect(screen.findByTestId('plugin-message-actions-overflow')?.props.accessibilityState?.expanded).toBe(true);
            expect(reads).toEqual(['copy-en', 'copy-fr']);
            expect(screen.getTextContent()).toContain('Aperçu');
        } finally { await screen.unmount(); runtime.dispose(); commitPreferredLanguage(previousLanguage); vi.useRealTimers(); }
    });

    beforeEach(async () => {
        network.resetRequests();
        const home = await network.addHome('https://message-actions.test', 'message-account');
        serverId = home.id;
        const machine = createPlainMachineRowFixture({ id: 'machine-1', accountId: home.accountId });
        network.setHttpResponder(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/machines') return Response.json([machine]);
            if (path === '/v1/machines/machine-1') return Response.json({ machine });
            return null;
        });
        storage.setState({ profileScope: { serverId, accountId: home.accountId }, machines: {},
            machineListByServerId: {}, machineListStatusByServerId: {} });
        await fetchAndApplyMachines({ credentials: { token: home.token }, expectedAccountMode: 'plain', encryption: null,
            machineDataKeys: new Map(), sourceServerId: serverId, throwOnError: true, replace: true,
            request: (path, init) => runtimeFetch(new URL(path, home.serverUrl), init),
            applyMachines: (rows, replace) => storage.getState().applyMachines(rows, replace, { sourceServerId: serverId }),
        });
        network.respond(RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ, { ok: true, inputSchema: {} });
        network.respond(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, { ok: true, result: null });
    });

    afterEach(() => {
        standardCleanup();
    });
    afterAll(() => network.dispose());

    it('preserves legacy message Actions and presents semantic menu Actions with current Message intent', async () => {
        const projection = entry([
            action({ id: 'open-preview', title: 'Open preview' }),
            action({ id: 'session-only', scopes: ['session'], placementBindings: ['contextMenu'] }),
            action({ id: 'menu-only', placementBindings: ['contextMenu'] }),
            action({ id: 'semantic-menu-only', placementBindings: ['message.menu'] }),
            action({ id: 'mixed-menu', placementBindings: ['contextMenu', 'message.menu'] }),
        ]);
        const resolveCurrent = vi.fn(() => ({
            resolveContributedAction: (identity: { pluginId: string; localId: string }) => {
                const contribution = projection.actions.find((candidate) => candidate.id === identity.localId);
                if (identity.pluginId !== projection.pluginId || !contribution) return null;
                return PluginProjectedActionV2Schema.parse({
                    id: contribution.id, pluginId: projection.pluginId, occurrenceId: String(projection.generation),
                    title: contribution.title, scopes: contribution.scopes, surfaces: contribution.surfaces,
                    placementBindings: contribution.placementBindings, execution: { target: 'daemon' },
                    dangerLevel: contribution.dangerLevel, available: true,
                });
            },
            pluginProjectionById: {
                'acme.preview': projection,
            },
            host: {
                machineId: 'machine-1',
                serverId,
                expectedContributorOccurrenceId: 7,
                sessionId: 'session-1',
                isCurrent: () => true,
            },
        }));
        const abortController = new AbortController();
        const host = createPluginMessageActionHost({
            resolveCurrent,
            sessionId: 'session-1',
            signal: abortController.signal,
        });

        const screen = await renderScreen(
            <PluginMessageActionHostProvider host={host}>
                <PluginMessageActions
                    messageActionReference={messageReference}
                    invertedActionsLayout={false}
                />
            </PluginMessageActionHostProvider>,
        );

        expect(screen.findByTestId('plugin-message-action:acme.preview/open-preview')).toBeTruthy();
        expect(screen.findByTestId('plugin-message-action:acme.preview/session-only')).toBeNull();
        expect(screen.findByTestId('plugin-message-action:acme.preview/menu-only')).toBeNull();
        expect(screen.findByTestId('plugin-message-actions-overflow')).toBeTruthy();
        const currentReadsBeforeRowPress = resolveCurrent.mock.calls.length;

        await act(async () => {
            screen.pressByTestId('plugin-message-action:acme.preview/open-preview');
            await vi.waitFor(() => expect(executeRequests()).toHaveLength(1));
        });

        expect(resolveCurrent.mock.calls.length).toBeGreaterThan(currentReadsBeforeRowPress);
        expect(executeRequests().at(-1)).toMatchObject({ targetId: 'machine-1', payload: {
            expectedContributorOccurrenceId: '7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: {},
            executionSurface: 'ui',
            sessionId: 'session-1',
            messageActionReference: messageReference,
        } });

        await act(async () => {
            screen.pressByTestId('plugin-message-actions-overflow');
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });

        expect(screen.findByTestId('plugin-message-action-menu:acme.preview/menu-only')).toBeTruthy();
        expect(screen.findByTestId('plugin-message-action-menu:acme.preview/semantic-menu-only')).toBeTruthy();
        expect(screen.findAllByType('Pressable').filter(
            (node) => node.props.testID === 'plugin-message-action-menu:acme.preview/mixed-menu',
        )).toHaveLength(1);
        expect(screen.findByTestId('plugin-message-action-menu:acme.preview/session-only')).toBeNull();

        await act(async () => {
            screen.pressByTestId('plugin-message-action-menu:acme.preview/menu-only');
            await vi.waitFor(() => expect(executeRequests().at(-1)?.payload)
                .toMatchObject({ qualifiedActionId: 'acme.preview/menu-only' }));
        });

        expect(executeRequests().at(-1)).toMatchObject({ targetId: 'machine-1', payload: {
            expectedContributorOccurrenceId: '7',
            qualifiedActionId: 'acme.preview/menu-only',
            input: {},
            executionSurface: 'ui',
            sessionId: 'session-1',
            messageActionReference: messageReference,
        } });
        const legacyRequest = executeRequests().at(-1)?.payload;
        expect(legacyRequest).not.toHaveProperty('invocation');

        await act(async () => {
            screen.pressByTestId('plugin-message-actions-overflow');
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });
        await act(async () => {
            screen.pressByTestId('plugin-message-action-menu:acme.preview/semantic-menu-only');
            await vi.waitFor(() => expect(executeRequests().at(-1)?.payload)
                .toMatchObject({ qualifiedActionId: 'acme.preview/semantic-menu-only' }));
        });

        expect(executeRequests().at(-1)).toMatchObject({ targetId: 'machine-1', payload: {
            expectedContributorOccurrenceId: '7',
            qualifiedActionId: 'acme.preview/semantic-menu-only',
            input: {},
            executionSurface: 'ui',
            sessionId: 'session-1',
            messageActionReference: messageReference,
            invocation: {
                kind: 'hostPresentedMessage',
                currentMessageIntent: messageReference,
            },
        } });
    });

    it('fails closed when the row reference is not current for the mounted transcript host', async () => {
        const resolveCurrent = vi.fn(() => {
            throw new Error('a cross-session row must not read the mounted Action projection');
        });
        const host = createPluginMessageActionHost({
            resolveCurrent,
            sessionId: 'session-1',
        });
        const screen = await renderScreen(
            <PluginMessageActionHostProvider host={host}>
                <PluginMessageActions
                    messageActionReference={{ ...messageReference, sessionId: 'other-session' }}
                    invertedActionsLayout={false}
                />
            </PluginMessageActionHostProvider>,
        );

        expect(screen.findAllByType('Pressable')).toHaveLength(0);
        expect(resolveCurrent).not.toHaveBeenCalled();
        expect(executeRequests()).toHaveLength(0);
    });

});
