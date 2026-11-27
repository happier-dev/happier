import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ARTIFACT_UPLOAD_CONTENT_TYPE_V1, ARTIFACT_UPLOAD_PATH_V1, DISCUSSION_UPLOAD_CONTENT_TYPE_V1 } from '@happier-dev/transfers';
import { db } from '@/storage/db';
import { openArtifactBlobBytes } from '@/app/artifacts/artifactBlobService';
import { openDiscussionAttachmentBytes } from '@/app/discussions/attachmentService';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createAttachmentApp } from '../discussions/discussionAttachments.testkit';
import { registerArtifactUploadRoutes } from './registerArtifactUploadRoutes';

const staging = vi.hoisted(() => ({ fullReads: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof fs>();
    const readFile: typeof actual.readFile = (async (...args: Parameters<typeof actual.readFile>) => {
        if (String(args[0]).endsWith('.upload')) staging.fullReads += 1;
        return actual.readFile(...args);
    }) as typeof actual.readFile;
    return { ...actual, readFile };
});

const profile = process.env.HAPPIER_TEST_PROFILE_STAGED_BINARY_UPLOAD;
const chunk = Buffer.alloc(64 * 1024);
for (let index = 0; index < chunk.length; index++) chunk[index] = index % 251;
const CHUNKS = profile ? 400 : 2;
const sizeBytes = chunk.length * CHUNKS + (profile ? 0 : 1);
function* payload() {
    for (let index = 0; index < CHUNKS; index++) yield chunk;
    if (!profile) yield chunk.subarray(0, 1);
}
const sha256 = (() => {
    const hash = createHash('sha256');
    for (const bytes of payload()) hash.update(bytes);
    return hash.digest('hex');
})();

describe('staged binary HTTP finalization (SQLite, local private storage)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-staged-binary-http-', initEncrypt: true, initFiles: true,
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    for (const kind of ['artifact', 'discussion'] as const) {
        it.runIf(!profile || profile === kind)(`commits a staged ${kind} upload, retries and cleans up`, async () => {
            staging.fullReads = 0;
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
            await makeShareEligibleForTest(owner.id, reader.id);
            const { app, restoreEnvironment } = createAttachmentApp(() => owner.id);
            registerArtifactUploadRoutes(app);
            const blobId = randomUUID();
            const artifactId = randomUUID();
            const file = { blobId, mime: 'application/octet-stream', sizeBytes, sha256 };
            const metadata = kind === 'artifact' ? {
                kind: 'create', t: 'plain', artifactId, blobId, sizeBytes,
                header: encodePlainArtifactStoredContent({ title: 'Staged upload fixture' }),
                body: encodePlainArtifactStoredContent({ body: file }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            } : {
                operation: 'create', input: { creationLocalId: randomUUID(),
                    titleContent: { t: 'plain', v: { v: 1, title: 'Staged upload fixture' } },
                    participants: [{ kind: 'account', accountId: reader.id }],
                    firstMessage: { localId: randomUUID(), mentionedAccountIds: [], attachments: [{ blobId, t: 'plain' }],
                        content: { t: 'plain', v: { v: 1, parts: [{ t: 'attachment',
                            attachment: { kind: 'file', id: blobId, name: 'fixture.bin', file } }] } },
                    },
                },
                attachments: [{ blobId, t: 'plain', storedSizeBytes: sizeBytes }],
            };
            try {
                await app.listen({ host: '127.0.0.1', port: 0 });
                const port = (app.server.address() as AddressInfo).port;
                const url = `http://127.0.0.1:${port}` + (kind === 'artifact' ? ARTIFACT_UPLOAD_PATH_V1 : '/v1/discussions/upload');
                const send = async (complete: boolean) => {
                    const body = Readable.toWeb(Readable.from((function* () {
                        yield Buffer.from(JSON.stringify(metadata) + '\n');
                        if (complete) yield* payload();
                        else yield chunk;
                    })()));
                    const baseline = process.memoryUsage.rss();
                    let peak = baseline;
                    const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 2);
                    const started = performance.now();
                    try {
                        const response = await fetch(url, { method: 'POST', body, duplex: 'half',
                            headers: { 'content-type': kind === 'artifact' ? ARTIFACT_UPLOAD_CONTENT_TYPE_V1 : DISCUSSION_UPLOAD_CONTENT_TYPE_V1 },
                        } as RequestInit);
                        const responseText = await response.text();
                        if (profile) console.info(JSON.stringify({ kind, complete, sizeBytes, status: response.status,
                            baseline, peak: Math.max(peak, process.memoryUsage.rss()), peakProcessKiB: process.resourceUsage().maxRSS,
                            completionMs: performance.now() - started }));
                        return { status: response.status, responseText };
                    } finally { clearInterval(sample); }
                };
                const truncated = await send(false);
                expect(truncated.status).toBe(400);
                expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);

                const initial = await send(true);
                expect(initial.status, initial.responseText).toBe(200);
                const retry = await send(true);
                expect(retry.status, retry.responseText).toBe(200);
                const verify = async <T extends { storedSizeBytes: bigint }>(rows: T[], open: (row: T) => Promise<Uint8Array>) => {
                    expect(rows).toHaveLength(1);
                    expect(rows[0]!.storedSizeBytes).toBeGreaterThan(BigInt(sizeBytes));
                    if (!profile) expect(createHash('sha256').update(await open(rows[0]!)).digest('hex')).toBe(sha256);
                };
                if (kind === 'artifact') {
                    await verify(await db.artifactBlob.findMany({ where: { id: blobId } }), row => openArtifactBlobBytes(owner.id, row));
                } else {
                    await verify(await db.discussionAttachment.findMany({ where: { blobId } }), openDiscussionAttachmentBytes);
                }
                expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
                const root = join(tmpdir(), 'happier', 'file-transfers');
                for (const dir of (await fs.readdir(root)).filter(dir => dir.startsWith(process.pid + '-'))) {
                    expect(await fs.readdir(join(root, dir))).toEqual([]);
                }
                expect(staging.fullReads).toBe(0);
            } finally {
                await app.close();
                restoreEnvironment();
            }
        }, 60_000);
    }
});
