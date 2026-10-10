import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MEMORY_SEARCH_FTS_TOKENIZER, segmentMemorySearchCjkRuns } from '@happier-dev/protocol/memory/memorySearchText';
import type { SessionTranscriptPublicationConstraint } from '@/app/session/sessionTranscriptPublicationPolicy';
import {
    openHomeSearchSqliteBinding,
    type HomeSearchSqliteDatabase,
    type HomeSearchSqliteStatement,
    type HomeSearchSqliteValue,
} from './homeSearchSqliteBinding';

export const HOME_SEARCH_SCHEMA_VERSION = 1;

export type HomeSearchMessage = Readonly<{
    id: string;
    sessionId: string;
    seq: number;
    createdAtMs: number;
    updatedAtMs?: number;
    role?: string | null;
    text: string;
}>;

export type HomeSearchHit = Readonly<{
    id: string;
    sessionId: string;
    seqFrom: number;
    seqTo: number;
    createdAtFromMs: number;
    createdAtToMs: number;
    role: string | null;
    text: string;
    snippet: string;
    score: number;
}>;

export type HomeSearchDb = Readonly<{
    path: string;
    upsert(message: HomeSearchMessage): void;
    upsertMany(messages: readonly HomeSearchMessage[]): void;
    remove(messageId: string): void;
    removeSession(sessionId: string): void;
    clear(): void;
    count(): number;
    search(input: Readonly<{
        query: string;
        sessionId?: string;
        sessionConstraints?: readonly SessionTranscriptPublicationConstraint[];
        maxResults?: number;
    }>): HomeSearchHit[];
    close(): void;
}>;

function sanitizeStoredText(value: string): string {
    return String(value ?? '').replace(/\u0000/gu, '').trim();
}

function normalizeFtsText(value: string): string {
    return sanitizeStoredText(value).normalize('NFKC');
}

// Unicode61 has no word segmentation for scripts written without inter-word spaces, so a
// Chinese, Japanese, or Korean run becomes one giant token that no sub-word query can match.
// Overlapping unigrams and bigrams restore sub-run searchability;
// they are applied only to the derived FTS text, never to the stored message text.
const segmentCjkRuns = segmentMemorySearchCjkRuns;

function buildFtsQuery(value: string): Readonly<{ match: string; snippetTerms: string[] }> {
    const matchParts: string[] = [];
    const snippetTerms: string[] = [];
    for (const rawTerm of normalizeFtsText(value).replace(/"/gu, ' ').split(/\s+/u)) {
        const prefix = rawTerm.endsWith('*');
        const displayTerm = rawTerm.replace(/\*+$/u, '');
        if (!displayTerm) continue;
        snippetTerms.push(displayTerm);
        for (const token of segmentCjkRuns(displayTerm).split(/\s+/u).filter(Boolean)) {
            matchParts.push(`"${token.replace(/"/gu, '""')}"${prefix ? '*' : ''}`);
        }
    }
    return { match: matchParts.join(' AND '), snippetTerms };
}

const SNIPPET_WINDOW_CHARS = 160;
// A constrained Session consumes two bindings in the authorization CTE. Keep the same
// portable 999-variable boundary while reserving MATCH and LIMIT bindings.
const HOME_SEARCH_SESSION_CONSTRAINT_BATCH_SIZE = 450;
// SQLite guarantees at least 999 host parameters. The canonical message table
// consumes seven bindings per row, so 140 rows keep every bulk statement portable.
const HOME_SEARCH_WRITE_BATCH_SIZE = 140;

type HomeSearchSegmenter = Readonly<{
    segment(value: string): Iterable<Readonly<{ segment: string; index: number }>>;
}>;
type HomeSearchSegmenterConstructor = new (
    locale: string,
    options: Readonly<{ granularity: 'grapheme' }>,
) => HomeSearchSegmenter;

// The server's Node/Bun runtimes provide Segmenter, while the package's retained
// compiler lib predates its declaration. Keep that standard-library seam narrow.
const HomeSearchSegmenter = (Intl as typeof Intl & Readonly<{
    Segmenter: HomeSearchSegmenterConstructor;
}>).Segmenter;
const HOME_SEARCH_SNIPPET_SEGMENTER = new HomeSearchSegmenter('und', { granularity: 'grapheme' });

type NormalizedSnippetSegment = Readonly<{
    normalizedStart: number;
    normalizedEnd: number;
    sourceStart: number;
    sourceEnd: number;
}>;

function normalizeSnippetText(text: string): Readonly<{
    text: string;
    segments: readonly NormalizedSnippetSegment[];
}> {
    let normalizedText = '';
    const segments: NormalizedSnippetSegment[] = [];
    for (const part of HOME_SEARCH_SNIPPET_SEGMENTER.segment(text)) {
        const normalizedPart = part.segment.normalize('NFKC').toLowerCase();
        if (!normalizedPart) continue;
        const normalizedStart = normalizedText.length;
        normalizedText += normalizedPart;
        segments.push({
            normalizedStart,
            normalizedEnd: normalizedText.length,
            sourceStart: part.index,
            sourceEnd: part.index + part.segment.length,
        });
    }
    return { text: normalizedText, segments };
}

function sourceRangeForNormalizedMatch(
    segments: readonly NormalizedSnippetSegment[],
    normalizedStart: number,
    normalizedEnd: number,
): Readonly<{ start: number; end: number }> | null {
    const first = segments.find((segment) => normalizedStart >= segment.normalizedStart && normalizedStart < segment.normalizedEnd);
    const last = segments.find((segment) => normalizedEnd > segment.normalizedStart && normalizedEnd <= segment.normalizedEnd);
    return first && last ? { start: first.sourceStart, end: last.sourceEnd } : null;
}

function moveByCodePoints(text: string, from: number, count: number): number {
    let index = from;
    if (count < 0) {
        for (let remaining = -count; remaining > 0 && index > 0; remaining -= 1) {
            index -= 1;
            const unit = text.charCodeAt(index);
            if (index > 0 && unit >= 0xDC00 && unit <= 0xDFFF) index -= 1;
        }
        return index;
    }
    for (let remaining = count; remaining > 0 && index < text.length; remaining -= 1) {
        const codePoint = text.codePointAt(index);
        index += codePoint !== undefined && codePoint > 0xFFFF ? 2 : 1;
    }
    return index;
}

/** Renders the user-visible snippet from the pristine message text so segmented index text never leaks into results. */
function buildSnippet(text: string, terms: readonly string[]): string {
    const haystack = normalizeSnippetText(text);
    let matchStart = -1;
    let matchLength = 0;
    let matchedTerm = '';
    for (const term of terms) {
        const normalizedTerm = term.normalize('NFKC').toLowerCase();
        const found = haystack.text.indexOf(normalizedTerm);
        const sourceRange = found >= 0
            ? sourceRangeForNormalizedMatch(haystack.segments, found, found + normalizedTerm.length)
            : null;
        if (sourceRange && (matchStart < 0 || sourceRange.start < matchStart)) {
            matchStart = sourceRange.start;
            matchLength = sourceRange.end - sourceRange.start;
            matchedTerm = term;
        }
    }
    if (matchStart < 0) {
        const end = moveByCodePoints(text, 0, SNIPPET_WINDOW_CHARS);
        return end < text.length ? `${text.slice(0, end)}…` : text;
    }
    // Extend ASCII prefix matches (gam* -> gamma) to the end of the token they started.
    if (/[A-Za-z0-9_*-]$/u.test(matchedTerm)) {
        while (matchStart + matchLength < text.length && /[A-Za-z0-9_$-]/u.test(text[matchStart + matchLength]!)) matchLength += 1;
    }
    const matchEnd = matchStart + matchLength;
    const start = moveByCodePoints(text, matchStart, -60);
    const end = moveByCodePoints(text, matchEnd, 100);
    return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function boundedLimit(value: number | undefined): number {
    if (!Number.isFinite(value)) return 20;
    return Math.max(1, Math.min(100, Math.trunc(value as number)));
}

export function resolveHomeSearchDbPath(dataDir: string): string {
    return resolve(join(dataDir, 'derived', 'search.sqlite'));
}

export async function openHomeSearchDb(params: Readonly<{ dbPath?: string; dataDir?: string }>): Promise<HomeSearchDb> {
    if (!params.dbPath && !params.dataDir) throw new Error('Personal Home search database path is required');
    const path = resolve(params.dbPath ?? resolveHomeSearchDbPath(params.dataDir!));
    await mkdir(dirname(path), { recursive: true });
    let db: HomeSearchSqliteDatabase;
    try {
        db = await openHomeSearchSqliteBinding(path);
    } catch (error) {
        throw new Error(`Personal Home search index is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec('PRAGMA foreign_keys = ON;');
        db.exec(`
            CREATE TABLE IF NOT EXISTS home_search_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS home_search_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER,
                role TEXT,
                text TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS home_search_messages_session_seq
                ON home_search_messages(session_id, seq);
            CREATE VIRTUAL TABLE IF NOT EXISTS home_search_fts USING fts5(
                id UNINDEXED,
                session_id UNINDEXED,
                seq UNINDEXED,
                created_at_ms UNINDEXED,
                role UNINDEXED,
                text,
                tokenize = '${MEMORY_SEARCH_FTS_TOKENIZER}'
            );
        `);
        const existingVersion = db.prepare('SELECT value FROM home_search_meta WHERE key = ?').get('schema_version') as { value?: string } | undefined;
        if (existingVersion?.value !== undefined && existingVersion.value !== String(HOME_SEARCH_SCHEMA_VERSION)) {
            throw new Error(`Unsupported Personal Home search schema version: ${existingVersion.value}`);
        }
        db.prepare('INSERT OR IGNORE INTO home_search_meta(key, value) VALUES (?, ?)').run(
            'schema_version',
            String(HOME_SEARCH_SCHEMA_VERSION),
        );
    } catch (error) {
        db.close();
        throw new Error(`Personal Home search index is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const upsert = db.prepare(`
        INSERT INTO home_search_messages(id, session_id, seq, created_at_ms, updated_at_ms, role, text)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            session_id = excluded.session_id,
            seq = excluded.seq,
            created_at_ms = excluded.created_at_ms,
            updated_at_ms = excluded.updated_at_ms,
            role = excluded.role,
            text = excluded.text
    `);
    const deleteMessage = db.prepare('DELETE FROM home_search_messages WHERE id = ?');
    const deleteFts = db.prepare('DELETE FROM home_search_fts WHERE id = ?');
    const insertFts = db.prepare(`
        INSERT INTO home_search_fts(id, session_id, seq, created_at_ms, role, text)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const deleteSessionMessages = db.prepare('DELETE FROM home_search_messages WHERE session_id = ?');
    const deleteSessionFts = db.prepare('DELETE FROM home_search_fts WHERE session_id = ?');
    const countMessages = db.prepare('SELECT count(*) AS count FROM home_search_messages');

    type PreparedHomeSearchMessage = Readonly<{
        id: string;
        sessionId: string;
        seq: number;
        createdAtMs: number;
        updatedAtMs: number | null;
        role: string | null;
        text: string;
        ftsText: string;
    }>;
    const prepareMessage = (message: HomeSearchMessage): PreparedHomeSearchMessage | null => {
        const text = sanitizeStoredText(message.text);
        if (!message.id || !message.sessionId || !text) return null;
        return {
            id: message.id,
            sessionId: message.sessionId,
            seq: message.seq,
            createdAtMs: message.createdAtMs,
            updatedAtMs: message.updatedAtMs ?? null,
            role: message.role ?? null,
            text,
            ftsText: segmentCjkRuns(normalizeFtsText(text)),
        };
    };
    const writePreparedUpsert = (message: PreparedHomeSearchMessage) => {
        upsert.run(
            message.id,
            message.sessionId,
            message.seq,
            message.createdAtMs,
            message.updatedAtMs,
            message.role,
            message.text,
        );
        deleteFts.run(message.id);
        insertFts.run(
            message.id,
            message.sessionId,
            message.seq,
            message.createdAtMs,
            message.role,
            message.ftsText,
        );
    };
    const bulkStatements = new Map<number, Readonly<{
        upsert: HomeSearchSqliteStatement;
        deleteFts: HomeSearchSqliteStatement;
        insertFts: HomeSearchSqliteStatement;
    }>>();
    const statementsForBatchSize = (size: number) => {
        const existing = bulkStatements.get(size);
        if (existing) return existing;
        const statements = {
            upsert: db.prepare(`
                INSERT INTO home_search_messages(id, session_id, seq, created_at_ms, updated_at_ms, role, text)
                VALUES ${Array.from({ length: size }, () => '(?, ?, ?, ?, ?, ?, ?)').join(',')}
                ON CONFLICT(id) DO UPDATE SET
                    session_id = excluded.session_id,
                    seq = excluded.seq,
                    created_at_ms = excluded.created_at_ms,
                    updated_at_ms = excluded.updated_at_ms,
                    role = excluded.role,
                    text = excluded.text
            `),
            deleteFts: db.prepare(`DELETE FROM home_search_fts WHERE id IN (${Array.from({ length: size }, () => '?').join(',')})`),
            insertFts: db.prepare(`
                INSERT INTO home_search_fts(id, session_id, seq, created_at_ms, role, text)
                VALUES ${Array.from({ length: size }, () => '(?, ?, ?, ?, ?, ?)').join(',')}
            `),
        };
        bulkStatements.set(size, statements);
        return statements;
    };
    const inWriteTransaction = (write: () => void) => {
        db.exec('BEGIN IMMEDIATE');
        try {
            write();
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    };

    const result: HomeSearchDb = {
        path,
        upsert(message) {
            const prepared = prepareMessage(message);
            if (prepared) inWriteTransaction(() => writePreparedUpsert(prepared));
        },
        upsertMany(messages) {
            if (messages.length === 0) return;
            const preparedById = new Map<string, PreparedHomeSearchMessage>();
            for (const message of messages) {
                const prepared = prepareMessage(message);
                if (!prepared) continue;
                // Preserve singular-upsert semantics when one page contains repeated edits:
                // only the last value for an id survives in both the canonical text table and FTS.
                preparedById.delete(prepared.id);
                preparedById.set(prepared.id, prepared);
            }
            const preparedMessages = [...preparedById.values()];
            if (preparedMessages.length === 0) return;
            inWriteTransaction(() => {
                for (let offset = 0; offset < preparedMessages.length; offset += HOME_SEARCH_WRITE_BATCH_SIZE) {
                    const batch = preparedMessages.slice(offset, offset + HOME_SEARCH_WRITE_BATCH_SIZE);
                    const statements = statementsForBatchSize(batch.length);
                    statements.upsert.run(...batch.flatMap((message) => [
                        message.id,
                        message.sessionId,
                        message.seq,
                        message.createdAtMs,
                        message.updatedAtMs,
                        message.role,
                        message.text,
                    ]));
                    statements.deleteFts.run(...batch.map((message) => message.id));
                    statements.insertFts.run(...batch.flatMap((message) => [
                        message.id,
                        message.sessionId,
                        message.seq,
                        message.createdAtMs,
                        message.role,
                        message.ftsText,
                    ]));
                }
            });
        },
        remove(messageId) {
            db.exec('BEGIN IMMEDIATE');
            try {
                deleteMessage.run(messageId);
                deleteFts.run(messageId);
                db.exec('COMMIT');
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
        removeSession(sessionId) {
            db.exec('BEGIN IMMEDIATE');
            try {
                deleteSessionMessages.run(sessionId);
                deleteSessionFts.run(sessionId);
                db.exec('COMMIT');
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
        clear() {
            db.exec('BEGIN IMMEDIATE');
            try {
                db.exec('DELETE FROM home_search_messages; DELETE FROM home_search_fts;');
                db.exec('COMMIT');
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
        count() {
            const row = countMessages.get() as { count?: number } | undefined;
            return Number(row?.count ?? 0);
        },
        search(input) {
            const parsedQuery = buildFtsQuery(input.query);
            if (!parsedQuery.match) return [];
            const limit = boundedLimit(input.maxResults);
            const queryBatch = (sessionConstraints?: readonly SessionTranscriptPublicationConstraint[]): Array<Record<string, unknown>> => {
                const whereParts: string[] = [];
                const args: HomeSearchSqliteValue[] = [];
                let authorizationCte = '';
                let authorizationJoin = '';
                if (sessionConstraints) {
                    authorizationCte = `WITH authorized_sessions(session_id, maximum_seq) AS (VALUES ${sessionConstraints.map(() => '(?, ?)').join(',')})`;
                    authorizationJoin = 'JOIN authorized_sessions a ON a.session_id = f.session_id';
                    for (const constraint of sessionConstraints) {
                        args.push(constraint.sessionId, constraint.maximumSeq);
                    }
                    whereParts.push('(a.maximum_seq IS NULL OR f.seq <= a.maximum_seq)');
                }
                args.push(parsedQuery.match);
                if (input.sessionId) {
                    whereParts.push('f.session_id = ?');
                    args.push(input.sessionId);
                }
                const where = whereParts.length > 0 ? ` AND ${whereParts.join(' AND ')}` : '';
                args.push(limit);
                return db.prepare(`
                    ${authorizationCte}
                    SELECT f.id, f.session_id AS sessionId, f.seq, f.created_at_ms AS createdAtMs,
                        f.role, m.text, bm25(home_search_fts) AS rank
                    FROM home_search_fts f
                    JOIN home_search_messages m ON m.id = f.id
                    ${authorizationJoin}
                    WHERE home_search_fts MATCH ?${where}
                    ORDER BY rank ASC, f.created_at_ms DESC, f.seq DESC, f.id ASC
                    LIMIT ?
                `).all(...args) as Array<Record<string, unknown>>;
            };

            let rows: Array<Record<string, unknown>>;
            if (input.sessionConstraints) {
                const constraintBySessionId = new Map<string, SessionTranscriptPublicationConstraint>();
                for (const constraint of input.sessionConstraints) {
                    if (!constraint.sessionId) continue;
                    const existing = constraintBySessionId.get(constraint.sessionId);
                    if (!existing) {
                        constraintBySessionId.set(constraint.sessionId, constraint);
                    } else if (existing.maximumSeq === null && constraint.maximumSeq !== null) {
                        constraintBySessionId.set(constraint.sessionId, constraint);
                    } else if (existing.maximumSeq !== null && constraint.maximumSeq !== null) {
                        constraintBySessionId.set(constraint.sessionId, {
                            sessionId: constraint.sessionId,
                            maximumSeq: Math.min(existing.maximumSeq, constraint.maximumSeq),
                        });
                    }
                }
                const constraints = [...constraintBySessionId.values()];
                if (constraints.length === 0) return [];
                rows = [];
                for (let offset = 0; offset < constraints.length; offset += HOME_SEARCH_SESSION_CONSTRAINT_BATCH_SIZE) {
                    rows.push(...queryBatch(constraints.slice(offset, offset + HOME_SEARCH_SESSION_CONSTRAINT_BATCH_SIZE)));
                }
                rows.sort((left, right) => Number(left.rank) - Number(right.rank)
                    || Number(right.createdAtMs) - Number(left.createdAtMs)
                    || Number(right.seq) - Number(left.seq)
                    || String(left.id).localeCompare(String(right.id)));
                rows = rows.slice(0, limit);
            } else {
                rows = queryBatch();
            }

            return rows.map((row) => {
                const rank = Number(row.rank);
                const score = Number.isFinite(rank) ? 1 / (1 + Math.exp(rank)) : 0;
                const seq = Number(row.seq);
                const createdAtMs = Number(row.createdAtMs);
                const text = String(row.text);
                return {
                    id: String(row.id),
                    sessionId: String(row.sessionId),
                    seqFrom: seq,
                    seqTo: seq,
                    createdAtFromMs: createdAtMs,
                    createdAtToMs: createdAtMs,
                    role: typeof row.role === 'string' ? row.role : null,
                    text,
                    snippet: buildSnippet(text, parsedQuery.snippetTerms),
                    score,
                } satisfies HomeSearchHit;
            });
        },
        close() {
            db.close();
        },
    };
    return result;
}
