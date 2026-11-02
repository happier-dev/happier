import { describe, expect, it, vi } from 'vitest';

import { inspectLocalBrowserWindowHost } from './localWindow';

describe('local managed browser window admission', () => {
    it('refuses an absent display and SSH forwarding before inspecting the desktop', async () => {
        const execute = vi.fn(async () => '');
        expect(await inspectLocalBrowserWindowHost({ platform: 'linux', env: {}, execute }))
            .toEqual({ available: false, reason: 'local_display_unavailable' });
        expect(await inspectLocalBrowserWindowHost({ platform: 'linux', env: { DISPLAY: 'localhost:10.0', SSH_CONNECTION: 'forwarded' }, execute }))
            .toEqual({ available: false, reason: 'daemon_not_in_gui_session' });
        expect(execute).not.toHaveBeenCalled();
    });

    it('admits only the daemon user’s active local graphical login on Linux', async () => {
        const facts = { platform: 'linux', env: { DISPLAY: ':0' }, uid: 1000 };
        const output = 'User=1000\nActive=yes\nRemote=no\nType=x11\nDisplay=:0\n';
        expect(await inspectLocalBrowserWindowHost({ ...facts, execute: async () => output })).toEqual({ available: true });
        for (const invalid of [output.replace('1000', '1001'), output.replace('yes', 'no'), output.replace('Remote=no', 'Remote=yes'), output.replace('x11', 'tty'), output.replace(':0', ':1')]) {
            expect(await inspectLocalBrowserWindowHost({ ...facts, execute: async () => invalid }))
                .toEqual({ available: false, reason: 'daemon_not_in_gui_session' });
        }
        expect(await inspectLocalBrowserWindowHost({ ...facts, execute: async () => { throw new Error('logind unavailable'); } }))
            .toEqual({ available: false, reason: 'gui_session_unverified' });
    });

    it('admits Aqua and interactive Windows desktops, refusing service sessions', async () => {
        expect(await inspectLocalBrowserWindowHost({ platform: 'darwin', env: {}, execute: async () => 'Aqua\n' })).toEqual({ available: true });
        expect(await inspectLocalBrowserWindowHost({ platform: 'darwin', env: {}, execute: async () => 'Background\n' }))
            .toMatchObject({ available: false, reason: 'daemon_not_in_gui_session' });
        expect(await inspectLocalBrowserWindowHost({ platform: 'win32', env: {}, execute: async () => 'True\n' })).toEqual({ available: true });
        expect(await inspectLocalBrowserWindowHost({ platform: 'win32', env: {}, execute: async () => 'False\n' }))
            .toMatchObject({ available: false, reason: 'daemon_not_in_gui_session' });
    });

    it('admits a local Wayland session and settles unsupported platforms without discovery', async () => {
        expect(await inspectLocalBrowserWindowHost({ platform: 'linux', uid: 1000, env: { WAYLAND_DISPLAY: 'wayland-0' },
            execute: async () => 'User=1000\nActive=yes\nRemote=no\nType=wayland\n' })).toEqual({ available: true });
        const execute = vi.fn(async () => '');
        expect(await inspectLocalBrowserWindowHost({ platform: 'freebsd', env: {}, execute }))
            .toEqual({ available: false, reason: 'unsupported_platform' });
        expect(execute).not.toHaveBeenCalled();
    });
});
