import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useBotTemplateDraftCommands } from './useBotTemplateDraftCommands';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

describe('template draft commands', () => {
    it('projects native optional draft members into strict JSON at the command read boundary', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'draft', serverUrl: 'https://template-draft.test', accountId: 'reader' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.draft!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const authority = captureActiveServerAccountScopeLifetime();
        if (!authority) throw new Error('Expected the mounted draft Account lifetime');
        const isCurrent = authority.isCurrent;
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        let commands: ReturnType<typeof useCurrentUiContextComposedCommands> = [];
        function Draft() {
            useBotTemplateDraftCommands({ kind: 'setup', isCurrent,
                read: () => ({ suggestedAgent: { agentId: 'codex', modelId: undefined }, firstTask: undefined,
                    selections: { software: [], accounts: [], mcpServers: [] } }), patch: () => false });
            return null;
        }
        function ObserveCommands() { commands = useCurrentUiContextComposedCommands(); return null; }
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextCommandsProvider authority={authority}>
                <Draft /><ObserveCommands />
            </CurrentUiContextCommandsProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        try {
            const read = commands.find(command => command.title === 'common.details')?.command;
            if (read?.kind !== 'hostLocal') throw new Error('Expected the mounted read command');
            const result = await read.invoke({ signal: new AbortController().signal, context: {} });
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error('Expected the draft read to succeed');
            expect(StrictJsonValueSchema.safeParse(result.result).success).toBe(true);
            expect(result.result).toEqual({ suggestedAgent: { agentId: 'codex' },
                selections: { software: [], accounts: [], mcpServers: [] } });
        } finally {
            await screen.unmount();
            retireActiveServerAccountScopeLifetime();
            await home.dispose();
        }
    });
});
