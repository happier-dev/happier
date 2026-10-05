import { z } from 'zod';
import type { FindOptions, FindStatus } from '@happier-dev/plugin-ui/presentation';
import type { FindEngine, TerminalFindSnapshot } from '../../embedded/embeddedTerminalRendererHandle';

export type XtermFindRequest =
    | Readonly<{ type: 'find.set'; payload: { revision: number; query: string; options: FindOptions } }>
    | Readonly<{ type: 'find.step'; payload: { revision: number; direction: 1 | -1 } }>
    | Readonly<{ type: 'find.close'; payload: { revision: number } }>;

// Validate the guest's terminal-only projection at the actual transport boundary.
// This narrows the shared FindStatus contract; it makes no matching/coverage decisions.
const StatusSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('idle') }).strict(),
    z.object({ kind: z.literal('invalidPattern') }).strict(),
    z.object({ kind: z.literal('results'), current: z.number().int().positive().nullable(), total: z.number().int().nonnegative(), coverage: z.enum(['complete', 'loaded', 'limited']) }).strict(),
]);
const ResultSchema = z.object({ revision: z.number().int().nonnegative(), status: StatusSchema, retainedLines: z.number().int().nonnegative() }).strict();
export type XtermFindResult = z.infer<typeof ResultSchema>;

/** Transport facade; all matching, decoration and selection remain in the guest engine. */
export function createWebViewFindEngine(send: (request: XtermFindRequest) => void) {
    let snapshot: TerminalFindSnapshot = { open: false, query: '', options: { regex: false, matchCase: false }, status: { kind: 'idle' }, retainedLines: 0 };
    let revision = 0;
    const listeners = new Set<() => void>();
    const publish = (next: TerminalFindSnapshot) => { snapshot = next; for (const listener of listeners) listener(); };
    const set = () => {
        if (!snapshot.open) return;
        send({ type: 'find.set', payload: { revision: ++revision, query: snapshot.query, options: snapshot.options } });
    };
    const retire = () => { ++revision; publish({ ...snapshot, open: false, status: { kind: 'idle' } }); };
    const engine: FindEngine = {
        get query() { return snapshot.query; }, get options() { return snapshot.options; }, get status() { return snapshot.status; },
        capabilities: { regex: true, stop: false }, getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        open: () => { publish({ ...snapshot, open: true }); set(); },
        setQuery: (query) => { publish({ ...snapshot, query, status: { kind: 'idle' } }); set(); },
        setOptions: (options) => { publish({ ...snapshot, options }); set(); },
        step: (direction) => { if (snapshot.open) send({ type: 'find.step', payload: { revision: ++revision, direction } }); },
        stop: () => {}, close: () => { retire(); send({ type: 'find.close', payload: { revision } }); },
    };
    return { engine, retire, accept: (payload: unknown) => {
        const parsed = ResultSchema.safeParse(payload);
        if (!parsed.success || !snapshot.open || parsed.data.revision !== revision) return;
        const status: FindStatus = parsed.data.status;
        publish({ ...snapshot, status, retainedLines: parsed.data.retainedLines });
    } };
}
