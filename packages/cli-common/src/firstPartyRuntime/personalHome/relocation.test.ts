import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { relocatePersonalHome } from './relocation.js';

describe('Personal Home relocation owner', () => {
    it('transfers a verified bundle, verifies destination, publishes once, and keeps source stopped', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-relocate-'));
        const source = join(root, 'source');
        const destination = join(root, 'destination');
        const bundle = join(root, 'home.tar');
        const events: string[] = [];
        await writeFile(bundle, 'bundle-bytes');
        const publish = vi.fn(async () => { events.push('publish'); });
        const result = await relocatePersonalHome({
            source: { dataDir: source, homeServerIdentityId: 'srv_same' },
            destination: { dataDir: destination },
            createFinalBackup: async () => ({ path: bundle, sha256: 'a'.repeat(64), manifest: {} as never }),
            prepareDestination: async () => { events.push('prepare'); },
            stopSource: async () => { events.push('stop'); },
            transfer: {
                send: async ({ sourcePath }) => ({ receivedPath: sourcePath, bytes: 12, sha256: 'a'.repeat(64) }),
            },
            restoreDestination: async () => { events.push('restore'); },
            verifyDestination: async () => { events.push('verify'); return { homeServerIdentityId: 'srv_same' }; },
            startDestination: async () => { events.push('start-destination'); },
            commitSameHomeRelocation: publish,
            destinationDescriptor: { url: 'http://127.0.0.1:43123' },
        });

        expect(result).toMatchObject({ homeServerIdentityId: 'srv_same', destinationVerified: true, sourceStopped: true, followerAction: 'reconnect' });
        expect(events).toEqual(['prepare', 'stop', 'restore', 'verify', 'start-destination', 'publish']);
        expect(publish).toHaveBeenCalledWith({ homeId: 'srv_same', newConnectionDescriptor: { url: 'http://127.0.0.1:43123' } });
        await expect(stat(join(source, '.operations', 'relocation.json'))).resolves.toBeTruthy();
    });

    it('keeps both homes stopped and marks publication pending when the callback fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-relocate-pending-'));
        const events: string[] = [];
        await writeFile(join(root, 'home.tar'), 'bundle-bytes');
        await expect(relocatePersonalHome({
            source: { dataDir: join(root, 'source'), homeServerIdentityId: 'srv_same' },
            destination: { dataDir: join(root, 'destination') },
            createFinalBackup: async () => ({ path: join(root, 'home.tar'), sha256: 'b'.repeat(64), manifest: {} as never }),
            prepareDestination: async () => {},
            stopSource: async () => { events.push('stop'); },
            transfer: { send: async () => ({ receivedPath: join(root, 'received.tar'), bytes: 12, sha256: 'b'.repeat(64) }) },
            restoreDestination: async () => {},
            verifyDestination: async () => ({ homeServerIdentityId: 'srv_same' }),
            startDestination: async () => { events.push('start-destination'); },
            stopDestination: async () => { events.push('stop-destination'); },
            commitSameHomeRelocation: async () => { throw new Error('offline'); },
            destinationDescriptor: { url: 'http://127.0.0.1:43123' },
        })).rejects.toThrow('offline');
        expect(events).toEqual(['stop', 'start-destination', 'stop-destination']);
    });
});
