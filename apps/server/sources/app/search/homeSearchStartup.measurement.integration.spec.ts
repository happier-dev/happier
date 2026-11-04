import { TranscriptRawRecordV1Schema } from '@happier-dev/protocol';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

import { readCanonicalSessionMessagesPage } from './homeSearchCanonicalSessionMessages';
import type { HomeSearchCanonicalPageReader } from './homeSearchIndexer';
import { startHomeSearchLifecycle } from './homeSearchLifecycle';

const ENABLED = process.env.HAPPIER_HOME_SEARCH_MEASURE === '1';
const SESSION_COUNT = 100;
const MESSAGES_PER_SESSION = 250;
const MESSAGE_COUNT = SESSION_COUNT * MESSAGES_PER_SESSION;
const TOOL_OUTPUT_EVERY = 10;
const SEED_BATCH_SIZE = 250;
const TOOL_OUTPUT_MARKER = 'canonical_tool_output_marker';
const TRANSCRIPT_MARKER = 'representative_transcript_marker';
// The opt-in measurement performs two complete 25,000-row projections. Each
// phase has been observed near three minutes on a contended remote executor,
// so the test timeout must cover both phases rather than terminating between
// them and discarding the measurement.
const MEASUREMENT_TIMEOUT_MS = 10 * 60_000;

const transcriptBody = TranscriptRawRecordV1Schema.parse({
    role: 'user',
    content: {
        type: 'text',
        text: `${TRANSCRIPT_MARKER} discusses a source change, review evidence, and the next implementation step.`,
    },
});

const toolOutputBody = TranscriptRawRecordV1Schema.parse({
    role: 'agent',
    content: {
        type: 'acp',
        agentId: 'opencode',
        data: {
            type: 'tool-result',
            callId: 'measurement-call',
            id: 'measurement-tool-result',
            output: [{
                type: 'text',
                text: `${TOOL_OUTPUT_MARKER}\n${'src/module.ts: validated tool output line\n'.repeat(40)}`,
            }],
        },
    },
});

type ProjectionMeasurement = Readonly<{
    durationMs: number;
    canonicalReadDurationMs: number;
    /** Total lifecycle reconciliation time outside the awaited canonical page reads. */
    reconciliationRemainderDurationMs: number;
    canonicalPageReads: number;
    canonicalRowsRead: number;
    messagesPerSecond: number;
}>;

function createMeasuredCanonicalReader(): Readonly<{
    read: HomeSearchCanonicalPageReader;
    reset(): void;
    snapshot(durationMs: number): ProjectionMeasurement;
}> {
    let canonicalPageReads = 0;
    let canonicalRowsRead = 0;
    let canonicalReadDurationMs = 0;
    return {
        async read(input) {
            const startedAt = performance.now();
            const page = await readCanonicalSessionMessagesPage(input);
            canonicalReadDurationMs += performance.now() - startedAt;
            canonicalPageReads += 1;
            canonicalRowsRead += page.messages.length;
            return page;
        },
        reset() {
            canonicalPageReads = 0;
            canonicalRowsRead = 0;
            canonicalReadDurationMs = 0;
        },
        snapshot(durationMs) {
            return {
                durationMs,
                canonicalReadDurationMs,
                reconciliationRemainderDurationMs: Math.max(0, durationMs - canonicalReadDurationMs),
                canonicalPageReads,
                canonicalRowsRead,
                messagesPerSecond: durationMs > 0 ? canonicalRowsRead / (durationMs / 1_000) : 0,
            };
        },
    };
}

async function measureProjection(
    reader: ReturnType<typeof createMeasuredCanonicalReader>,
    operation: () => Promise<void>,
): Promise<ProjectionMeasurement> {
    reader.reset();
    const startedAt = performance.now();
    await operation();
    return reader.snapshot(performance.now() - startedAt);
}

describe.skipIf(!ENABLED)('Home search startup measurement (integration)', () => {
    let harness: LightSqliteHarness | null = null;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-home-search-measurement-',
            initAuth: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only' },
        });
    }, 300_000);

    afterAll(async () => {
        await harness?.close();
    });

    it('measures canonical paged startup reconciliation and a lifecycle-owned full rebuild', async () => {
        const fixtureStartedAt = performance.now();
        const account = await db.account.create({
            data: { publicKey: 'home-search-measurement-account', encryptionMode: 'plain' },
            select: { id: true },
        });
        const sessions = Array.from({ length: SESSION_COUNT }, (_, sessionIndex) => ({
            id: `home-search-measurement-session-${String(sessionIndex).padStart(3, '0')}`,
            tag: `measurement-${sessionIndex}`,
            accountId: account.id,
            metadata: 'Home search representative startup measurement',
            encryptionMode: 'plain',
            currentStorageState: 'hosted',
        }));
        await db.session.createMany({ data: sessions });

        for (let offset = 0; offset < MESSAGE_COUNT; offset += SEED_BATCH_SIZE) {
            const count = Math.min(SEED_BATCH_SIZE, MESSAGE_COUNT - offset);
            await db.sessionMessage.createMany({
                data: Array.from({ length: count }, (_, batchIndex) => {
                    const messageIndex = offset + batchIndex;
                    const sessionIndex = Math.floor(messageIndex / MESSAGES_PER_SESSION);
                    const seq = messageIndex % MESSAGES_PER_SESSION;
                    const toolOutput = messageIndex % TOOL_OUTPUT_EVERY === 0;
                    return {
                        id: `home-search-measurement-message-${String(messageIndex).padStart(6, '0')}`,
                        sessionId: sessions[sessionIndex]!.id,
                        localId: `measurement-local-${seq}`,
                        seq,
                        messageRole: toolOutput ? 'agent' : 'user',
                        content: { t: 'plain', v: toolOutput ? toolOutputBody : transcriptBody },
                    };
                }),
            });
        }

        expect(await db.session.count({ where: { accountId: account.id } })).toBe(SESSION_COUNT);
        expect(await db.sessionMessage.count()).toBe(MESSAGE_COUNT);
        const fixtureDurationMs = performance.now() - fixtureStartedAt;
        console.log('HOME_SEARCH_STARTUP_MEASUREMENT_STAGE', JSON.stringify({
            stage: 'fixture',
            durationMs: fixtureDurationMs,
            messages: MESSAGE_COUNT,
        }));

        const measuredReader = createMeasuredCanonicalReader();
        if (!harness) throw new Error('Home search measurement harness did not initialize.');
        const dbPath = join(harness.baseDir, 'derived', 'search.sqlite');
        const lifecycle = startHomeSearchLifecycle({
            dbPath,
            homeServerIdentityId: 'home-search-measurement-server',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: measuredReader.read,
        });

        const startup = await measureProjection(measuredReader, async () => {
            await lifecycle.prepare(sessions.map(session => session.id));
        });
        expect(startup.canonicalRowsRead).toBe(MESSAGE_COUNT);
        expect(startup.canonicalPageReads).toBeGreaterThan(1);
        expect(lifecycle.search({ v: 1, query: TRANSCRIPT_MARKER, scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: expect.arrayContaining([expect.anything()]) });
        expect(lifecycle.search({ v: 1, query: TOOL_OUTPUT_MARKER, scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: expect.arrayContaining([expect.anything()]) });
        console.log('HOME_SEARCH_STARTUP_MEASUREMENT_STAGE', JSON.stringify({ stage: 'startup', ...startup }));

        const rebuild = await measureProjection(measuredReader, async () => {
            await lifecycle.invalidateAndRebuild('explicit-repair');
        });
        expect(rebuild.canonicalRowsRead).toBe(MESSAGE_COUNT);
        expect(rebuild.canonicalPageReads).toBe(startup.canonicalPageReads);
        expect(lifecycle.search({ v: 1, query: TOOL_OUTPUT_MARKER, scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: expect.arrayContaining([expect.anything()]) });
        console.log('HOME_SEARCH_STARTUP_MEASUREMENT_STAGE', JSON.stringify({ stage: 'rebuild', ...rebuild }));

        const metrics = {
            corpus: {
                sessions: SESSION_COUNT,
                messages: MESSAGE_COUNT,
                ordinaryTranscriptMessages: MESSAGE_COUNT - (MESSAGE_COUNT / TOOL_OUTPUT_EVERY),
                canonicalAcpToolOutputMessages: MESSAGE_COUNT / TOOL_OUTPUT_EVERY,
                seedBatchSize: SEED_BATCH_SIZE,
                fixtureDurationMs,
            },
            startup,
            rebuild,
        };
        const outputPath = process.env.HAPPIER_HOME_SEARCH_MEASURE_OUTPUT;
        if (outputPath) await writeFile(outputPath, JSON.stringify(metrics), 'utf8');
        console.log('HOME_SEARCH_STARTUP_MEASUREMENT', JSON.stringify(metrics));

        await lifecycle.stop();
    }, MEASUREMENT_TIMEOUT_MS);
});
