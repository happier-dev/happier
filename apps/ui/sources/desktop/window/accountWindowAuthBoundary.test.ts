import { afterEach, expect, it, vi } from 'vitest';
import { completeDesktopAccountCredentialReplacement } from './accountWindowAuthBoundary';

afterEach(() => { vi.unstubAllGlobals(); });

it('notifies and reveals main after committed replacement when native window retirement partially fails', async () => {
    const failure = new Error('One native window could not close');
    // The OS owns destruction and main-window reveal; all Account decisions stay real.
    const invoke = vi.fn(async (command: string) => {
        if (command === 'desktop_app_windows_teardown') throw failure;
    });
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    const scopes = [{ serverId: 'home-a', accountId: 'outgoing' }];
    const mutation = { kind: 'credentials_set', serverId: 'home-a', serverUrl: 'https://home-a.test' } as const;
    await expect(completeDesktopAccountCredentialReplacement(scopes, mutation)).rejects.toBe(failure);
    expect(invoke.mock.calls).toEqual([
        ['desktop_app_windows_teardown', { scopes }],
        ['desktop_app_windows_auth_changed', { mutations: [mutation] }],
    ]);
});

it('does no native work when the credential owner replaced no scope', async () => {
    const invoke = vi.fn();
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    await completeDesktopAccountCredentialReplacement([], { kind: 'credentials_set', serverId: 'home-a', serverUrl: 'https://home-a.test' });
    expect(invoke).not.toHaveBeenCalled();
});
