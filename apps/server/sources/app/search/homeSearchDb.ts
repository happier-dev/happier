import type { SQLInputValue } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

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
    remove(messageId: string): void;
    removeSession(sessionId: string): void;
    clear(): void;
    count(): number;
    setWatermark(sessionId: string, seq: number): void;
    getWatermark(sessionId: string): number;
    search(input: Readonly<{ query: string; sessionId?: string; sessionIds?: readonly string[]; maxResults?: number }>): HomeSearchHit[];
    close(): void;
}>;

function normalizeText(value: string): string {
    return String(value ?? '').replace(/\u0000/gu, '').normalize('NFKC').trim();
}

function ftsQuery(value: string): string {
    const terms = normalizeText(value)
        .split(/\s+/u)
        .map((term) => {
            const prefix = term.endsWith('*');
            const token = term.replace(/\*+$/u, '').replace(/"/gu, '""');
            return token ? `"${token}"${prefix ? '*' : ''}` : '';
        })
        .filter(Boolean);
    return terms.join(' AND ');
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
    let db: InstanceType<(typeof import('node:sqlite'))['DatabaseSync']>;
    try {
        const sqlite = await import('node:sqlite');
        db = new sqlite.DatabaseSync(path);
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
                tokenize = 'unicode61 remove_diacritics 0 tokenchars ''_-$'''
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
    const deleteFts = db.prepare('DELETE FROM home_search_fts WHERE id = ?');
    const insertFts = db.prepare(`
        INSERT INTO home_search_fts(id, session_id, seq, created_at_ms, role, text)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result: HomeSearchDb = {
        path,
        upsert(message) {
            const text = normalizeText(message.text);
            if (!message.id || !message.sessionId || !text) return;
            db.exec('BEGIN IMMEDIATE');
            try {
                upsert.run(
                    message.id,
                    message.sessionId,
                    message.seq,
                    message.createdAtMs,
                    message.updatedAtMs ?? null,
                    message.role ?? null,
                    text,
                );
                deleteFts.run(message.id);
                insertFts.run(message.id, message.sessionId, message.seq, message.createdAtMs, message.role ?? null, text);
                db.exec('COMMIT');
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
        remove(messageId) {
            db.exec('BEGIN IMMEDIATE');
            try {
                db.prepare('DELETE FROM home_search_messages WHERE id = ?').run(messageId);
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
                db.prepare('DELETE FROM home_search_messages WHERE session_id = ?').run(sessionId);
                db.prepare('DELETE FROM home_search_fts WHERE session_id = ?').run(sessionId);
                db.prepare('DELETE FROM home_search_meta WHERE key = ?').run(`watermark:${sessionId}`);
                db.exec('COMMIT');
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
        clear() {
            db.exec('BEGIN IMMEDIATE');
            try {
                db.exec('DELETE FROM home_search_messages; DELETE FROM home_search_fts; DELETE FROM home_search_meta WHERE key LIKE \'watermark:%\';');
                db.exec('COMMIT');
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
        count() {
            const row = db.prepare('SELECT count(*) AS count FROM home_search_messages').get() as { count?: number } | undefined;
            return Number(row?.count ?? 0);
        },
        setWatermark(sessionId, seq) {
            db.prepare(`INSERT INTO home_search_meta(key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(`watermark:${sessionId}`, String(Math.max(0, Math.trunc(seq))));
        },
        getWatermark(sessionId) {
            const row = db.prepare('SELECT value FROM home_search_meta WHERE key = ?').get(`watermark:${sessionId}`) as { value?: string } | undefined;
            const value = Number(row?.value);
            return Number.isSafeInteger(value) && value >= 0 ? value : 0;
        },
        search(input) {
            const query = ftsQuery(input.query);
            if (!query) return [];
            const whereParts: string[] = [];
            const args: SQLInputValue[] = [query];
            if (input.sessionId) {
                whereParts.push('f.session_id = ?');
                args.push(input.sessionId);
            } else if (input.sessionIds) {
                if (input.sessionIds.length === 0) return [];
                whereParts.push(`f.session_id IN (${input.sessionIds.map(() => '?').join(',')})`);
                args.push(...input.sessionIds);
            }
            const where = whereParts.length > 0 ? ` AND ${whereParts.join(' AND ')}` : '';
            args.push(boundedLimit(input.maxResults));
            const rows = db.prepare(`
                SELECT f.id, f.session_id AS sessionId, f.seq, f.created_at_ms AS createdAtMs,
                    f.role, f.text, snippet(home_search_fts, 5, '<mark>', '</mark>', '…', 24) AS snippet,
                    bm25(home_search_fts) AS rank
                FROM home_search_fts f
                WHERE home_search_fts MATCH ?${where}
                ORDER BY rank ASC, f.created_at_ms DESC, f.seq DESC
                LIMIT ?
            `).all(...args) as Array<Record<string, unknown>>;
            return rows.map((row) => {
                const rank = Number(row.rank);
                const score = Number.isFinite(rank) ? 1 / (1 + Math.max(0, rank)) : 0;
                const seq = Number(row.seq);
                const createdAtMs = Number(row.createdAtMs);
                return {
                    id: String(row.id),
                    sessionId: String(row.sessionId),
                    seqFrom: seq,
                    seqTo: seq,
                    createdAtFromMs: createdAtMs,
                    createdAtToMs: createdAtMs,
                    role: typeof row.role === 'string' ? row.role : null,
                    text: String(row.text),
                    snippet: String(row.snippet || row.text),
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
