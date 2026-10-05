import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup, type RenderScreenResult } from '@/dev/testkit';
import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import type { SessionTerminalWorkspaceCommand } from '@/components/sessions/terminal/sessionTerminalWorkspace';

import { SessionTerminalPage } from './SessionTerminalPage';

const actions = vi.hoisted(() => ({ execute: vi.fn(async () => ({ ok: true })) }));

// The recipient-envelope HTTP API is not part of a terminal journey. Fail if this harness reaches it.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Terminal page unexpectedly reached the recipient-envelope API'); };
    return {
        createSessionDataKeyEnvelopeClient: unused,
        readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused,
        prepareSessionDataKeyEnvelopesDetached: unused,
    };
});

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
// The Action front door is the page's only write path; its executors have their own tests.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => actions.execute,
}));
// The leaf owns the PTY transport (a machine RPC boundary) and is covered by its own controller
// tests; here it only has to show which terminal the page put on screen.
vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: (props: { terminal?: { id: string } }) => React.createElement('TerminalLeaf', { terminalId: props.terminal?.id }),
}));

// The pane provider persists its scopes device-locally, so each case uses its own session scope.
let sessionCounter = 0;
let sessionId = 's1';
let scopeId = createSessionPaneScopeId(sessionId, 'home-a');
let dispatchCommand: ((command: SessionTerminalWorkspaceCommand) => void) | null = null;

function CommandBridge() {
    const { dispatch } = useAppPaneContext();
    dispatchCommand = (command) => dispatch({ type: 'terminalWorkspace', scopeId, command });
    return null;
}

async function renderPage(): Promise<RenderScreenResult> {
    return renderScreen(
        <AppPaneProvider>
            <CommandBridge />
            <SessionTerminalPage sessionId={sessionId} scopeId={scopeId} testIdPrefix="term" />
        </AppPaneProvider>,
    );
}

function shownTerminalId(screen: RenderScreenResult): string | undefined {
    return screen.root.findAll((node) => (node.type as unknown) === 'TerminalLeaf')[0]?.props.terminalId;
}

describe('the phone Terminal page', () => {
    beforeEach(() => {
        actions.execute.mockClear();
        sessionCounter += 1;
        sessionId = `s${sessionCounter}`;
        scopeId = createSessionPaneScopeId(sessionId, 'home-a');
    });
    afterEach(standardCleanup);

    it('shows the session terminal workspace as chips and opens a shell in a new tab from +', async () => {
        const screen = await renderPage();
        expect(screen.findByTestId('term-chip-embedded')).toBeTruthy();
        expect(shownTerminalId(screen)).toBe('embedded');

        await screen.pressByTestIdAsync('term-new-shell');

        expect(actions.execute).toHaveBeenCalledWith(
            'session.terminals.open',
            { target: { kind: 'workspace_shell' }, scopeId },
            expect.objectContaining({ surface: 'ui', defaultSessionId: sessionId }),
        );
    });

    it('focuses a chip’s terminal through the Action owner and closes a tab from its ×', async () => {
        const screen = await renderPage();
        await act(async () => {
            dispatchCommand?.({ type: 'open', terminal: { id: 'vite', target: { kind: 'workspace_shell', initialCommand: 'yarn dev' } } });
        });
        expect(shownTerminalId(screen)).toBe('vite');

        await screen.pressByTestIdAsync('term-chip-embedded');
        expect(actions.execute).toHaveBeenLastCalledWith('session.terminals.focus', { terminalId: 'embedded', scopeId }, expect.anything());

        await screen.pressByTestIdAsync('term-chip-close-vite');
        expect(actions.execute).toHaveBeenLastCalledWith('session.terminals.close_tab', { tabId: 'vite', scopeId }, expect.anything());
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
        expect(shownTerminalId(screen)).toBe('vite');
        // The meta line offers the other half (lab B2p: a split tab is a pager).
        expect(screen.findAllByTestId('term-pager-next').length).toBeGreaterThan(0);

        await screen.pressByTestIdAsync('term-chip-embedded');

        // The tab id stays `embedded`; its focused half is the split's second member.
        expect(actions.execute).toHaveBeenLastCalledWith('session.terminals.focus', { terminalId: 'embedded', scopeId }, expect.anything());
    });

});
