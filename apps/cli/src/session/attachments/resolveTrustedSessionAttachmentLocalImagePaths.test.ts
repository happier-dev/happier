import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveTrustedSessionAttachmentLocalImagePaths } from './resolveTrustedSessionAttachmentLocalImagePaths';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happier-trusted-attachments-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sha256(content: string): string {
    return createHash('sha256').update(content).digest('hex');
}

describe('resolveTrustedSessionAttachmentLocalImagePaths', () => {
    it('trusts uploaded local image paths only when the declared file hash matches', async () => {
        const cwd = await createTempDir();
        const uploadPath = '.happier/uploads/messages/message-1/screen.png';
        const content = 'fake image bytes';
        await mkdir(dirname(join(cwd, uploadPath)), { recursive: true });
        await writeFile(join(cwd, uploadPath), content);

        await expect(resolveTrustedSessionAttachmentLocalImagePaths({
            cwd,
            metadata: {
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            {
                                path: uploadPath,
                                mimeType: 'image/png',
                                sizeBytes: content.length,
                                sha256: sha256(content),
                            },
                        ],
                    },
                },
            },
        })).resolves.toEqual(new Set([uploadPath]));
    });

    it('does not trust uploaded local image paths when the declared hash is wrong', async () => {
        const cwd = await createTempDir();
        const uploadPath = '.happier/uploads/messages/message-1/screen.png';
        await mkdir(dirname(join(cwd, uploadPath)), { recursive: true });
        await writeFile(join(cwd, uploadPath), 'fake image bytes');

        await expect(resolveTrustedSessionAttachmentLocalImagePaths({
            cwd,
            metadata: {
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            {
                                path: uploadPath,
                                mimeType: 'image/png',
                                sizeBytes: 16,
                                sha256: sha256('different content'),
                            },
                        ],
                    },
                },
            },
        })).resolves.toEqual(new Set());
    });

    it('verifies an image retained beside review metadata through the canonical attachment envelope reader', async () => {
        const cwd = await createTempDir();
        const uploadPath = '.happier/uploads/messages/message-1/screen.png';
        const content = 'fake image bytes';
        await mkdir(dirname(join(cwd, uploadPath)), { recursive: true });
        await writeFile(join(cwd, uploadPath), content);

        await expect(resolveTrustedSessionAttachmentLocalImagePaths({
            cwd,
            metadata: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: { comments: [] },
                },
                happierAttachments: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            {
                                path: uploadPath,
                                mimeType: 'image/png',
                                sizeBytes: content.length,
                                sha256: sha256(content),
                            },
                        ],
                    },
                },
            },
        })).resolves.toEqual(new Set([uploadPath]));
    });
});
