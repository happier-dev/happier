import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const osBoundary = vi.hoisted(() => ({ restriction: '1\n', usernsFailed: true }));
vi.mock('node:fs/promises', async importOriginal => ({
    ...await importOriginal<typeof import('node:fs/promises')>(),
    readFile: vi.fn(async () => osBoundary.restriction),
}));
vi.mock('node:child_process', async importOriginal => ({
    ...await importOriginal<typeof import('node:child_process')>(),
    execFile: vi.fn((_command, _args, callback) => callback(osBoundary.usernsFailed ? new Error('EPERM') : null, '', '')),
}));

import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from './launchOwner';
import { managedChromiumAppArmorProfile } from './sandbox';

const originalPlatform = process.platform;
beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'linux' }); });
afterEach(() => { Object.defineProperty(process, 'platform', { value: originalPlatform }); });

describe('managed Chromium sandbox diagnosis', () => {
    it('attaches the exception to exactly the managed executable, not a directory or global policy', () => {
        const path = '/home/browser user/tools/browser-chromium/current/chrome-linux-arm64/chrome';
        const profile = managedChromiumAppArmorProfile(path);
        expect(profile.content).toContain(`"${path}" flags=(unconfined)`);
        expect(profile.content).toContain('userns,');
        expect(profile.content).not.toContain('*');
        expect(managedChromiumAppArmorProfile('/different/chrome').name).not.toBe(profile.name);
        expect(() => managedChromiumAppArmorProfile('/managed/*/chrome')).toThrow();
        expect(() => managedChromiumAppArmorProfile('/managed/{a,b}/chrome')).toThrow();
    });
    it.each([
        ['1\n', true, 'No usable sandbox!', 'sandbox_unavailable'],
        ['0\n', true, 'No usable sandbox!', 'cdp_unavailable'],
        ['1\n', false, 'No usable sandbox!', 'cdp_unavailable'],
        ['1\n', true, 'Unrelated startup error', 'cdp_unavailable'],
    ] as const)('classifies failed launch with AppArmor=%s, failed userns=%s and stderr=%s', async (restriction, usernsFailed, browserStderr, errorCode) => {
        osBoundary.restriction = restriction;
        osBoundary.usernsFailed = usernsFailed;
        const child = new EventEmitter();
        const stderr = new EventEmitter();
        const factory = createBrowserSidecarLaunchOwnerControlAdapterFactory({
            browserSessionId: 'session', sidecarId: 'sidecar',
            profile: { profileId: 'profile', owner: { kind: 'session', id: 'session' }, storageMode: 'ephemeral', cleanupOnSessionClose: true },
            profileDirectory: '/tmp/profile',
            binaryResolution: { ok: true, source: 'managedBrowserPackage', executablePath: '/managed/chrome', discoveryKind: 'managedRuntime', diagnostics: [] },
            spawnProcess: () => {
                queueMicrotask(() => { stderr.emit('data', browserStderr); child.emit('exit', null, 'SIGABRT'); });
                return Object.assign(child, { pid: 42, stderr, stdio: [null, null, null, new PassThrough(), new PassThrough()], kill: () => true });
            },
            cleanupProfileDirectory: () => {},
        });
        const result = await factory({ machineId: 'machine' });
        expect(result).toMatchObject({ ok: false, errorCode });
        if (!result.ok && errorCode === 'sandbox_unavailable') {
            expect(result.disabledReason).toContain('happier browser sandbox install');
        }
    });
});
