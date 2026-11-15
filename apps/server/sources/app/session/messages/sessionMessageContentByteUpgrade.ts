import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';

import { SESSION_MESSAGE_PAGE_DEFAULT_LIMIT } from '@/app/api/routes/session/sessionMessagePageProjection';
import { compareAndSetSimpleCache, readFromSimpleCache } from '@/storage/cache/simpleCache';
import { db } from '@/storage/db';
import { encodeSessionMessageContentForStorage, toPrismaSessionMessageStoredContent } from '@/storage/sessionMessageContent';
import { log, warn } from '@/utils/logging/log';

/**
 * One-time 0.2 → 0.3 upgrade of historical SessionMessage storage (owner ruling
 * 2026-11-15 "Growth decisions final" item 4). 0.2 stored E2EE ciphertext as
 * base64 inside the JSON envelope `{t:'encrypted',c}`; 0.3 writers store the same
 * ciphertext as raw `contentBytes` beside JSON null. This changes the encoding
 * only: it never decrypts, and every reader reconstructs the identical envelope
 * through `storage/sessionMessageContent.ts`, which already serves both forms.
 *
 * SessionMessage is the only table with a byte form; SessionSystemRecord and
 * Session metadata/state keep their base64 representation.
 */
const UPGRADE_STATE_KEY = 'server.session-message-content-bytes.upgrade.v1';

/**
 * Rows per page = the canonical transcript page (`SESSION_MESSAGE_PAGE_DEFAULT_LIMIT`):
 * the server already materializes that many message bodies in one read on the same
 * connection, so the page read occupies the connection no longer than one user page
 * read. Writes are single-row conditional statements, so on the single-connection
 * SQLite runtime requests interleave between every statement instead of waiting
 * for a page transaction (measured on SQLite: a whole-page transaction held the
 * connection ~19x as long as a 150-row page read).
 */
const DEFAULT_PAGE_SIZE = SESSION_MESSAGE_PAGE_DEFAULT_LIMIT;

/** Progress log cadence (log volume only: ~107 lines for the largest measured 16M-row database). */
const PROGRESS_LOG_EVERY_PAGES = 1_000;

type UpgradeState = Readonly<{
    v: 1;
    /** Keyset cursor: every row with a smaller-or-equal id has been decided. */
    afterId: string | null;
    done: boolean;
}>;

const INITIAL_STATE: UpgradeState = { v: 1, afterId: null, done: false };

export type SessionMessageContentByteUpgradeResult = Readonly<{
    status: 'complete' | 'paused';
    /** This run's rows rewritten to bytes. */
    converted: number;
    /** This run's plain, non-canonical or otherwise non-byte rows left untouched. */
    retained: number;
    pages: number;
    scannedThisRun: number;
}>;

function parseState(raw: string | null): UpgradeState {
    if (raw === null) return INITIAL_STATE;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') throw new Error(`${UPGRADE_STATE_KEY} is invalid`);
    const state = value as Record<string, unknown>;
    if (state.v !== 1 || typeof state.done !== 'boolean'
        || (state.afterId !== null && typeof state.afterId !== 'string')) {
        throw new Error(`${UPGRADE_STATE_KEY} is invalid`);
    }
    return state as UpgradeState;
}

const UPGRADE_ROW_SELECT = { id: true, content: true, rowRevision: true, updatedAt: true } as const;
type UpgradeRow = Readonly<{ id: string; content: PrismaJson.SessionMessageStoredContent; rowRevision: bigint; updatedAt: Date }>;
type UpgradeCandidate = UpgradeRow & Readonly<{ contentBytes: Uint8Array<ArrayBuffer> }>;

/**
 * Exactly the write path's byte predicate, applied only to an exact historical
 * `{t:'encrypted',c}` envelope: a row with extra keys or a legacy bare-string
 * shape would not round-trip to the same stored envelope, so it stays JSON.
 */
function classify(rows: readonly UpgradeRow[]): { candidates: UpgradeCandidate[]; retained: number } {
    const candidates: UpgradeCandidate[] = [];
    let retained = 0;
    for (const row of rows) {
        const parsed = StrictSessionStoredMessageContentEnvelopeSchema.safeParse(row.content);
        if (!parsed.success || parsed.data.t !== 'encrypted') { retained += 1; continue; }
        const stored = encodeSessionMessageContentForStorage(parsed.data);
        if (stored.contentBytes === null) { retained += 1; continue; }
        candidates.push({ ...row, contentBytes: stored.contentBytes });
    }
    return { candidates, retained };
}

async function convertRows(rows: readonly UpgradeRow[]): Promise<{ converted: number; retained: number }> {
    let { candidates, retained } = classify(rows);
    let converted = 0;
    while (candidates.length > 0) {
        const missed: string[] = [];
        for (const candidate of candidates) {
            // Conditional on the row still being the read 0.2 form, so a rerun or a
            // concurrent writer is safe: a content correction bumps rowRevision through
            // its CAS owner, and any other update moves updatedAt. Conversion is not a
            // change, so it keeps both.
            const result = await db.sessionMessage.updateMany({
                where: { id: candidate.id, contentBytes: null, rowRevision: candidate.rowRevision, updatedAt: candidate.updatedAt },
                data: { content: toPrismaSessionMessageStoredContent(null), contentBytes: candidate.contentBytes, updatedAt: candidate.updatedAt },
            });
            if (result.count === 1) converted += 1;
            else missed.push(candidate.id);
        }
        if (missed.length === 0) break;
        // Re-decide raced rows from their committed state; deleted or already
        // converted rows drop out. Each pass requires a newer concurrent commit.
        const next = classify(await db.sessionMessage.findMany({
            where: { id: { in: missed }, contentBytes: null }, select: UPGRADE_ROW_SELECT,
        }));
        candidates = next.candidates;
        retained += next.retained;
    }
    return { converted, retained };
}

/**
 * One page. The cursor advances only after every row of the page is decided; a
 * crash before that re-reads the page, where converted rows no longer match.
 */
async function upgradeNextPage(raw: string, state: UpgradeState, pageSize: number): Promise<{
    raw: string; state: UpgradeState; scanned: number; converted: number; retained: number;
} | null> {
    const rows = await db.sessionMessage.findMany({
        where: { contentBytes: null, ...(state.afterId === null ? {} : { id: { gt: state.afterId } }) },
        orderBy: { id: 'asc' },
        take: pageSize,
        select: UPGRADE_ROW_SELECT,
    });
    const page = rows.length === 0 ? { converted: 0, retained: 0 } : await convertRows(rows);
    const next: UpgradeState = {
        v: 1,
        afterId: rows.length === 0 ? state.afterId : rows[rows.length - 1]!.id,
        done: rows.length < pageSize,
    };
    const nextRaw = JSON.stringify(next);
    // Another replica advanced the same cursor first: continue from its state.
    if (!await compareAndSetSimpleCache(UPGRADE_STATE_KEY, raw, nextRaw)) return null;
    return { raw: nextRaw, state: next, scanned: rows.length, ...page };
}

async function readOrCreateState(): Promise<{ raw: string; state: UpgradeState }> {
    for (;;) {
        const raw = await readFromSimpleCache(UPGRADE_STATE_KEY);
        if (raw !== null) return { raw, state: parseState(raw) };
        const initial = JSON.stringify(INITIAL_STATE);
        if (await compareAndSetSimpleCache(UPGRADE_STATE_KEY, null, initial)) return { raw: initial, state: INITIAL_STATE };
    }
}

export async function runSessionMessageContentByteUpgrade(options?: Readonly<{
    pageSize?: number;
    shouldContinue?: (pagesThisRun: number) => boolean;
    onPage?: (progress: Readonly<{ pages: number; scannedThisRun: number; converted: number; retained: number }>) => void;
}>): Promise<SessionMessageContentByteUpgradeResult> {
    const pageSize = Math.max(1, options?.pageSize ?? DEFAULT_PAGE_SIZE);
    let { raw, state } = await readOrCreateState();
    let pages = 0;
    let scannedThisRun = 0;
    let converted = 0;
    let retained = 0;
    while (!state.done) {
        if (options?.shouldContinue && !options.shouldContinue(pages)) {
            return { status: 'paused', converted, retained, pages, scannedThisRun };
        }
        const page = await upgradeNextPage(raw, state, pageSize);
        if (page === null) {
            ({ raw, state } = await readOrCreateState());
            continue;
        }
        ({ raw, state } = page);
        scannedThisRun += page.scanned;
        converted += page.converted;
        retained += page.retained;
        pages += 1;
        options?.onPage?.({ pages, scannedThisRun, converted, retained });
        // Let queued requests run before the next page read.
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    return { status: 'complete', converted, retained, pages, scannedThisRun };
}

function describeFailure(error: unknown): string {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && /^P\d{4}$/.test(code)) return code;
    return error instanceof Error ? error.name : 'unknown';
}

/**
 * Starts the upgrade beside a serving server. It runs one loop to completion and
 * then ends: no timer remains. A failure is logged and the next server start
 * resumes from the committed cursor; readers serve both forms meanwhile.
 */
export function startSessionMessageContentByteUpgrade(): { stop: () => Promise<void> } {
    let stopped = false;
    const startedAt = Date.now();
    const active = (async () => {
        try {
            const result = await runSessionMessageContentByteUpgrade({
                shouldContinue: () => !stopped,
                onPage: ({ pages, scannedThisRun, converted, retained }) => {
                    if (pages !== 1 && pages % PROGRESS_LOG_EVERY_PAGES !== 0) return;
                    log({ module: 'session-message-content-bytes-upgrade', pages, scannedThisRun,
                        converted, retained }, pages === 1
                        ? 'SessionMessage byte upgrade running'
                        : 'SessionMessage byte upgrade progress');
                },
            });
            if (result.pages === 0) return;
            log({ module: 'session-message-content-bytes-upgrade', status: result.status, pages: result.pages,
                scannedThisRun: result.scannedThisRun, converted: result.converted, retained: result.retained,
                elapsedMs: Date.now() - startedAt }, result.status === 'complete'
                ? 'SessionMessage byte upgrade complete'
                : 'SessionMessage byte upgrade paused; the next start resumes it');
        } catch (error) {
            warn({ module: 'session-message-content-bytes-upgrade', failure: describeFailure(error) },
                'SessionMessage byte upgrade stopped; the next start resumes from its committed cursor');
        }
    })();
    return {
        stop: async () => {
            stopped = true;
            await active;
        },
    };
}
