import { openHomeSearchDb, type HomeSearchDb, type HomeSearchMessage } from './homeSearchDb';

export type HomeSearchCanonicalMessage = Readonly<{
    id: string;
    sessionId: string;
    seq: number;
    createdAtMs: number;
    updatedAtMs?: number;
    role?: string | null;
    content: unknown;
}>;

export type HomeSearchCanonicalReader = () => Promise<readonly HomeSearchCanonicalMessage[]>;

function readSearchableText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!content || typeof content !== 'object') return '';
    const value = content as Record<string, unknown>;
    if (value.t === 'plain') return readSearchableText(value.v);
    if (typeof value.text === 'string') return value.text;
    if (typeof value.message === 'string') return value.message;
    if (Array.isArray(value.content)) return value.content.map(readSearchableText).filter(Boolean).join('\n');
    return '';
}

function toIndexedMessage(message: HomeSearchCanonicalMessage): HomeSearchMessage {
    return {
        id: message.id,
        sessionId: message.sessionId,
        seq: message.seq,
        createdAtMs: message.createdAtMs,
        updatedAtMs: message.updatedAtMs,
        role: message.role,
        text: readSearchableText(message.content),
    };
}

export type HomeSearchIndexer = Readonly<{
    reconcile(): Promise<{ indexed: number; removed: number }>;
    notify(message: HomeSearchCanonicalMessage): void;
    removeSession(sessionId: string): void;
    start(): void;
    stop(): void;
    close(): void;
}>;

export async function createHomeSearchIndexer(params: Readonly<{
    dbPath: string;
    readCanonicalMessages: HomeSearchCanonicalReader;
    intervalMs?: number;
}>): Promise<HomeSearchIndexer> {
    const db = await openHomeSearchDb({ dbPath: params.dbPath });
    let timer: ReturnType<typeof setInterval> | null = null;
    let reconcileInFlight: Promise<{ indexed: number; removed: number }> | null = null;

    const reconcile = async (): Promise<{ indexed: number; removed: number }> => {
        if (reconcileInFlight) return reconcileInFlight;
        reconcileInFlight = (async () => {
            const rows = await params.readCanonicalMessages();
            const previousCount = db.count();
            const indexedIds = new Set<string>();
            db.clear();
            const watermarks = new Map<string, number>();
            for (const row of rows) {
                const message = toIndexedMessage(row);
                if (!message.text.trim()) continue;
                db.upsert(message);
                indexedIds.add(message.id);
                watermarks.set(message.sessionId, Math.max(watermarks.get(message.sessionId) ?? 0, message.seq));
            }
            for (const [sessionId, seq] of watermarks) db.setWatermark(sessionId, seq);
            return { indexed: indexedIds.size, removed: Math.max(0, previousCount - indexedIds.size) };
        })().finally(() => {
            reconcileInFlight = null;
        });
        return reconcileInFlight;
    };

    return {
        reconcile,
        notify(message) {
            // Notifications are deliberately fire-and-forget: transcript writes must not wait
            // on the rebuildable derived index. Startup reconciliation remains the durable path.
            queueMicrotask(() => {
                try {
                    const indexed = toIndexedMessage(message);
                    if (indexed.text.trim()) db.upsert(indexed);
                    db.setWatermark(indexed.sessionId, indexed.seq);
                } catch {
                    // A later reconciliation repairs failed best-effort notifications.
                }
            });
        },
        removeSession(sessionId) {
            db.removeSession(sessionId);
        },
        start() {
            if (timer) return;
            const intervalMs = Math.max(1_000, Math.trunc(params.intervalMs ?? 30_000));
            timer = setInterval(() => {
                void reconcile().catch(() => undefined);
            }, intervalMs);
            void reconcile().catch(() => undefined);
        },
        stop() {
            if (!timer) return;
            clearInterval(timer);
            timer = null;
        },
        close() {
            if (timer) clearInterval(timer);
            timer = null;
            db.close();
        },
    };
}

/** Exposed for the service and tests without making the content parser public API. */
export function extractHomeSearchText(content: unknown): string {
    return readSearchableText(content);
}
