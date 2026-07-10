import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';

import {
    garbageCollectFailedSessionMediaCommit,
    persistSessionMediaForTranscript,
    type SessionMediaBridgeInput,
    type SessionMediaBridgePersistResult,
} from './sessionMediaBridge';

const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==',
    'base64',
);

type BridgeInputWithPolicy = SessionMediaBridgeInput & Readonly<{
    accessPolicy?: FilesystemAccessPolicy;
    sourceAccessPolicy?: FilesystemAccessPolicy;
}>;

async function createWorkspace(): Promise<string> {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-bridge-'));
    await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
    return await realpath(workingDirectory);
}

function extractMediaMeta(meta: Record<string, unknown>): {
    media: readonly unknown[];
    failures?: readonly unknown[];
} {
    const envelope = meta.happier && (meta.happier as { kind?: unknown }).kind === 'session_media.v1'
        ? meta.happier
        : meta.happierMedia;
    expect(envelope).toMatchObject({ kind: 'session_media.v1' });
    const payload = (envelope as { payload?: unknown }).payload;
    expect(payload).toMatchObject({ media: expect.any(Array) });
    return payload as { media: readonly unknown[]; failures?: readonly unknown[] };
}

describe('session media bridge', () => {
    it('uses the primary Happier metadata slot when no other primary envelope owns the row', async () => {
        const result = await persistSessionMediaForTranscript({
            sessionId: 'session-1',
            workingDirectory: null,
            request: {
                localId: 'message-1',
                role: 'output',
                category: 'generated',
                media: [
                    {
                        source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
                        origin: { source: 'provider-generated' },
                    },
                ],
            },
        });

        expect(result.meta.happier).toMatchObject({ kind: 'session_media.v1' });
        expect(result.meta.happierMedia).toBeUndefined();
    });

    it('uses the secondary media slot when a primary Happier envelope already owns the row', async () => {
        const primaryEnvelope = {
            kind: 'stream_state.v1',
            payload: { stable: true },
        };

        const result = await persistSessionMediaForTranscript({
            sessionId: 'session-1',
            workingDirectory: null,
            request: {
                localId: 'message-1',
                role: 'output',
                category: 'generated',
                meta: {
                    happier: primaryEnvelope,
                },
                media: [
                    {
                        source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
                        origin: { source: 'provider-generated' },
                    },
                ],
            },
        });

        expect(result.meta.happier).toEqual(primaryEnvelope);
        expect(result.meta.happierMedia).toMatchObject({ kind: 'session_media.v1' });
    });

    it('rejects provider local-file and local-uri sources unless they carry a restricted-roots policy', async () => {
        const workingDirectory = await createWorkspace();
        const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-provider-media-'));

        try {
            const providerRoot = await realpath(providerDirectory);
            const fileSourcePath = join(providerRoot, 'generated-file.png');
            const uriSourcePath = join(providerRoot, 'generated-uri.png');
            await writeFile(fileSourcePath, pngBytes);
            await writeFile(uriSourcePath, pngBytes);

            const result = await persistSessionMediaForTranscript({
                sessionId: 'session-1',
                workingDirectory,
                request: {
                    localId: 'message-1',
                    role: 'output',
                    category: 'generated',
                    media: [
                        {
                            source: {
                                kind: 'local-file',
                                path: fileSourcePath,
                                mimeType: 'image/png',
                                fileNameHint: 'generated-file.png',
                            },
                            origin: { source: 'provider-generated' },
                        },
                        {
                            source: {
                                kind: 'local-uri',
                                uri: pathToFileURL(uriSourcePath).href,
                                mimeType: 'image/png',
                                fileNameHint: 'generated-uri.png',
                            },
                            origin: { source: 'provider-generated' },
                            sourceAccessPolicy: { kind: 'osUser' },
                        } satisfies BridgeInputWithPolicy,
                    ],
                },
            });

            expect(result.items).toEqual([]);
            expect(result.failures).toHaveLength(2);
            expect(result.failures.map((failure) => failure.code)).toEqual([
                'scoped_media_access_policy_required',
                'scoped_media_access_policy_required',
            ]);
            const payload = extractMediaMeta(result.meta);
            expect(payload.media).toEqual([]);
            expect(payload.failures).toHaveLength(2);
            expect(JSON.stringify(result.meta)).not.toContain(providerRoot);
            expect(JSON.stringify(result.meta)).not.toContain('file://');
        } finally {
            await rm(workingDirectory, { recursive: true, force: true });
            await rm(providerDirectory, { recursive: true, force: true });
        }
    });

    it('persists provider local-file and local-uri sources with a restricted-roots policy without durable inline source data', async () => {
        const workingDirectory = await createWorkspace();
        const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-provider-media-'));

        try {
            const providerRoot = await realpath(providerDirectory);
            const fileSourcePath = join(providerRoot, 'generated-file.png');
            const uriSourcePath = join(providerRoot, 'generated-uri.png');
            await writeFile(fileSourcePath, pngBytes);
            await writeFile(uriSourcePath, pngBytes);
            const sourceAccessPolicy: FilesystemAccessPolicy = {
                kind: 'restrictedRoots',
                roots: [providerRoot],
            };
            const media: readonly BridgeInputWithPolicy[] = [
                {
                    source: {
                        kind: 'local-file',
                        path: fileSourcePath,
                        mimeType: 'image/png',
                        fileNameHint: 'generated-file.png',
                    },
                    origin: { source: 'provider-generated', agentEventId: 'event-file' },
                    sourceAccessPolicy,
                },
                {
                    source: {
                        kind: 'local-uri',
                        uri: pathToFileURL(uriSourcePath).href,
                        mimeType: 'image/png',
                        fileNameHint: 'generated-uri.png',
                    },
                    origin: { source: 'provider-generated', agentEventId: 'event-uri' },
                    sourceAccessPolicy,
                },
            ];

            const result = await persistSessionMediaForTranscript({
                sessionId: 'session-1',
                workingDirectory,
                request: {
                    localId: 'message-1',
                    role: 'output',
                    category: 'generated',
                    media,
                },
            });

            expect(result.failures).toEqual([]);
            expect(result.items).toHaveLength(2);
            for (const item of result.items) {
                expect(item.path).toMatch(/^\.happier\/uploads\/generated\/session-1\/message-1\//);
                await expect(readFile(resolve(workingDirectory, item.path))).resolves.toEqual(pngBytes);
            }
            const serializedMeta = JSON.stringify(result.meta);
            expect(serializedMeta).not.toContain(pngBytes.toString('base64'));
            expect(serializedMeta).not.toContain(providerRoot);
            expect(serializedMeta).not.toContain('file://');
        } finally {
            await rm(workingDirectory, { recursive: true, force: true });
            await rm(providerDirectory, { recursive: true, force: true });
        }
    });

    it('persists provider local-file sources with a source-only restricted-roots policy', async () => {
        const workingDirectory = await createWorkspace();
        const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-provider-media-'));

        try {
            const providerRoot = await realpath(providerDirectory);
            const fileSourcePath = join(providerRoot, 'generated-file.png');
            await writeFile(fileSourcePath, pngBytes);

            const sourceAccessPolicy: FilesystemAccessPolicy = {
                kind: 'restrictedRoots',
                roots: [providerRoot],
            };

            const result = await persistSessionMediaForTranscript({
                sessionId: 'session-1',
                workingDirectory,
                request: {
                    localId: 'message-1',
                    role: 'output',
                    category: 'generated',
                    media: [
                        {
                            source: {
                                kind: 'local-file',
                                path: fileSourcePath,
                                mimeType: 'image/png',
                                fileNameHint: 'generated-file.png',
                            },
                            origin: { source: 'provider-generated', agentEventId: 'event-file' },
                            sourceAccessPolicy,
                        } satisfies BridgeInputWithPolicy,
                    ],
                },
            });

            expect(result.failures).toEqual([]);
            expect(result.items).toHaveLength(1);
            const item = result.items[0]!;
            expect(item.path).toMatch(/^\.happier\/uploads\/generated\/session-1\/message-1\//);
            await expect(readFile(resolve(workingDirectory, item.path))).resolves.toEqual(pngBytes);
            const serializedMeta = JSON.stringify(result.meta);
            expect(serializedMeta).not.toContain(providerRoot);
        } finally {
            await rm(workingDirectory, { recursive: true, force: true });
            await rm(providerDirectory, { recursive: true, force: true });
        }
    });

    it('garbage-collects newly created paths after a failed durable media commit', async () => {
        const workingDirectory = await createWorkspace();
        const existingReferencedPath = '.happier/uploads/generated/session-1/existing-row/referenced.png';

        try {
            await mkdir(dirname(resolve(workingDirectory, existingReferencedPath)), { recursive: true });
            await writeFile(resolve(workingDirectory, existingReferencedPath), pngBytes);

            const persisted = await persistSessionMediaForTranscript({
                sessionId: 'session-1',
                workingDirectory,
                request: {
                    localId: 'rejected-row',
                    role: 'output',
                    category: 'generated',
                    media: [{
                        source: {
                            kind: 'base64',
                            data: pngBytes.toString('base64'),
                            mimeType: 'image/png',
                            fileNameHint: 'generated.png',
                        },
                        origin: { source: 'provider-generated' },
                    }],
                },
            });

            expect(persisted.createdWorkspaceRelativePaths).toHaveLength(1);
            const createdPath = persisted.createdWorkspaceRelativePaths[0]!;

            await garbageCollectFailedSessionMediaCommit({ workingDirectory, persisted });

            await expect(stat(resolve(workingDirectory, createdPath))).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(readFile(resolve(workingDirectory, existingReferencedPath))).resolves.toEqual(pngBytes);
        } finally {
            await rm(workingDirectory, { recursive: true, force: true });
        }
    });

    it('does not propagate failed durable media commit cleanup errors', async () => {
        const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-gc-unreadable-'));
        const nonDirectory = join(workingDirectory, 'not-a-directory');
        const logger = { debug: vi.fn() };
        const persisted: SessionMediaBridgePersistResult = {
            success: true,
            items: [],
            createdWorkspaceRelativePaths: ['.happier/uploads/generated/session-1/rejected-row/generated.png'],
            failures: [],
            meta: {},
        };

        try {
            await writeFile(nonDirectory, 'not a directory');

            await expect(garbageCollectFailedSessionMediaCommit({
                workingDirectory: nonDirectory,
                persisted,
                logger,
            })).resolves.toBeNull();
            expect(logger.debug).toHaveBeenCalledOnce();
        } finally {
            await rm(workingDirectory, { recursive: true, force: true });
        }
    });

    it('garbage-collects newly created paths when ingestion is interrupted after a partial write', async () => {
        const workingDirectory = await createWorkspace();
        const existingReferencedPath = '.happier/uploads/generated/session-1/existing-row/referenced.png';
        const writtenHashPrefix = createHash('sha256').update(pngBytes).digest('hex').slice(0, 12);
        const interruptedCreatedPath = `.happier/uploads/generated/session-1/interrupted-row/${writtenHashPrefix}-generated.png`;
        const abortError = new Error('ingestion aborted');

        try {
            await mkdir(dirname(resolve(workingDirectory, existingReferencedPath)), { recursive: true });
            await writeFile(resolve(workingDirectory, existingReferencedPath), pngBytes);

            await expect(persistSessionMediaForTranscript({
                sessionId: 'session-1',
                workingDirectory,
                providerFileDownloader: async () => {
                    throw abortError;
                },
                request: {
                    localId: 'interrupted-row',
                    role: 'output',
                    category: 'generated',
                    media: [
                        {
                            source: {
                                kind: 'base64',
                                data: pngBytes.toString('base64'),
                                mimeType: 'image/png',
                                fileNameHint: 'generated.png',
                            },
                            origin: { source: 'provider-generated' },
                        },
                        {
                            source: {
                                kind: 'provider-file',
                                providerFileId: 'provider-file-after-partial-write',
                                mimeType: 'image/png',
                                fileNameHint: 'provider.png',
                            },
                            origin: { source: 'provider-generated' },
                        },
                    ],
                },
            })).rejects.toBe(abortError);

            await expect(stat(resolve(workingDirectory, interruptedCreatedPath))).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(readFile(resolve(workingDirectory, existingReferencedPath))).resolves.toEqual(pngBytes);
        } finally {
            await rm(workingDirectory, { recursive: true, force: true });
        }
    });

    it('rethrows the interrupted ingestion error when cleanup logging fails', async () => {
        const workingDirectory = await createWorkspace();
        const abortError = new Error('ingestion aborted');
        const logger = {
            debug: () => {
                throw new Error('logger failed');
            },
        };

        try {
            await expect(persistSessionMediaForTranscript({
                sessionId: 'session-1',
                workingDirectory,
                logger,
                providerFileDownloader: async () => {
                    await rm(workingDirectory, { recursive: true, force: true });
                    await writeFile(workingDirectory, 'not a directory');
                    throw abortError;
                },
                request: {
                    localId: 'interrupted-row',
                    role: 'output',
                    category: 'generated',
                    media: [
                        {
                            source: {
                                kind: 'base64',
                                data: pngBytes.toString('base64'),
                                mimeType: 'image/png',
                                fileNameHint: 'generated.png',
                            },
                            origin: { source: 'provider-generated' },
                        },
                        {
                            source: {
                                kind: 'provider-file',
                                providerFileId: 'provider-file-after-partial-write',
                                mimeType: 'image/png',
                                fileNameHint: 'provider.png',
                            },
                            origin: { source: 'provider-generated' },
                        },
                    ],
                },
            })).rejects.toBe(abortError);
        } finally {
            await rm(workingDirectory, { recursive: true, force: true });
        }
    });

    it('rejects provider local-file sources outside the source restricted-roots policy', async () => {
        const workingDirectory = await createWorkspace();
        const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-provider-media-'));
        const outsideDirectory = await mkdtemp(join(tmpdir(), 'happier-outside-provider-media-'));

        try {
            const providerRoot = await realpath(providerDirectory);
            const outsideRoot = await realpath(outsideDirectory);
            const fileSourcePath = join(outsideRoot, 'generated-file.png');
            await writeFile(fileSourcePath, pngBytes);

            const sourceAccessPolicy: FilesystemAccessPolicy = {
                kind: 'restrictedRoots',
                roots: [providerRoot],
            };

            const result = await persistSessionMediaForTranscript({
                sessionId: 'session-1',
                workingDirectory,
                request: {
                    localId: 'message-1',
                    role: 'output',
                    category: 'generated',
                    media: [
                        {
                            source: {
                                kind: 'local-file',
                                path: fileSourcePath,
                                mimeType: 'image/png',
                                fileNameHint: 'generated-file.png',
                            },
                            origin: { source: 'provider-generated', agentEventId: 'event-file' },
                            sourceAccessPolicy,
                        } satisfies BridgeInputWithPolicy,
                    ],
                },
            });

            expect(result.items).toEqual([]);
            expect(result.failures).toHaveLength(1);
            expect(result.failures[0]).toMatchObject({
                code: 'unauthorized_source_path',
                name: 'generated-file.png',
                origin: { source: 'provider-generated', agentEventId: 'event-file' },
            });
            expect(JSON.stringify(result.meta)).not.toContain(outsideRoot);
        } finally {
            await rm(workingDirectory, { recursive: true, force: true });
            await rm(providerDirectory, { recursive: true, force: true });
            await rm(outsideDirectory, { recursive: true, force: true });
        }
    });

    it('uses generic failure names for unsafe data-uri, url, path, and oversized candidates', async () => {
        const inlineDataUri = `data:image/png;base64,${pngBytes.toString('base64')}`;
        const providerUrl = `https://provider.example/generated.png?token=${'x'.repeat(48)}`;
        const oversizedName = `${'a'.repeat(256)}.png`;
        const shortBase64Name = 'aW1hZ2VCeXRlcw==';
        const shortBase64UrlName = 'aW1hZ2VCeXRlcw';

        const result = await persistSessionMediaForTranscript({
            sessionId: 'session-1',
            workingDirectory: null,
            request: {
                localId: 'message-1',
                role: 'output',
                category: 'generated',
                media: [
                    {
                        source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
                        suggestedName: inlineDataUri,
                        origin: { source: 'provider-generated' },
                    },
                    {
                        source: {
                            kind: 'base64',
                            data: pngBytes.toString('base64'),
                            mimeType: 'image/png',
                            fileNameHint: inlineDataUri,
                        },
                        origin: { source: 'provider-generated' },
                    },
                    {
                        source: { kind: 'local-uri', uri: inlineDataUri, mimeType: 'image/png' },
                        origin: { source: 'provider-generated' },
                    },
                    {
                        source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
                        suggestedName: providerUrl,
                        origin: { source: 'provider-generated' },
                    },
                    {
                        source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
                        suggestedName: oversizedName,
                        origin: { source: 'provider-generated' },
                    },
                    {
                        source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
                        suggestedName: shortBase64Name,
                        origin: { source: 'provider-generated' },
                    },
                    {
                        source: {
                            kind: 'base64',
                            data: pngBytes.toString('base64'),
                            mimeType: 'image/png',
                            fileNameHint: shortBase64UrlName,
                        },
                        origin: { source: 'provider-generated' },
                    },
                ],
            },
        });

        expect(result.failures.map((failure) => failure.name)).toEqual([
            'image-1',
            'image-2',
            'image-3',
            'image-4',
            'image-5',
            'image-6',
            'image-7',
        ]);
        const serializedMeta = JSON.stringify(result.meta);
        expect(serializedMeta).not.toContain('data:image');
        expect(serializedMeta).not.toContain(pngBytes.toString('base64'));
        expect(serializedMeta).not.toContain('provider.example');
        expect(serializedMeta).not.toContain(oversizedName);
        expect(serializedMeta).not.toContain(shortBase64Name);
        expect(serializedMeta).not.toContain(shortBase64UrlName);
    });

    it('strips provider prompt metadata before durable transcript metadata is written', async () => {
        const result = await persistSessionMediaForTranscript({
            sessionId: 'session-1',
            workingDirectory: null,
            request: {
                localId: 'message-1',
                role: 'output',
                category: 'generated',
                meta: {
                    prompt: 'draw a private diagram',
                    codexImageGenerationV1: {
                        revisedPrompt: 'sanitized provider prompt',
                    },
                    nested: {
                        revised_prompt: 'alternate provider prompt',
                    },
                },
                media: [
                    {
                        source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
                        origin: { source: 'provider-generated' },
                    },
                ],
            },
        });

        const serializedMeta = JSON.stringify(result.meta);
        expect(serializedMeta).not.toContain('draw a private diagram');
        expect(serializedMeta).not.toContain('sanitized provider prompt');
        expect(serializedMeta).not.toContain('alternate provider prompt');
        expect(serializedMeta).not.toContain('revisedPrompt');
        expect(serializedMeta).not.toContain('revised_prompt');
    });

    it('strips provider-local paths and raw byte-like values from passthrough metadata', async () => {
        const result = await persistSessionMediaForTranscript({
            sessionId: 'session-1',
            workingDirectory: null,
            request: {
                localId: 'message-1',
                role: 'output',
                category: 'generated',
                meta: {
                    safe: { keep: 'diagnostic-id' },
                    diagnostics: {
                        generatedPath: '$CODEX_HOME/generated/private.png',
                        rawBytes: pngBytes.toString('base64'),
                    },
                },
                media: [
                    {
                        source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
                        origin: { source: 'provider-generated' },
                    },
                ],
            },
        });

        const serializedMeta = JSON.stringify(result.meta);
        expect(serializedMeta).toContain('diagnostic-id');
        expect(serializedMeta).not.toContain('$CODEX_HOME');
        expect(serializedMeta).not.toContain(pngBytes.toString('base64'));
    });

    it('omits unsafe provider-controlled origin identifiers from durable metadata', async () => {
        const result = await persistSessionMediaForTranscript({
            sessionId: 'session-1',
            workingDirectory: null,
            request: {
                localId: 'message-1',
                role: 'output',
                category: 'generated',
                media: [
                    {
                        source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
                        origin: {
                            source: 'acp-content',
                            agentId: 'agent-safe',
                            agentEventId: 'https://provider.example/events/secret-token',
                            providerFileId: 'aW1hZ2VCeXRlcw==',
                            generationId: '/tmp/provider/generated.png',
                        },
                    },
                ],
            },
        });

        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]?.origin).toEqual({
            source: 'acp-content',
            agentId: 'agent-safe',
        });
        const serializedMeta = JSON.stringify(result.meta);
        expect(serializedMeta).not.toContain('provider.example');
        expect(serializedMeta).not.toContain('aW1hZ2VCeXRlcw');
        expect(serializedMeta).not.toContain('/tmp/provider');
    });
});
