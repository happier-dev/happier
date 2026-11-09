import { afterEach, expect, it, vi } from 'vitest';
import * as React from 'react';

import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installTokenStorageWebPlatformMocks();
installDisconnectedServerSocketBoundary();
// Select the browser persistence adapter while retaining its real custody owner.
vi.mock('@/sync/domains/pending/pendingTerminalConnect', async () =>
    await import('@/sync/domains/pending/pendingTerminalConnect.web'));

await loadSyncSingletonForTests();
const { useTerminalConnectWebRequest } = await import('./useTerminalConnectWebRequest');
const pending = await import('@/sync/domains/pending/pendingTerminalConnect.web');
const { useActiveServerAccountScope } = await import('@/sync/store/hooks');
const connections: Array<Awaited<ReturnType<typeof restoreServerAccountForTest>>> = [];
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | null = null;

afterEach(async () => {
    standardCleanup();
    pending.clearPendingTerminalConnect();
    for (const connection of connections.splice(0).reverse()) await connection.dispose();
    browser?.restore();
    browser = null;
});

it('resumes a scrubbed terminal request when its Account hydrates after a browser reload', async () => {
    browser = await installBrowserRuntimeForTests({ url: 'https://app.happier.dev/terminal/connect?happier_hmr=0' });
    const account = { serverUrl: 'https://terminal-home.example.test', serverIdentityId: 'srv_terminal_reload', accountId: 'terminal-account' };
    const first = await restoreServerAccountForTest(account);
    const request = {
        publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        serverUrl: account.serverUrl,
        serverIdentityId: account.serverIdentityId,
        pairing: { secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 },
    };
    pending.setPendingTerminalConnect(request);
    expect(pending.getPendingTerminalConnect()).toEqual(request);
    await first.dispose();
    expect(pending.getPendingTerminalConnect()).toBeNull();

    const observed: Array<{ accountId: string | undefined; publicKey: string | undefined; eligiblePublicKey: string | undefined }> = [];
    const hook = await renderHook((hash: string | undefined) => {
        const result = useTerminalConnectWebRequest(hash);
        const scope = useActiveServerAccountScope();
        React.useEffect(() => {
            observed.push({ accountId: scope?.accountId, publicKey: result.request?.publicKeyB64Url,
                eligiblePublicKey: pending.getPendingTerminalConnect()?.publicKeyB64Url });
        }, [result.request, scope]);
        return result;
    }, { initialProps: undefined });
    expect(hook.getCurrent().hashProcessed).toBe(true);
    expect(hook.getCurrent().request).toBeNull();

    await act(async () => { connections.push(await restoreServerAccountForTest({ ...account, accountId: 'another-account' })); });
    expect(pending.getPendingTerminalConnect()).toBeNull();
    expect(hook.getCurrent().request).toBeNull();

    await act(async () => { connections.push(await restoreServerAccountForTest(account)); });

    expect(pending.getPendingTerminalConnect()).toEqual(request);
    expect(hook.getCurrent().request).toEqual(request);
    expect(browser.window.location.hash).toBe('');

    observed.length = 0;
    await act(async () => { connections.push(await restoreServerAccountForTest({ ...account, accountId: 'another-account' })); });
    expect(observed.every(value => value.publicKey === undefined || value.publicKey === value.eligiblePublicKey)).toBe(true);
    expect(observed.filter(value => value.accountId === 'another-account').every(value => value.publicKey === undefined)).toBe(true);
    expect(hook.getCurrent().request).toBeNull();
    await act(async () => { connections.push(await restoreServerAccountForTest(account)); });

    const { encodeTerminalConnectLinkV4Payload } = await import('@happier-dev/protocol/auth/terminalConnectLinkV4');
    const suppliedKey = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI';
    const payload = encodeTerminalConnectLinkV4Payload({
        v: 4,
        publicKeyB64Url: suppliedKey,
        pairing: { v: 3, ...request.pairing, homeServerIdentityId: account.serverIdentityId, supportsTokenOnly: true },
        homeConnectionDescriptor: {
            v: 1, homeServerIdentityId: account.serverIdentityId, canonicalServerUrl: account.serverUrl,
            revision: 1, endpoints: [{ kind: 'https', url: account.serverUrl }],
        },
    });
    await hook.rerender(`v4=${payload}`);
    expect(hook.getCurrent().request?.publicKeyB64Url).toBe(suppliedKey);

    pending.setPendingTerminalConnect(request);
    const suppliedEntryRequests: Array<string | undefined> = [];
    const suppliedEntry = await renderHook(() => {
        const result = useTerminalConnectWebRequest(`v4=${payload}`);
        React.useEffect(() => {
            suppliedEntryRequests.push(result.request?.publicKeyB64Url);
        }, [result.request]);
        return result;
    });
    expect(suppliedEntryRequests.every(key => key === undefined || key === suppliedKey)).toBe(true);
    expect(suppliedEntry.getCurrent().request?.publicKeyB64Url).toBe(suppliedKey);
    expect(pending.getPendingTerminalConnect()?.publicKeyB64Url).toBe(suppliedKey);

    const { bootstrapTerminalConnectWebHash } = await import('@/utils/path/terminalConnectWebBootstrap');
    for (const source of ['route', 'visible', 'bootstrap'] as const) {
        pending.setPendingTerminalConnect(request);
        const url = new URL('https://app.happier.dev/terminal/connect#v4=malformed');
        browser.window.history.replaceState(null, '', source === 'route' ? url.pathname : url.href);
        if (source === 'bootstrap') bootstrapTerminalConnectWebHash({
            url, sessionStorage: browser.window.sessionStorage, history: browser.window.history,
        });
        const invalidEntryRequests: Array<string | undefined> = [];
        const invalidEntry = await renderHook(() => {
            const result = useTerminalConnectWebRequest(source === 'route' ? 'v4=malformed' : undefined);
            React.useEffect(() => {
                invalidEntryRequests.push(result.request?.publicKeyB64Url);
            }, [result.request]);
            return result;
        });
        expect(invalidEntry.getCurrent().hashProcessed).toBe(true);
        expect(invalidEntry.getCurrent().request).toBeNull();
        expect(invalidEntryRequests.every(key => key === undefined)).toBe(true);
        expect(pending.getPendingTerminalConnect()).toEqual(request);
    }
});
