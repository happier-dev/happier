import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const executeMock = vi.hoisted(() => vi.fn());
const refreshMock = vi.hoisted(() => vi.fn());
const setClipboardMock = vi.hoisted(() => vi.fn(async () => true));
const callbackUrlMock = vi.hoisted(() => ({ value: 'https://home.example.test/v1/oauth/github-app/callback' as string | undefined }));

vi.mock('@/utils/ui/clipboard', () => ({ setClipboardStringSafe: setClipboardMock }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/components/ui/forms/FieldItem', () => ({ FieldItem: 'FieldItem' }));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: 'ActivitySpinner' }));
// Rows render their right-hand control, as the real row does; page fields are text inputs.
vi.mock('@/components/ui/lists/Item', async () => {
    const React = await import('react');
    return { Item: (props: { rightElement?: unknown }) => React.createElement('Item', props, props.rightElement as never) };
});
vi.mock('@/components/ui/forms/FieldTextInput', () => ({ FieldTextInput: 'TextInput' }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text', TextInput: 'TextInput' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: vi.fn(async () => true) }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), alertAsync: vi.fn(async () => {}), confirm: vi.fn(async () => true) } }));
vi.mock('./useManagedGitHubApps', () => ({
    HOME_GITHUB_APP_OWNER: { kind: 'home' },
    useManagedGitHubAppsClient: () => ({ execute: executeMock }),
    useManagedGitHubApps: () => ({
        refresh: refreshMock,
        state: {
            kind: 'ready',
            stale: false,
            registrations: [{
                id: 'registration-1',
                owner: { kind: 'home' },
                githubHost: 'https://github.com',
                githubAppId: '12',
                githubClientId: 'Iv1.client',
                githubAppSlug: 'happier',
                githubOwnerId: '22',
                githubOwnerLogin: 'happier-dev',
                revision: 2,
                securityRevision: 1,
                state: 'verified',
                secretHealth: { clientSecretConfigured: true, privateKeyConfigured: true, webhookSecretConfigured: true },
                lastVerifiedAt: '2026-09-01T10:00:00.000Z',
                createdAt: '2026-08-01T10:00:00.000Z',
                updatedAt: '2026-09-01T10:00:00.000Z',
                ...(callbackUrlMock.value === undefined ? {} : { callbackUrl: callbackUrlMock.value }),
            }],
            installations: [],
        },
    }),
}));

import { ManagedGitHubAppDetailContent } from './ManagedGitHubAppDetailScreen';
import { ManagedGitHubAppEditorContent } from './ManagedGitHubAppEditorScreen';

const surface = {
    scope: { serverId: 'home-1', accountId: 'account-1' },
    owner: { kind: 'home' as const },
    mutationsAvailable: true,
    routes: {
        detail: (id: string) => `/registrations/${id}`,
        edit: (id: string) => `/registrations/${id}/edit`,
        signIn: '/settings/home/home-1/policies',
    },
} as const;

beforeEach(() => {
    standardCleanup();
    executeMock.mockReset();
    refreshMock.mockReset();
    setClipboardMock.mockClear();
    callbackUrlMock.value = 'https://home.example.test/v1/oauth/github-app/callback';
});

describe('managed GitHub App callback URL', () => {
    it('shows the Home-derived callback URL on the registration and copies the exact value', async () => {
        const screen = await renderScreen(
            <ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />,
        );

        expect(screen.findByTestId('github-app-callback-url')?.props.subtitle)
            .toBe('https://home.example.test/v1/oauth/github-app/callback');

        await screen.pressByTestIdAsync('github-app-callback-url');

        expect(setClipboardMock).toHaveBeenCalledWith('https://home.example.test/v1/oauth/github-app/callback');
        // Reading a derived value is not a mutation of the registration.
        expect(executeMock).not.toHaveBeenCalled();
    });

    it('offers the same copyable callback URL beside the manual setup fields', async () => {
        const screen = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={surface}
                manifestReturn={{ kind: 'home', serverId: 'home-1' }}
                registrationId="registration-1"
            />,
        );

        expect(screen.findByTestId('github-app-callback-url')?.props.subtitle)
            .toBe('https://home.example.test/v1/oauth/github-app/callback');
    });

    it('renders no callback row when the Home publishes no public URL to derive one from', async () => {
        callbackUrlMock.value = undefined;
        const detail = await renderScreen(
            <ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />,
        );
        expect(detail.findByTestId('github-app-callback-url')).toBeNull();

        const editor = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={surface}
                manifestReturn={{ kind: 'home', serverId: 'home-1' }}
                registrationId="registration-1"
            />,
        );
        expect(editor.findByTestId('github-app-callback-url')).toBeNull();
    });
});
