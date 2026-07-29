import {
    BrowserScreenshotMediaReferenceV1Schema,
    type BrowserScreenshotMediaReferenceV1,
} from '@happier-dev/protocol';

import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { persistSessionMedia } from '@/session/media/persistSessionMedia';
import type { TransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';

export type BrowserContextScreenshotMediaInput = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    /** Raw base64-encoded PNG bytes returned by CDP `Page.captureScreenshot` (no data: prefix). */
    pngBase64: string;
}>;

export type BrowserContextScreenshotMediaResult =
    | Readonly<{ ok: true; media: BrowserScreenshotMediaReferenceV1 }>
    | Readonly<{ ok: false; reason: 'capture_failed'; disabledReason?: string }>;

/**
 * Persists a CDP screenshot into durable session media and returns the protocol media reference.
 * The producer depends only on this seam, so the heavy session-media plumbing (path allowance,
 * working directory, budgets) stays out of the producer and the producer stays unit-testable with
 * an in-memory writer.
 */
export type BrowserContextScreenshotMediaWriter = Readonly<{
    write(input: BrowserContextScreenshotMediaInput): Promise<BrowserContextScreenshotMediaResult>;
}>;

export type BrowserContextSessionMediaTarget = Readonly<{
    sessionId: string;
    messageLocalId: string;
}>;

export type SessionMediaScreenshotWriterOptions = Readonly<{
    workingDirectory: string;
    pathAllowanceRegistry: TransferPathAllowanceRegistry;
    accessPolicy?: FilesystemAccessPolicy;
    /** Maps a captured view to the owning session/message media bucket. */
    resolveTarget(input: Readonly<{
        browserSessionId: string;
        viewId: string;
        navigationGeneration: number;
    }>): BrowserContextSessionMediaTarget;
    now?: () => number;
    persistMedia?: typeof persistSessionMedia;
}>;

/**
 * Production screenshot writer backed by the canonical `persistSessionMedia` owner. Binary-safe:
 * persistence uses managed filesystem helpers only — no system node / package manager is spawned.
 * Fail-closed: any persistence failure surfaces as `capture_failed` (never a partial/unverified
 * media reference).
 */
export function createSessionMediaScreenshotWriter(
    options: SessionMediaScreenshotWriterOptions,
): BrowserContextScreenshotMediaWriter {
    const accessPolicy = options.accessPolicy ?? { kind: 'osUser' as const };
    const persistMedia = options.persistMedia ?? persistSessionMedia;
    const now = options.now ?? (() => Date.now());

    return {
        async write(input) {
            const target = options.resolveTarget(input);
            let persisted: Awaited<ReturnType<typeof persistMedia>>;
            try {
                persisted = await persistMedia({
                    workingDirectory: options.workingDirectory,
                    accessPolicy,
                    sourceAccessPolicy: accessPolicy,
                    pathAllowanceRegistry: options.pathAllowanceRegistry,
                    input: {
                        sessionId: target.sessionId,
                        messageLocalId: target.messageLocalId,
                        role: 'output',
                        category: 'tool-artifact',
                        source: {
                            kind: 'base64',
                            data: input.pngBase64,
                            mimeType: 'image/png',
                            fileNameHint: 'browser-context-screenshot.png',
                        },
                        origin: {
                            source: 'tool-output',
                            toolCallId: `browser_context_${input.viewId}_${input.navigationGeneration}`,
                        },
                        suggestedName: 'browser-context-screenshot.png',
                        createdAtMs: now(),
                    },
                });
            } catch {
                return { ok: false, reason: 'capture_failed' };
            }

            if (!persisted.success) {
                return { ok: false, reason: 'capture_failed', disabledReason: persisted.code };
            }

            const { item } = persisted;
            if (item.mediaKind !== 'image' || item.width === undefined || item.height === undefined) {
                return { ok: false, reason: 'capture_failed', disabledReason: 'screenshot_dimensions_unavailable' };
            }

            return {
                ok: true,
                media: BrowserScreenshotMediaReferenceV1Schema.parse({
                    mediaId: item.id,
                    mediaKind: 'image',
                    width: item.width,
                    height: item.height,
                    sizeBytes: item.sizeBytes,
                }),
            };
        },
    };
}
