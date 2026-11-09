// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://app.happier.dev/embed/new?server=https%3A%2F%2Fframe-home.example&i=instance&n=nonce" }

import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1, AccountApiTokenSelfV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { renderScreen, createRootLayoutFeaturesResponse, flushHookEffects, installBrowserStorageLockBoundary } from '@/dev/testkit';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/sync/http/client';
import { EmbedSessionRuntimeProvider, useEmbedSessionRuntime } from './EmbedSessionRuntimeProvider';
import type { EmbedSessionRuntime } from './createEmbedSessionRuntime';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('expo-crypto', async () => ({
    ...await import('@/platform/cryptoRandom.node'),
    ...await import('@/platform/randomUUID.node'),
}));

afterEach(async () => {
    resetRuntimeFetch();
    const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();
    vi.restoreAllMocks();
});

const frameHome = 'https://frame-home.example';
const parentOrigin = 'https://host.example';

function credentialSelf() {
    return AccountApiTokenSelfV1Schema.parse({
        accountId: 'account',
        accountEncryptionMode: 'plain',
        credentialId: '00000000-0000-4000-8000-000000000001',
        parentTokenId: null,
        expiresAt: null,
        grant: {
            v: 1,
            actions: { families: [], ids: [] },
            targets: { sessions: [], machines: [] },
            approve: false,
            origins: [parentOrigin],
            models: null,
            permissionModes: null,
            create: null,
        },
        embedConfig: null,
    });
}

describe('embed route Home selection', () => {
    it('routes feature bootstrap and bridge credential admission through the frame server query', async () => {
        const restoreBrowserStorageLock = installBrowserStorageLockBoundary();
        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
        const requests: string[] = [];
        setRuntimeFetch(async (input) => {
            const url = String(input);
            requests.push(url);
            const path = new URL(url).pathname;
            if (path === '/v1/features') {
                return Response.json(createRootLayoutFeaturesResponse());
            }
            if (path === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) {
                return Response.json(credentialSelf());
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        let observedRuntime: EmbedSessionRuntime | null = null;
        function BootstrapProbe() {
            const { runtime } = useEmbedSessionRuntime();
            observedRuntime = runtime;
            return React.createElement('BootstrapProbe');
        }

        const screen = await renderScreen(
            <EmbedSessionRuntimeProvider><BootstrapProbe /></EmbedSessionRuntimeProvider>,
        );
        try {
            await flushHookEffects();
            await vi.waitFor(() => expect(observedRuntime).not.toBeNull());
            await act(async () => {
                await getServerFeaturesSnapshot({ force: true });
                await observedRuntime!.initialize({
                    parentOrigin,
                    credential: { token: 'child', expiresAt: '2100-01-01T00:00:00.000Z' },
                });
            });
            expect(requests.some((url) => new URL(url).pathname === '/v1/features')).toBe(true);
            expect(requests.some((url) => new URL(url).pathname === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1)).toBe(true);
            expect(getActiveServerSnapshot().serverUrl).toBe(frameHome);
            expect(requests.every((url) => url.startsWith(`${frameHome}/`))).toBe(true);
        } finally {
            await screen.unmount();
            restoreBrowserStorageLock();
        }
    });
});
