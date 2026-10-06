import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { Modal } from '@/modal';
import { encodeBase64 } from '@/encryption/base64';
import { hashArtifactBinaryContent, openArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import { fetchArtifactBlob } from '@/sync/api/artifacts/apiArtifacts';
import type { ArtifactBlobReferenceV1 } from '@happier-dev/protocol';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock();
});

import { ArtifactBinaryBody } from './ArtifactBinaryBody';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

function binarySource(mime: string, bytes = new Uint8Array([0, 255, 128])) {
    const reference: ArtifactBlobReferenceV1 = { blobId: 'b6a4bb92-8b93-4b18-b8b4-230041388a62', mime,
        sizeBytes: bytes.length, sha256: hashArtifactBinaryContent(bytes) };
    // Only captured HTTP is substituted; the actual API mode/schema and binary opening owners run.
    const request = vi.fn(async () => new Response(JSON.stringify({ blobId: reference.blobId,
        content: { t: 'plain', v: encodeBase64(bytes) } })));
    const readBytes = async (artifactId: string, ref: ArtifactBlobReferenceV1, signal?: AbortSignal) => {
        const stored = await fetchArtifactBlob({ token: 'token' }, artifactId, ref.blobId, 'plain', { request, signal });
        return openArtifactBinaryContent({ reference: ref, content: stored.content, mode: 'plain', encryption: null });
    };
    return { reference, bytes, request, readBytes };
}

describe('ArtifactBinaryBody', () => {
    it.each([
        ['android', 'success'], ['android', 'failure'], ['ios', 'success'], ['ios', 'failure'],
    ] as const)('preserves PDF download custody through %s sharing %s', async (platform, outcome) => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        const source = binarySource('application/pdf');
        const { createExpoFileSystemFileMock } = await import('@/dev/testkit/mocks/expoFileSystem');
        const filesystem = createExpoFileSystemFileMock();
        const files = filesystem.files;
        const androidShares: string[] = [];
        const iosShares: string[] = [];
        // Only Expo filesystem/native SDK boundaries are substituted; artifact HTTP/schema,
        // content validation, cache lifetime and the sharing adapters remain real.
        vi.doMock('expo-file-system', () => filesystem.module);
        vi.doMock('expo-sharing', () => ({ isAvailableAsync: async () => true,
            shareAsync: async (uri: string) => {
                iosShares.push(uri);
                expect(files.get(uri)).toEqual([...source.bytes]);
                if (outcome === 'failure') throw new Error('Share sheet failed');
            } }));
        vi.doMock('expo-modules-core', async importOriginal => ({
            ...await importOriginal<typeof import('expo-modules-core')>(),
            requireOptionalNativeModule: (name: string) => name === 'HappierFileActions' ? {
                shareFile: async (uri: string, name: string, mimeType?: string) => {
                    androidShares.push(uri);
                    expect(name).toBe('Quarterly report');
                    expect(mimeType).toBe('application/pdf');
                    expect(files.get(uri)).toEqual([...source.bytes]);
                    if (outcome === 'failure') throw new Error('Share chooser failed');
                },
            } : null,
        }));
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="pdf" name="Quarterly report" {...source} />);
            expect(source.request).not.toHaveBeenCalled();
            expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
            await screen.pressByTestIdAsync('artifact:download');
            await act(async () => { await vi.waitFor(() => expect(androidShares.length + iosShares.length).toBe(1)); });
            const shared = platform === 'android' ? androidShares : iosShares;
            if (platform === 'android' && outcome === 'success') expect([...files.values()]).toEqual([[...source.bytes]]);
            expect(shared).toHaveLength(1);
            if (platform === 'android') expect(shared[0]).toMatch(/^file:\/\/\/cache\/happier-downloads\/.*Quarterly report$/);
            if (platform === 'android') expect(iosShares).toEqual([]);
            else expect(androidShares).toEqual([]);
            if (platform === 'android' && outcome === 'success') expect(files.get(shared[0]!)).toEqual([...source.bytes]);
            else expect(files.size).toBe(0);
            expect(screen.findByTestId('artifact:downloadFailed') !== null).toBe(outcome === 'failure');
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: previous });
            vi.doUnmock('expo-file-system'); vi.doUnmock('expo-sharing'); vi.doUnmock('expo-modules-core');
        }
    });

    it('cancels an old selection download and leaves the next file actionable', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const first = binarySource('application/zip');
        const pending = createDeferred<Response>();
        first.request.mockImplementation(() => pending.promise);
        const next = binarySource('text/html');
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:next');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const anchor = { href: '', download: '', rel: '', style: {}, click: vi.fn(), remove: vi.fn() };
        vi.stubGlobal('document', {
            createElement: (tag: string) => tag === 'a' ? anchor : { id: '', textContent: '' },
            getElementById: () => null,
            head: { appendChild: () => {} },
            body: { appendChild: () => {} },
        });
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="first" name="first.zip" {...first} />);
            await screen.pressByTestIdAsync('artifact:download');
            await screen.update(<ArtifactBinaryBody artifactId="next" name="next.html" {...next} />);
            await screen.pressByTestIdAsync('artifact:download');
            await flushHookEffects();
            expect(anchor.download).toBe('next.html');
            expect(anchor.click).toHaveBeenCalledOnce();
            pending.resolve(new Response(JSON.stringify({ blobId: first.reference.blobId, content: { t: 'plain', v: encodeBase64(first.bytes) } })));
            await flushHookEffects();
            expect(anchor.download).toBe('next.html');
            expect(anchor.click).toHaveBeenCalledOnce();
        } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
    });

    it('shows private image bytes and releases the temporary preview on unmount', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const source = binarySource('image/png');
        const urls: Blob[] = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
            if (!(blob instanceof Blob)) throw new Error('Expected binary preview Blob');
            urls.push(blob); return 'blob:private-image';
        });
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="image" name="image.png" {...source} />);
            await flushHookEffects();
            expect(screen.findByTestId('file:imagePreview')).not.toBeNull();
            expect(new Uint8Array(await urls[0]!.arrayBuffer())).toEqual(source.bytes);
            // The modal presentation is the boundary; the real shared image viewer is loaded.
            await import('@/components/sessions/attachments/preview/AttachmentImagePreviewModal');
            const imageButton = screen.tree.root.find(node => typeof node.type === 'string'
                && node.props.accessibilityLabel === 'image.png' && node.props.accessibilityRole === 'button');
            await act(async () => { imageButton.props.onPress(); await Promise.resolve(); });
            await vi.waitFor(() => expect(Modal.show).toHaveBeenCalled());
            imageButton.props.onPress();
            await screen.unmount();
            await flushHookEffects();
            expect(Modal.show).toHaveBeenCalledOnce();
            expect(revoke).toHaveBeenCalledWith('blob:private-image');
            expect(Modal.hide).toHaveBeenCalledWith('modal-id');
        } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
    });

    it('does not fetch or render HTML until explicit Download, and downloads verified bytes', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const source = binarySource('text/html');
        const downloaded: Blob[] = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
            if (!(blob instanceof Blob)) throw new Error('Expected binary download Blob');
            downloaded.push(blob); return 'blob:download';
        });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const anchor = { href: '', download: '', rel: '', style: {}, click: vi.fn(), remove: vi.fn() };
        vi.stubGlobal('document', {
            createElement: (tag: string) => tag === 'a' ? anchor : { id: '', textContent: '' },
            getElementById: () => null,
            head: { appendChild: () => {} },
            body: { appendChild: () => {} },
        });
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="html" name="page.html" {...source} />);
            expect(source.request).not.toHaveBeenCalled();
            expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
            await screen.pressByTestIdAsync('artifact:download');
            await flushHookEffects();
            expect(anchor.download).toBe('page.html');
            expect(anchor.click).toHaveBeenCalledOnce();
            expect(new Uint8Array(await downloaded[0]!.arrayBuffer())).toEqual(source.bytes);
        } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
    });

    it('does not disclose an Account-mode mismatch as a preview or download', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const source = binarySource('image/png');
        source.request.mockImplementation(async () => new Response(JSON.stringify({ blobId: source.reference.blobId,
            content: { t: 'encrypted', c: 'AA==' } })));
        const createUrl = vi.spyOn(URL, 'createObjectURL');
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="image" name="image.png" {...source} />);
            await flushHookEffects();
            expect(screen.findByTestId('artifact:previewFailed')).not.toBeNull();
            await screen.pressByTestIdAsync('artifact:download');
            await flushHookEffects();
            expect(screen.findByTestId('artifact:downloadFailed')).not.toBeNull();
            expect(createUrl).not.toHaveBeenCalled();
        } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
    });
});
