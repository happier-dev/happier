import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup, type RenderScreenResult } from '@/dev/testkit';
import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import type { SessionTerminalWorkspaceCommand } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import type { SessionTerminalWorkspaceV1 } from '@happier-dev/protocol/terminal/workspace';
import { DocumentTabStrip } from '@/components/ui/navigation/DocumentTabStrip';
import { SessionTerminalStrip } from '@/components/sessions/terminal/strip/SessionTerminalStrip';
import type { SessionTerminalTabDescriptor } from '@/components/sessions/terminal/presentation/describeSessionTerminal';

import { SessionTerminalPage, SessionTerminalPageView } from './SessionTerminalPage';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { storage } from '@/sync/domains/state/storage';
import { readSessionTerminalWorkspaceForScope } from '@/components/sessions/terminal/sessionTerminalWorkspaceRuntime';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// The popover's portal and window measurement render inline; the real menu rows stay.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

// The pane provider persists its scopes device-locally, so each case uses its own session scope.
let sessionCounter = 0;
let sessionId = 's1';
let scopeId = createSessionPaneScopeId(sessionId, 'home-a');
let dispatchCommand: ((command: SessionTerminalWorkspaceCommand) => void) | null = null;
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | null = null;
let retireExecutorLoader: (() => void) | null = null;
let previousStorage = storage.getState();

function CommandBridge() {
    const { dispatch } = useAppPaneContext();
    React.useEffect(() => { dispatch({ type: 'activateScope', scopeId }); }, [dispatch]);
    dispatchCommand = (command) => dispatch({ type: 'terminalWorkspace', scopeId, command });
    return null;
}

async function renderPage(): Promise<RenderScreenResult> {
    retireExecutorLoader = await installRealActionExecutorModuleLoader();
    account = await createSecretSettingsTestHarness({ settings: (await import('@/sync/domains/settings/settings')).settingsParse({}) });
    scopeId = createSessionPaneScopeId(sessionId, account.scope.serverId);
    storage.setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId: account.scope.serverId }) } });
    return renderScreen(
        <AppPaneProvider>
            <CommandBridge />
            <SessionTerminalPage sessionId={sessionId} scopeId={scopeId} testIdPrefix="term" presentation="page" />
        </AppPaneProvider>,
    );
}

function shownTerminalId(): string | undefined {
    const workspace = readSessionTerminalWorkspaceForScope(scopeId);
    return workspace?.tabs.find(tab => tab.id === workspace.activeTabId)?.focusedTerminalId;
}

describe('the phone Terminal page', () => {
    beforeEach(() => {
        previousStorage = storage.getState();
        sessionCounter += 1;
        sessionId = `s${sessionCounter}`;
        scopeId = createSessionPaneScopeId(sessionId, 'home-a');
    });
    afterEach(async () => {
        standardCleanup();
        await account?.dispose();
        account = null;
        retireExecutorLoader?.();
        retireExecutorLoader = null;
        storage.setState(previousStorage, true);
    });

    it.each(['page', 'strip'] as const)('keeps all 120 %s tab visual inputs unchanged on an event-owner publication', async variant => {
        const tabs: readonly SessionTerminalTabDescriptor[] = Array.from({ length: 120 }, (_, index) => ({
            tabId: `shell-${index}`, title: `Shell ${index}`, mark: { kind: 'shell' }, status: null,
            members: [{ terminalId: `shell-${index}`, title: `Shell ${index}`, mark: { kind: 'shell' },
                status: null, detail: null, place: null, url: null, borrowed: false }],
        }));
        const workspace: SessionTerminalWorkspaceV1 = {
            v: 1, activeTabId: 'shell-0', showList: false,
            tabs: tabs.map(tab => ({ id: tab.tabId, focusedTerminalId: tab.tabId,
                terminals: [{ id: tab.tabId, target: { kind: 'workspace_shell' } }],
                root: { kind: 'leaf', terminalId: tab.tabId } })),
        };
        const context = { agentId: null, agentName: null, agentAsking: false, agentTerminalHost: null,
            sessionMachineId: null, sessionMachineName: null, machineName: () => null };
        const events: number[] = [];
        const render = (version: number, currentTabs = tabs) => variant === 'page'
            ? <SessionTerminalPageView workspace={workspace} tabs={currentTabs} context={context}
                onAction={() => { events.push(version); }} renderTerminal={() => null} testIdPrefix="stable" />
            : <SessionTerminalStrip tabs={currentTabs} activeTabId="shell-0" listShowing={false}
                activeTerminal={tabs[0]!.members[0]!} onActivateTab={() => { events.push(version); }}
                onCloseTab={() => {}} onTabMenu={() => {}} onNewShell={() => {}}
                newMenuOpen={false} onNewMenuOpenChange={() => {}} newMenuItems={[]}
                onNewMenuSelect={() => {}} canSplit={false} onSplit={() => {}}
                paneMenuItems={[]} onPaneMenuSelect={() => {}} onHide={() => {}}
                onOpenUrl={() => {}} testIdPrefix="stable" />;
        const screen = await renderScreen(render(0));
        const before = screen.findByType(DocumentTabStrip).props;
        expect(before.tabs).toHaveLength(120);
        await screen.update(render(1));
        const after = screen.findByType(DocumentTabStrip).props;
        const changedInputs = before.tabs.filter((tab: { key: string }, index: number) => (
            tab !== after.tabs[index] || before.renderLeadingIcon !== after.renderLeadingIcon
                || before.wrapTab !== after.wrapTab
        ));
        // The shared strip's cost test proves these unchanged row inputs produce zero row renders.
        expect(changedInputs).toHaveLength(0);
        await act(async () => { after.onActivate('shell-0'); });
        expect(events).toEqual([1]);
        const renamed = tabs.map((tab, index) => index === 37 ? { ...tab, title: 'Build output' } : tab);
        await screen.update(render(2, renamed));
        const titled = screen.findByType(DocumentTabStrip).props;
        expect(titled.tabs[37].title).toBe('Build output');
        expect(titled.tabs.filter((tab: { key: string }, index: number) => tab !== after.tabs[index])
            .map((tab: { key: string }) => tab.key)).toEqual(['shell-37']);
        const detailed = renamed.map((tab, index) => index === 37
            ? { ...tab, members: tab.members.map(member => ({ ...member, detail: 'New terminal output' })) } : tab);
        await screen.update(render(3, detailed));
        const latest = screen.findByType(DocumentTabStrip).props;
        expect(latest.tabs.filter((tab: { key: string }, index: number) => tab !== titled.tabs[index])).toHaveLength(0);
    });

    it('shows the session terminal workspace as chips and opens a shell in a new tab from +', async () => {
        const screen = await renderPage();
        expect(screen.findByTestId('term-chip-embedded')).toBeTruthy();
        expect(shownTerminalId()).toBe('embedded');

        await screen.pressByTestIdAsync('term-new-shell');

        await vi.waitFor(() => expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toHaveLength(2));
        expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs[1]?.terminals[0]?.target).toEqual({ kind: 'workspace_shell' });
        expect(shownTerminalId()).not.toBe('embedded');
    });

    it('focuses a chip’s terminal through the Action owner and closes a tab from its ×', async () => {
        const screen = await renderPage();
        await act(async () => {
            dispatchCommand?.({ type: 'open', terminal: { id: 'vite', target: { kind: 'session_attach' } } });
        });
        expect(shownTerminalId()).toBe('vite');

        await screen.pressByTestIdAsync('term-chip-embedded');
        await vi.waitFor(() => expect(shownTerminalId()).toBe('embedded'));

        await screen.pressByTestIdAsync('term-chip-vite');
        await vi.waitFor(() => expect(shownTerminalId()).toBe('vite'));
        await screen.pressByTestIdAsync('term-chip-close-vite');
        await vi.waitFor(() => expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs.map(tab => tab.id)).toEqual(['embedded']));
    });

    it('pages a split tab: the open chip names the half on screen and a tap shows the next half', async () => {
        const screen = await renderPage();
        await act(async () => {
            dispatchCommand?.({
                type: 'split',
                terminal: { id: 'vite', target: { kind: 'workspace_shell' } },
                availableWidthPx: 1200,
                minimumTerminalWidthPx: 320,
            });
        });
        expect(shownTerminalId()).toBe('vite');
        // The meta line offers the other half (lab B2p: a split tab is a pager).
        expect(screen.findAllByTestId('term-pager-next').length).toBeGreaterThan(0);

        await screen.pressByTestIdAsync('term-chip-embedded');

        // The tab id stays `embedded`; its focused half is the split's second member.
        await vi.waitFor(() => expect(shownTerminalId()).toBe('embedded'));
    });

});
