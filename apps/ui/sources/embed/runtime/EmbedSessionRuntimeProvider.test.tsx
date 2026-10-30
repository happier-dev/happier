// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://app.happier.dev/embed/new" }

import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBrowserStorageLockBoundary, renderScreen, waitForTestEvent } from '@/dev/testkit';
import { EmbedSessionRuntimeProvider, useEmbedSessionRuntime } from './EmbedSessionRuntimeProvider';
import type { EmbedSessionRuntime } from './createEmbedSessionRuntime';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('frame-owned runtime mount', () => {
    it('resolves the runtime Home from the frame server selection', async () => {
        const restoreBrowserStorageLock = installBrowserStorageLockBoundary();
        const events = new EventTarget();
        vi.stubGlobal('window', {
            location: new URL('https://app.happier.dev/embed/new?server=https%3A%2F%2Fcredential-home.example&i=instance&n=nonce'),
            addEventListener: events.addEventListener.bind(events),
            removeEventListener: events.removeEventListener.bind(events),
        });
        let observedEndpoint: string | null = null;
        function Probe() {
            observedEndpoint = useEmbedSessionRuntime().runtime.endpointUrl;
            return React.createElement('RuntimeProbe');
        }
        const screen = await renderScreen(<EmbedSessionRuntimeProvider><Probe /></EmbedSessionRuntimeProvider>);
        try {
            await vi.waitFor(() => expect(observedEndpoint).toBe('https://credential-home.example'));
        } finally {
            await screen.unmount();
            restoreBrowserStorageLock();
        }
    });
    it('provides an unadmitted loading runtime with an ephemeral public recipient and no credential', async () => {
        const observed: Array<{ phase: string; token: string | null; publicKey: string; endpoint: string }> = [];
        function Probe() {
            const { runtime, snapshot } = useEmbedSessionRuntime();
            observed.push({ phase: snapshot.phase, token: snapshot.credential?.token ?? null,
                publicKey: runtime.embedPublicKey, endpoint: runtime.endpointUrl });
            return React.createElement('RuntimeProbe');
        }
        const screen = await renderScreen(<EmbedSessionRuntimeProvider endpointUrl="https://home.example"><Probe /></EmbedSessionRuntimeProvider>);
        try {
            await waitForTestEvent(screen.subscribe, () => observed.at(-1), value => value !== undefined);
            expect(observed.at(-1)).toMatchObject({ phase: 'loading', token: null, endpoint: 'https://home.example' });
            expect(observed.at(-1)?.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        } finally {
            await screen.unmount();
        }
    });
    it('retires the page on hide and creates a different recipient after a browser restore', async () => {
        const events = new EventTarget();
        // Browser lifecycle is the genuine external boundary; crypto/runtime owners stay real.
        vi.stubGlobal('window', { location: new URL('https://home.example/embed/new'),
            addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
        const roots: EmbedSessionRuntime[] = [];
        function Probe() {
            const { runtime } = useEmbedSessionRuntime();
            if (roots.at(-1) !== runtime) roots.push(runtime);
            return React.createElement('RuntimeProbe');
        }
        const screen = await renderScreen(<EmbedSessionRuntimeProvider endpointUrl="https://home.example"><Probe /></EmbedSessionRuntimeProvider>);
        await vi.waitFor(() => expect(roots).toHaveLength(1));
        const first = roots[0]!;
        await act(async () => { events.dispatchEvent(new Event('pagehide')); });
        expect(first.getSnapshot().credential).toBeNull();
        expect(first.getSnapshot().phase).toBe('error');
        await act(async () => { events.dispatchEvent(new Event('pageshow')); });
        await vi.waitFor(() => expect(roots).toHaveLength(2));
        expect(roots[1]!.embedPublicKey).not.toBe(first.embedPublicKey);
        expect(roots[1]!.getSnapshot().credential).toBeNull();
        await screen.unmount();
    });
});
