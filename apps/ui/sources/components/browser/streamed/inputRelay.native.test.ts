import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAutomationActionResultV1Schema } from '@happier-dev/protocol/browser/automation/v1';
import { encodeBase64 } from '@/encryption/base64';

const native = vi.hoisted(() => ({ files: new Map<string, number[]>(), shared: [] as number[][] }));
vi.mock('react-native', async () => ({
    ...(await (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' })),
    Share: { sharedAction: 'shared', dismissedAction: 'dismissed', share: async ({ url }: { url: string }) => {
        native.shared.push([...native.files.get(url) ?? []]); return { action: 'shared' };
    } },
}));
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => true }));
// The native filesystem and activity sheet are the only substituted boundaries.
vi.mock('expo-file-system', () => {
    class Directory {
        readonly uri: string;
        constructor(parent: string | { uri: string }, name = '') { this.uri = `${typeof parent === 'string' ? parent : parent.uri}/${name}`; }
        create() {}
    }
    class File extends Directory {
        get exists() { return native.files.has(this.uri); }
        create() { native.files.set(this.uri, []); }
        delete() { native.files.delete(this.uri); }
        open() { return { offset: 0, close() {}, writeBytes: (bytes: Uint8Array) => native.files.get(this.uri)?.push(...bytes) }; }
    }
    return { Directory, File, Paths: { cache: 'file:///cache' } };
});

import { createBrowserStreamInputRelay, saveBrowserStreamDownload } from './inputRelay';

describe('native browser download delivery', () => {
    beforeEach(() => { native.files.clear(); native.shared.length = 0; });
    it.each([false, true])('hands off complete bytes and cleans a disconnected partial file (disconnect=%s)', async disconnected => {
        let sequence = 0;
        const bytes = new Uint8Array([0, 255, 128, 13, 10, 42]);
        const relay = createBrowserStreamInputRelay({ streamId: 'viewer', nextSequence: () => sequence++, send: (event, eventId) => {
            if (event.kind !== 'download') throw new Error('unexpected input');
            if (disconnected && event.offset > 0) { queueMicrotask(() => relay.dispose()); return; }
            const chunk = bytes.slice(event.offset, event.offset + 2);
            relay.accept(BrowserAutomationActionResultV1Schema.parse({ v: 1, automationRequestId: eventId, status: 'succeeded',
                durationMs: 1, adapterKind: 'chromiumSidecar', fidelity: 'cdp', trustedInput: true,
                navigationGenerationBefore: 0, navigationGenerationAfter: 0, controlEpochBefore: 1, controlEpochAfter: 1,
                interactionResult: { kind: 'download', downloadId: 'binary', name: 'binary.dat', offset: event.offset,
                    dataBase64: encodeBase64(chunk), eof: event.offset + chunk.length === bytes.length } }));
        } });
        const saving = saveBrowserStreamDownload({ download: { downloadId: 'binary', name: 'binary.dat', state: 'completed', receivedBytes: bytes.length, totalBytes: bytes.length },
            maxFrameBytes: 1024, request: relay.request });
        if (disconnected) await expect(saving).rejects.toThrow('stream_closed');
        else await saving;
        expect(native.shared).toEqual(disconnected ? [] : [Array.from(bytes)]);
        expect(native.files.size).toBe(0);
        relay.dispose();
    });
});
