import { describe, expect, test, vi } from 'vitest';

import {
    installWebHmrOptOutForCurrentWebTab,
    installWebHmrOptOutForWebTab,
    installWebHmrOptOutWebSocketGuard,
    resolveWebHmrOptOutActionFromUrl,
    resolveWebHmrOptOutResolution,
    shouldBlockExpoDevWebSocket,
    stripWebHmrOptOutQueryParam,
} from '@/dev/webHmrOptOut/webHmrOptOut';

describe('webHmrOptOut', () => {
    test('resolveWebHmrOptOutActionFromUrl returns null when param is missing', () => {
        expect(resolveWebHmrOptOutActionFromUrl(new URL('https://example.com/'))).toBeNull();
        expect(resolveWebHmrOptOutActionFromUrl(new URL('https://example.com/?x=1'))).toBeNull();
    });

    test('resolveWebHmrOptOutActionFromUrl returns disable for happier_hmr=0/false/off', () => {
        expect(resolveWebHmrOptOutActionFromUrl(new URL('https://example.com/?happier_hmr=0'))).toBe('disable');
        expect(resolveWebHmrOptOutActionFromUrl(new URL('https://example.com/?happier_hmr=false'))).toBe('disable');
        expect(resolveWebHmrOptOutActionFromUrl(new URL('https://example.com/?happier_hmr=off'))).toBe('disable');
    });

    test('resolveWebHmrOptOutActionFromUrl returns enable for happier_hmr=1/true/on', () => {
        expect(resolveWebHmrOptOutActionFromUrl(new URL('https://example.com/?happier_hmr=1'))).toBe('enable');
        expect(resolveWebHmrOptOutActionFromUrl(new URL('https://example.com/?happier_hmr=true'))).toBe('enable');
        expect(resolveWebHmrOptOutActionFromUrl(new URL('https://example.com/?happier_hmr=on'))).toBe('enable');
    });

    test('resolveWebHmrOptOutActionFromUrl returns reset for happier_hmr=reset', () => {
        expect(resolveWebHmrOptOutActionFromUrl(new URL('https://example.com/?happier_hmr=reset'))).toBe('reset');
    });

    test('stripWebHmrOptOutQueryParam removes only the happier_hmr param', () => {
        const url = new URL('https://example.com/?happier_hmr=0&x=1&y=2');
        const changed = stripWebHmrOptOutQueryParam(url);
        expect(changed).toBe(true);
        expect(url.toString()).toBe('https://example.com/?x=1&y=2');
    });

    test('resolveWebHmrOptOutResolution disables and persists when happier_hmr=0 is present', () => {
        const res = resolveWebHmrOptOutResolution({
            url: new URL('https://example.com/?happier_hmr=0'),
            sessionValue: null,
        });
        expect(res.disabled).toBe(true);
        expect(res.nextSessionValue).toBe('disabled');
        expect(res.shouldStripQueryParam).toBe(true);
    });

    test('resolveWebHmrOptOutResolution enables and clears persistence when happier_hmr=1 is present', () => {
        const res = resolveWebHmrOptOutResolution({
            url: new URL('https://example.com/?happier_hmr=1'),
            sessionValue: 'disabled',
        });
        expect(res.disabled).toBe(false);
        expect(res.nextSessionValue).toBeNull();
        expect(res.shouldStripQueryParam).toBe(true);
    });

    test('resolveWebHmrOptOutResolution uses sessionValue when query param is missing', () => {
        expect(
            resolveWebHmrOptOutResolution({
                url: new URL('https://example.com/'),
                sessionValue: 'disabled',
            }).disabled
        ).toBe(true);
        expect(
            resolveWebHmrOptOutResolution({
                url: new URL('https://example.com/'),
                sessionValue: null,
            }).disabled
        ).toBe(false);
    });

    test('installWebHmrOptOutForWebTab persists per-tab state and strips query param', () => {
        const store = new Map<string, string>();
        const sessionStorage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        };

        const replaced: string[] = [];
        const history = {
            replaceState: (_s: unknown, _t: string, nextUrl?: string | URL | null) => {
                if (typeof nextUrl === 'string') replaced.push(nextUrl);
                else if (nextUrl instanceof URL) replaced.push(nextUrl.toString());
                else replaced.push('');
            },
        };

        // Disable via query param
        const disabled = installWebHmrOptOutForWebTab({
            url: new URL('https://example.com/?happier_hmr=0&x=1'),
            sessionStorage,
            history,
        });
        expect(disabled).toBe(true);
        expect(globalThis.__HAPPIER_WEB_HMR_OPT_OUT__).toBe(true);
        expect(store.get('happier.web.hmrOptOut')).toBe('disabled');
        expect(replaced.at(-1)).toBe('https://example.com/?x=1');

        // Re-open without param should remain disabled (sessionStorage is per-tab).
        const stillDisabled = installWebHmrOptOutForWebTab({
            url: new URL('https://example.com/app'),
            sessionStorage,
            history,
        });
        expect(stillDisabled).toBe(true);

        // Enable via query param clears the tab state.
        const enabled = installWebHmrOptOutForWebTab({
            url: new URL('https://example.com/?happier_hmr=1'),
            sessionStorage,
            history,
        });
        expect(enabled).toBe(false);
        expect(globalThis.__HAPPIER_WEB_HMR_OPT_OUT__).toBe(false);
        expect(store.get('happier.web.hmrOptOut') ?? null).toBeNull();
        expect(replaced.at(-1)).toBe('https://example.com/');
    });

    test('shouldBlockExpoDevWebSocket blocks Expo dev sockets for the same tab host only', () => {
        expect(
            shouldBlockExpoDevWebSocket({
                disabled: true,
                socketUrl: 'ws://example.com/hot',
                pageUrl: new URL('https://example.com/app'),
            })
        ).toBe(true);

        expect(
            shouldBlockExpoDevWebSocket({
                disabled: true,
                socketUrl: 'wss://example.com/message',
                pageUrl: new URL('https://example.com/app'),
            })
        ).toBe(true);

        expect(
            shouldBlockExpoDevWebSocket({
                disabled: true,
                socketUrl: 'ws://api.example.com/message',
                pageUrl: new URL('https://example.com/app'),
            })
        ).toBe(false);

        expect(
            shouldBlockExpoDevWebSocket({
                disabled: true,
                socketUrl: 'ws://example.com/socket.io',
                pageUrl: new URL('https://example.com/app'),
            })
        ).toBe(false);

        expect(
            shouldBlockExpoDevWebSocket({
                disabled: false,
                socketUrl: 'ws://example.com/hot',
                pageUrl: new URL('https://example.com/app'),
            })
        ).toBe(false);
    });

    test('installWebHmrOptOutWebSocketGuard blocks later Expo socket creation after in-app navigation', () => {
        const store = new Map<string, string>([['happier.web.hmrOptOut', 'disabled']]);
        const sessionStorage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        };

        class FakeWebSocket {
            static instances: string[] = [];
            constructor(public url: string | URL, _protocols?: string | string[]) {
                FakeWebSocket.instances.push(String(url));
            }
        }

        const globalTarget = {
            WebSocket: FakeWebSocket,
        };

        installWebHmrOptOutWebSocketGuard({
            pageUrl: new URL('https://example.com/app'),
            sessionStorage,
            globalTarget,
        });

        const PatchedWebSocket = globalTarget.WebSocket as unknown as new (url: string) => unknown;
        new PatchedWebSocket('ws://example.com/hot');
        new PatchedWebSocket('ws://example.com/socket.io');

        expect(FakeWebSocket.instances).toEqual(['ws://example.com/socket.io']);
    });

    test('installWebHmrOptOutWebSocketGuard uses a silent open WebSocket stub to avoid reload loops', async () => {
        const store = new Map<string, string>([['happier.web.hmrOptOut', 'disabled']]);
        const sessionStorage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        };

        class FakeWebSocket {
            static instances: string[] = [];
            static OPEN = 1;
            static CLOSED = 3;
            constructor(public url: string | URL, _protocols?: string | string[]) {
                FakeWebSocket.instances.push(String(url));
            }
        }

        const globalTarget = {
            WebSocket: FakeWebSocket,
        };

        installWebHmrOptOutWebSocketGuard({
            pageUrl: new URL('https://example.com/app'),
            sessionStorage,
            globalTarget,
        });

        const PatchedWebSocket = globalTarget.WebSocket as unknown as new (url: string) => any;
        const blocked = new PatchedWebSocket('ws://example.com/hot');

        const onOpen = vi.fn();
        const onError = vi.fn();
        const onClose = vi.fn();

        blocked.onopen = onOpen;
        blocked.onerror = onError;
        blocked.onclose = onClose;

        await new Promise<void>((resolve) => queueMicrotask(resolve));

        expect(onOpen).toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(typeof blocked.send).toBe('function');
        expect(typeof blocked.close).toBe('function');
        expect(blocked.readyState).toBe(FakeWebSocket.OPEN);
    });

    test('installWebHmrOptOutForWebTab disables via happier_hmr=0 and persists per-tab state', () => {
        const store = new Map<string, string>();
        const sessionStorage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        };

        const replaced: string[] = [];
        const history = {
            replaceState: (_s: unknown, _t: string, nextUrl?: string | URL | null) => {
                if (typeof nextUrl === 'string') replaced.push(nextUrl);
                else if (nextUrl instanceof URL) replaced.push(nextUrl.toString());
                else replaced.push('');
            },
        };

        const disabled = installWebHmrOptOutForWebTab({
            url: new URL('https://example.com/new?happier_hmr=0&x=1'),
            sessionStorage,
            history,
        });
        expect(disabled).toBe(true);
        expect(globalThis.__HAPPIER_WEB_HMR_OPT_OUT__).toBe(true);
        expect(store.get('happier.web.hmrOptOut')).toBe('disabled');
        expect(replaced.at(-1)).toBe('https://example.com/new?x=1');
    });

    test('installWebHmrOptOutForWebTab still disables when history.replaceState throws', () => {
        const store = new Map<string, string>();
        const sessionStorage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        };

        const history = {
            replaceState: () => {
                throw new Error('replaceState failed');
            },
        };

        class FakeWebSocket {
            static instances: string[] = [];
            constructor(public url: string | URL, _protocols?: string | string[]) {
                FakeWebSocket.instances.push(String(url));
            }
        }

        const originalWebSocket = (globalThis as any).WebSocket;
        try {
            (globalThis as any).WebSocket = FakeWebSocket;

            const disabled = installWebHmrOptOutForWebTab({
                url: new URL('https://example.com/new?happier_hmr=0&x=1'),
                sessionStorage,
                history,
            });

            expect(disabled).toBe(true);
            expect(globalThis.__HAPPIER_WEB_HMR_OPT_OUT__).toBe(true);
            expect(store.get('happier.web.hmrOptOut')).toBe('disabled');
            expect(!!globalThis.__HAPPIER_WEB_HMR_OPT_OUT_WEBSOCKET_GUARD__).toBe(true);
        } finally {
            (globalThis as any).WebSocket = originalWebSocket;
        }
    });

    test('installWebHmrOptOutForCurrentWebTab disables via happier_hmr=0 before Expo runtime initializes', () => {
        const store = new Map<string, string>();
        const sessionStorage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        };

        const replaced: string[] = [];
        const history = {
            replaceState: (_s: unknown, _t: string, nextUrl?: string | URL | null) => {
                if (typeof nextUrl === 'string') replaced.push(nextUrl);
                else if (nextUrl instanceof URL) replaced.push(nextUrl.toString());
                else replaced.push('');
            },
        };

        const originalWindow = (globalThis as any).window;
        try {
            // Vitest runs in node; we intentionally stub `window` for this test.
            (globalThis as any).window = {
                location: { href: 'https://example.com/new?happier_hmr=0&x=1' },
                sessionStorage,
                history,
            };

            const disabled = installWebHmrOptOutForCurrentWebTab();
            expect(disabled).toBe(true);
            expect(globalThis.__HAPPIER_WEB_HMR_OPT_OUT__).toBe(true);
            expect(store.get('happier.web.hmrOptOut')).toBe('disabled');
            expect(replaced.at(-1)).toBe('https://example.com/new?x=1');
        } finally {
            (globalThis as any).window = originalWindow;
        }
    });
});
