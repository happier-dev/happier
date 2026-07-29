import { describe, expect, it, vi } from 'vitest';

import { createSessionMediaScreenshotWriter } from './screenshotMedia';
import type { persistSessionMedia } from '@/session/media/persistSessionMedia';
import type { TransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';

function fakeRegistry(): TransferPathAllowanceRegistry {
    return {
        setAdditionalAllowedReadDirs: vi.fn(),
        setAdditionalAllowedWriteDirs: vi.fn(),
    } as unknown as TransferPathAllowanceRegistry;
}

const INPUT = {
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    navigationGeneration: 3,
    pngBase64: 'QkFTRTY0UE5H',
} as const;

describe('session media screenshot writer', () => {
    it('persists the PNG and returns a protocol media reference with dimensions', async () => {
        let capturedSource: { kind: string; data: string } | null = null;
        const persistMediaMock = vi.fn(async (params: { input: { source: { kind: string; data: string } } }) => {
            capturedSource = params.input.source;
            return ({
            success: true as const,
            created: true,
            item: {
                id: 'media_abc',
                role: 'output' as const,
                category: 'tool-artifact' as const,
                mediaKind: 'image' as const,
                mimeType: 'image/png' as const,
                name: 'shot.png',
                path: '/tmp/x/shot.png',
                sizeBytes: 4096,
                width: 1280,
                height: 720,
                origin: { source: 'tool-output' as const },
            },
        });
        });

        const writer = createSessionMediaScreenshotWriter({
            workingDirectory: '/tmp/x',
            pathAllowanceRegistry: fakeRegistry(),
            resolveTarget: () => ({ sessionId: 'browser_session_1', messageLocalId: 'browser_context_view_1_3' }),
            persistMedia: persistMediaMock as unknown as typeof persistSessionMedia,
        });

        const result = await writer.write(INPUT);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.media).toEqual({
            mediaId: 'media_abc',
            mediaKind: 'image',
            width: 1280,
            height: 720,
            sizeBytes: 4096,
        });
        // base64 source is forwarded, never decoded/logged here.
        expect(capturedSource).toMatchObject({ kind: 'base64', data: 'QkFTRTY0UE5H' });
    });

    it('fails closed when persistence fails', async () => {
        const persistMedia = vi.fn(async () => ({
            success: false as const,
            code: 'media_path_collision',
            error: 'boom',
        })) as unknown as typeof persistSessionMedia;

        const writer = createSessionMediaScreenshotWriter({
            workingDirectory: '/tmp/x',
            pathAllowanceRegistry: fakeRegistry(),
            resolveTarget: () => ({ sessionId: 's', messageLocalId: 'm' }),
            persistMedia,
        });

        const result = await writer.write(INPUT);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('capture_failed');
        expect(result.disabledReason).toBe('media_path_collision');
    });

    it('fails closed when persisted dimensions are unavailable', async () => {
        const persistMedia = vi.fn(async () => ({
            success: true as const,
            created: true,
            item: {
                id: 'media_abc',
                role: 'output' as const,
                category: 'tool-artifact' as const,
                mediaKind: 'image' as const,
                mimeType: 'image/png' as const,
                name: 'shot.png',
                path: '/tmp/x/shot.png',
                sizeBytes: 4096,
                origin: { source: 'tool-output' as const },
            },
        })) as unknown as typeof persistSessionMedia;

        const writer = createSessionMediaScreenshotWriter({
            workingDirectory: '/tmp/x',
            pathAllowanceRegistry: fakeRegistry(),
            resolveTarget: () => ({ sessionId: 's', messageLocalId: 'm' }),
            persistMedia,
        });

        const result = await writer.write(INPUT);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('capture_failed');
    });
});
