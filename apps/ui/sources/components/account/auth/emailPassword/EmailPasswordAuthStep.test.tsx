import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { EmailPasswordLoginTarget } from '@/auth/password/loginEmailPassword';

const boundary = vi.hoisted(() => ({
    close: vi.fn(),
    login: vi.fn<() => Promise<void | 'completed' | 'retired'>>(async () => {}),
    reachExactHome: vi.fn(async () => true),
}));

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
// The shared password controller has its own owner tests. This host owns only
// what happens once that controller reports a login that already committed.
vi.mock('./EmailPasswordAuthPanel', () => ({
    EmailPasswordAuthPanel: (props: Readonly<{
        onAuthenticated: (outcome: unknown) => void | Promise<void>;
    }>) => React.createElement('EmailPasswordAuthPanelMock', {
        testID: 'email-password-panel',
        onPress: () => props.onAuthenticated({ credentials: { token: 'home-b-token' } }),
    }),
}));

import { EmailPasswordAuthStep } from './EmailPasswordAuthStep';

const TARGET: EmailPasswordLoginTarget = {
    endpointUrl: 'https://home-b.example.test',
    canonicalServerUrl: 'https://home-b.example.test',
    addressAnchorUrl: 'https://home-b.example.test',
    serverId: 'home-b',
    serverIdentityId: 'srv_home_b',
};

let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;

async function mountConnectStep(): Promise<void> {
    screen = await renderScreen(
        <EmailPasswordAuthStep
            target={TARGET}
            recoveryTarget={TARGET.serverIdentityId}
            action="connect"
            mode="either"
            onAuthenticated={boundary.login}
            reachExactHome={boundary.reachExactHome}
            onClose={boundary.close}
        />,
    );
}

beforeEach(() => {
    boundary.close.mockClear();
    boundary.login.mockClear();
    boundary.reachExactHome.mockReset();
    boundary.reachExactHome.mockResolvedValue(true);
});

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    await standardCleanup();
});

it('closes only once the exact Home its Connect login committed on has been reached', async () => {
    await mountConnectStep();

    await screen!.pressByTestIdAsync('email-password-panel');

    expect(boundary.login).toHaveBeenCalledOnce();
    expect(boundary.reachExactHome).toHaveBeenCalledOnce();
    expect(boundary.close).toHaveBeenCalledOnce();
});

it('keeps the authentication host open when credential recovery retires without adopting credentials', async () => {
    boundary.login.mockResolvedValueOnce('retired');
    await mountConnectStep();
    await screen!.pressByTestIdAsync('email-password-panel');
    expect(boundary.close).not.toHaveBeenCalled();
    expect(boundary.reachExactHome).not.toHaveBeenCalled();
});

it('keeps a completed Connect login retryable instead of closing over a blocked activation', async () => {
    boundary.reachExactHome.mockResolvedValue(false);
    await mountConnectStep();

    await screen!.pressByTestIdAsync('email-password-panel');

    // Leaving here is what would drop the person back on Welcome with a
    // credential that already committed and nothing to say so.
    expect(boundary.close).not.toHaveBeenCalled();
    expect(screen!.findByTestId('email-password-modal-destination-home-error')).not.toBeNull();
    // The controller is retired, so the retry cannot become a second login.
    expect(screen!.findByTestId('email-password-panel')).toBeNull();

    boundary.reachExactHome.mockResolvedValue(true);
    await screen!.pressByTestIdAsync('email-password-modal-destination-home-retry');

    expect(boundary.reachExactHome).toHaveBeenCalledTimes(2);
    expect(boundary.login).toHaveBeenCalledOnce();
    expect(boundary.close).toHaveBeenCalledOnce();
});

it('closes on a completed login when the host owns no exact-Home arrival', async () => {
    screen = await renderScreen(
        <EmailPasswordAuthStep
            target={TARGET}
            recoveryTarget={TARGET.serverIdentityId}
            action="login"
            mode="either"
            onAuthenticated={boundary.login}
            onClose={boundary.close}
        />,
    );

    await screen.pressByTestIdAsync('email-password-panel');

    expect(boundary.reachExactHome).not.toHaveBeenCalled();
    expect(boundary.close).toHaveBeenCalledOnce();
});
