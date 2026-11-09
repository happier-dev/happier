import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { TerminalConnectSurface } from './TerminalConnectSurface';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

afterEach(standardCleanup);

describe('terminal pairing storage disclosure', () => {
    it('discloses server-readable storage instead of E2EE for a plain Account', async () => {
        const state = {
            kind: 'approval' as const,
            isLoading: false,
            storageMode: 'plain' as const,
            homeUrl: 'https://target-home.example.test',
            onApprove: vi.fn(),
            onReject: vi.fn(),
        };
        const screen = await renderScreen(<TerminalConnectSurface state={state} />);
        const content = screen.getTextContent();
        expect(content).toContain('terminal.plaintextStorage');
        expect(content).toContain(state.homeUrl);
        expect(content).not.toContain('terminal.endToEndEncrypted');
        expect(content).not.toContain('terminal.securityFooterDevice');
    });

    it.each([
        { storageMode: 'e2ee' as const, consequence: 'terminal.securityFooterDevice' },
        { storageMode: 'plain' as const, consequence: 'terminal.plaintextStorageDescription' },
        { storageMode: null, consequence: 'terminal.linkProcessedOnDevice' },
    ])('says one consequence for $storageMode', async ({ storageMode, consequence }) => {
        const screen = await renderScreen(<TerminalConnectSurface state={{
            kind: 'approval',
            isLoading: false,
            storageMode,
            homeUrl: 'https://target-home.example.test',
            onApprove: vi.fn(),
            onReject: vi.fn(),
        }} />);
        const content = screen.getTextContent();
        const consequences = ['terminal.securityFooterDevice', 'terminal.plaintextStorageDescription', 'terminal.linkProcessedOnDevice'];
        expect(consequences.filter((key) => content.includes(key))).toEqual([consequence]);
    });

    it('keeps approval unavailable until the target Account mode is known', async () => {
        const state = {
            kind: 'approval' as const,
            isLoading: false,
            storageMode: null,
            homeUrl: 'https://target-home.example.test',
            onApprove: vi.fn(),
            onReject: vi.fn(),
        };
        const screen = await renderScreen(<TerminalConnectSurface state={state} />);
        expect(screen.findByTestId('terminal-connect-approve')?.props.disabled).toBe(true);
        expect(screen.getTextContent()).not.toContain('terminal.endToEndEncrypted');
    });
});

describe('terminal connect frame', () => {
    const message = { kind: 'message' as const, title: 'terminal.connectTerminal', loading: true };

    it('keeps a signed-out terminal link in the welcome split workflow pane', async () => {
        const screen = await renderScreen(<TerminalConnectSurface testID="terminal-connect" state={message} />);
        expect(screen.findByTestId('unauth-shell-terminal-connect')).not.toBeNull();
        expect(screen.findByTestId('unauth-shell-workflow-pane')).not.toBeNull();
        expect(screen.findByTestId('terminal-connect-title')).not.toBeNull();
    });

    it('shows the focused approval card once signed in', async () => {
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const screen = await renderScreen(
            <InjectedAuthProvider credentials={{ token: 'signed-in-token', secret: 'secret' }}>
                <TerminalConnectSurface testID="terminal-connect" state={message} />
            </InjectedAuthProvider>,
        );
        expect(screen.findByTestId('unauth-shell-workflow-pane')).toBeNull();
        expect(screen.findByTestId('terminal-connect')).not.toBeNull();
    });
});

describe('terminal link problems', () => {
    async function renderProblem(linkState: 'invalid' | 'expired' | 'update_required', signedIn: boolean) {
        const { terminalLinkProblemMessage } = await import('./terminalLinkProblem');
        const navigate = vi.fn();
        const state = terminalLinkProblemMessage({ linkState, signedIn, navigate });
        const surface = <TerminalConnectSurface testID="terminal-connect" state={state} />;
        if (!signedIn) return { screen: await renderScreen(surface), navigate };
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        return {
            screen: await renderScreen(
                <InjectedAuthProvider credentials={{ token: 'signed-in-token', secret: 'secret' }}>{surface}</InjectedAuthProvider>,
            ),
            navigate,
        };
    }

    it.each(['invalid', 'expired', 'update_required'] as const)('gives a signed-out %s link one way to enter a new link in the pane', async (linkState) => {
        const { screen, navigate } = await renderProblem(linkState, false);
        const next = screen.findByTestId('terminal-connect-next');
        expect(next).not.toBeNull();
        expect(screen.getTextContent()).toContain('connect.enterUrlManually');
        await next!.props.onPress?.();
        expect(navigate).toHaveBeenCalledWith('/restore?view=link');
    });

    it('sends a signed-in person to scan a new terminal code', async () => {
        const { screen, navigate } = await renderProblem('expired', true);
        expect(screen.getTextContent()).toContain('connect.scanNewQr');
        await screen.findByTestId('terminal-connect-next')!.props.onPress?.();
        expect(navigate).toHaveBeenCalledWith('/scan/terminal');
    });

    it('names each problem by its own cause', async () => {
        const titles = await Promise.all((['invalid', 'expired', 'update_required'] as const).map(async (linkState) => {
            const { terminalLinkProblemMessage } = await import('./terminalLinkProblem');
            return terminalLinkProblemMessage({ linkState, signedIn: false, navigate: vi.fn() }).title;
        }));
        expect(titles).toEqual(['terminal.invalidConnectionLink', 'modals.authRequestExpired', 'connect.updateRequiredTitle']);
    });
});
