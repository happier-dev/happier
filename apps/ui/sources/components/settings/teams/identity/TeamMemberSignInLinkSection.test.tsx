import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep this tiny presentation contract independent of unrelated app-state
// testkit exports, while still consuming the canonical render/cleanup owners.
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installBrowserClipboardBoundary } from '@/dev/testkit/harness/browserClipboardBoundary';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

const pushMock = vi.hoisted(() => vi.fn());
const copyMock = vi.hoisted(() => vi.fn(async (_value: string) => true));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('expo-clipboard', () => ({ setStringAsync: copyMock }));
vi.mock('@/utils/ui/shareText', () => ({
    isTextSharingAvailable: () => false,
    shareTextSafe: vi.fn(async () => 'shared'),
}));
vi.mock('@/components/qr', () => ({ QRCode: 'QRCode' }));

import { TeamMemberSignInLinkSection } from './TeamMemberSignInLinkSection';

const ADDRESS = { serverId: 'home-1', teamId: 'team-1' } as const;
const LINK = 'https://app.example.test/teams/team-1/sign-in?target=home-descriptor';

beforeEach(() => {
    standardCleanup();
    pushMock.mockReset();
    copyMock.mockClear();
    // The web copy keeps the platform clipboard write in the click gesture.
    installBrowserClipboardBoundary(async value => { await copyMock(value); });
});

describe('TeamMemberSignInLinkSection', () => {
    it('offers distinct Open, Copy, and QR actions over the same Home-rendered portable link', async () => {
        const screen = await renderScreen(
            <TeamMemberSignInLinkSection address={ADDRESS} memberSignInUrl={LINK} />,
        );

        expect(screen.findByTestId('team-member-sign-in-open')).not.toBeNull();
        expect(screen.findByTestId('team-member-sign-in-copy-link')).not.toBeNull();
        expect(screen.findByTestId('team-member-sign-in-show-qr')).not.toBeNull();
        expect(screen.findByTestId('team-member-sign-in-qr')).toBeNull();

        await screen.pressByTestIdAsync('team-member-sign-in-copy-link');
        expect(copyMock).toHaveBeenCalledWith(LINK);

        await screen.pressByTestIdAsync('team-member-sign-in-open');
        // The preview stays inside the app while preserving the exact portable
        // Home carrier used by Copy and QR. A device-local profile id is not a
        // valid replacement for a link opened on another device.
        expect(pushMock).toHaveBeenCalledWith('/teams/team-1/sign-in?target=home-descriptor');

        await screen.pressByTestIdAsync('team-member-sign-in-show-qr');
        expect(screen.findByTestId('team-member-sign-in-qr')).not.toBeNull();
        expect(screen.findByTestId('team-member-sign-in-show-qr')?.props.accessibilityState?.expanded).toBe(true);

        await screen.pressByTestIdAsync('team-member-sign-in-show-qr');
        expect(screen.findByTestId('team-member-sign-in-qr')).toBeNull();
        expect(screen.findByTestId('team-member-sign-in-show-qr')?.props.accessibilityState?.expanded).toBe(false);
    });

    it('explains a Home that publishes no portable link instead of offering a broken one', async () => {
        const screen = await renderScreen(
            <TeamMemberSignInLinkSection address={ADDRESS} memberSignInUrl={null} />,
        );

        expect(screen.findByTestId('team-member-sign-in-unavailable')).not.toBeNull();
        expect(screen.findByTestId('team-member-sign-in-copy-link')).toBeNull();
        expect(screen.findByTestId('team-member-sign-in-open')).toBeNull();
    });

    it('preserves the Home application path prefix and encoded portable carrier for an in-app preview', async () => {
        const screen = await renderScreen(<TeamMemberSignInLinkSection address={ADDRESS}
            memberSignInUrl="https://app.example.test/happier/teams/team-1/sign-in?target=a%26b%252F&returnTo=https%3A%2F%2Fhome.test" />);
        await screen.pressByTestIdAsync('team-member-sign-in-open');
        expect(pushMock).toHaveBeenCalledWith('/happier/teams/team-1/sign-in?target=a%26b%252F&returnTo=https%3A%2F%2Fhome.test');
    });
});
