import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
    ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
} from '@happier-dev/protocol';

const input = { pluginId: 'example.orphaned-plugin' };

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

async function loadClient(params?: Readonly<{
    response?: Response;
    retireBeforeRequest?: boolean;
    retireDuringRequest?: boolean;
    serverProtocolVersion?: number | null;
}>) {
    vi.resetModules();
    let current = true;
    let generation = 1;
    const retireCallbacks = new Set<() => void>();
    const activeRequest = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
    const transport = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => {
        if (params?.retireDuringRequest) {
            current = false;
            for (const callback of [...retireCallbacks]) callback();
        }
        return params?.response ?? new Response(JSON.stringify({ status: 'erased', changed: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    const lifetime = {
        scope: { serverId: 'server-a', accountId: 'account-a' },
        isCurrent: () => current,
        onRetire: (callback: () => void) => {
            retireCallbacks.add(callback);
            return {
                dispose: () => {
                    retireCallbacks.delete(callback);
                },
            };
        },
    };
    const captureAuthority = vi.fn(async () => {
        if (params?.retireBeforeRequest) {
            current = false;
            for (const callback of [...retireCallbacks]) callback();
        }
        return {
            scope: lifetime.scope,
            context: {},
            request: transport,
        };
    });

    vi.doMock('@/sync/domains/scope/activeServerAccountScope', () => ({
        captureActiveServerAccountScopeLifetime: () => lifetime,
    }));
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({
            serverId: 'server-a',
            serverUrl: 'https://server.example',
            generation,
        }),
    }));
    vi.doMock('@/sync/api/session/apiSocket', () => ({
        apiSocket: { request: activeRequest },
    }));
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope', () => ({
        captureSessionRequestAuthorityForServerAccountScope: captureAuthority,
    }));

    const client = await import('./eraseCurrentAccountPluginData');
    if (params?.serverProtocolVersion !== null) {
        const { recordAccountStoredContentServerRequirements } = await import(
            '@/sync/http/accountStoredContentCompatibility'
        );
        recordAccountStoredContentServerRequirements({
            serverUrl: 'https://server.example',
            requirements: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: params?.serverProtocolVersion ?? 3,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        });
    }
    return {
        ...client,
        activeRequest,
        captureAuthority,
        transport,
        advanceGeneration: () => { generation += 1; },
        retireScope: () => {
            current = false;
            for (const callback of [...retireCallbacks]) callback();
        },
    };
}

describe('eraseCurrentAccountPluginData', () => {
    it('uses the captured Account-scoped request authority and sends only the plugin target', async () => {
        const client = await loadClient();

        await expect(client.eraseCurrentAccountPluginData(input)).resolves.toEqual({
            status: 'completed',
            changed: true,
        });

        expect(client.captureAuthority).toHaveBeenCalledWith({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            activeRequest: expect.any(Function),
        });
        expect(client.activeRequest).not.toHaveBeenCalled();
        const [path, init] = client.transport.mock.calls[0]!;
        expect(path).toBe('/v1/plugins/data/account-erase');
        expect(JSON.parse(String(init?.body))).toEqual(input);
        expect(new Headers(init?.headers).get(
            ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
        )).toBe(String(ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION));
    });

    it('maps an authenticated missing Account to the strict data-arm failure', async () => {
        const client = await loadClient({
            response: new Response(JSON.stringify({ status: 'account-not-found' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
            }),
        });

        await expect(client.eraseCurrentAccountPluginData(input)).resolves.toEqual({
            status: 'failed',
            reason: 'account-not-found',
        });
    });

    it('keeps a bounded transition cleanup pending for an explicit retry', async () => {
        const client = await loadClient({
            response: new Response(JSON.stringify({ status: 'transition-cleanup-pending' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        });

        await expect(client.eraseCurrentAccountPluginData(input)).resolves.toEqual({
            status: 'pending',
            reason: 'transition-cleanup',
        });
    });

    it('maps a present-user authority denial to the strict data-arm failure without exposing server details', async () => {
        const client = await loadClient({
            response: new Response(JSON.stringify({
                error: 'plugin_account_data_erase_present_user_required',
            }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' },
            }),
        });

        await expect(client.eraseCurrentAccountPluginData(input)).resolves.toEqual({
            status: 'failed',
            reason: 'request-rejected',
        });
    });

    it('does not issue a request after the captured Account scope retires', async () => {
        const client = await loadClient({ retireBeforeRequest: true });

        await expect(client.eraseCurrentAccountPluginData(input)).resolves.toEqual({
            status: 'pending',
            reason: 'unavailable',
        });

        expect(client.transport).not.toHaveBeenCalled();
    });

    it('aborts the in-flight request and drops a response after an Account switch', async () => {
        const client = await loadClient({ retireDuringRequest: true });

        await expect(client.eraseCurrentAccountPluginData(input)).resolves.toEqual({
            status: 'pending',
            reason: 'unavailable',
        });

        const [, init] = client.transport.mock.calls[0]!;
        expect(init?.signal?.aborted).toBe(true);
    });

    it('drops a response whose body resolves after the captured Account scope retires', async () => {
        let markJsonStarted!: () => void;
        const jsonStarted = new Promise<void>((resolve) => { markJsonStarted = resolve; });
        let resolveJson!: (value: unknown) => void;
        const jsonResult = new Promise<unknown>((resolve) => { resolveJson = resolve; });
        // HTTP response parsing is the external boundary; the client consumes
        // only these fields and keeps its currentness logic real.
        const response = {
            status: 200,
            ok: true,
            async json() {
                markJsonStarted();
                return await jsonResult;
            },
        } as unknown as Response;
        const client = await loadClient({ response });

        const erase = client.eraseCurrentAccountPluginData(input);
        await jsonStarted;
        client.retireScope();
        resolveJson({ status: 'erased', changed: true });

        await expect(erase).resolves.toEqual({
            status: 'pending',
            reason: 'unavailable',
        });
    });

    it('fails closed before issuing an erase request when the server protocol is too old', async () => {
        const client = await loadClient({ serverProtocolVersion: 2 });

        await expect(client.eraseCurrentAccountPluginData(input)).resolves.toEqual({
            status: 'pending',
            reason: 'unavailable',
        });

        expect(client.captureAuthority).not.toHaveBeenCalled();
        expect(client.transport).not.toHaveBeenCalled();
    });
});
