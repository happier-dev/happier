import { createHash } from 'node:crypto';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ManagedServiceNativeLogReadV1, ManagedServiceNativeLogResultV1 } from '@happier-dev/plugin-sdk/managed-services';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createJournalExportPage } from './journalExport.js';

export type JournalSelection = Readonly<{ scope: 'user' | 'system'; unit: string }>;
type Position = Readonly<{ cursor: string; offset: number; after: boolean }>;
const journal = { kind: 'systemTool', id: 'journalctl' } as const;
const unavailable = { kind: 'unavailable', reason: 'unavailable' } as const;
export const journalDenied = { kind: 'unavailable', reason: 'denied', recipeRemedy: {
    pluginId: 'happier.machine.recipes', recipeId: 'journal-reader', revision: '1',
} } as const;

function failure(result: PluginProcessResult, signal?: AbortSignal): Extract<ManagedServiceNativeLogResultV1, { kind: 'unavailable' }> | null {
    if (signal?.aborted || result.termination.requestedBy.kind === 'abort') return { kind: 'unavailable', reason: 'cancelled' };
    if (/insufficient permissions|Permission denied|You are currently not seeing messages from/u.test(new TextDecoder().decode(result.stderr))) return journalDenied;
    if (result.termination.requestedBy.kind !== 'none' || result.termination.observed.kind !== 'exit'
        || result.termination.observed.exitCode !== 0 || result.stderrTruncated) return unavailable;
    return null;
}

function position(token: string): Position | null {
    try {
        const value: unknown = JSON.parse(token);
        if (typeof value !== 'object' || value === null || !('v' in value) || value.v !== 1
            || !('cursor' in value) || typeof value.cursor !== 'string' || !value.cursor
            || !('offset' in value) || typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0
            || !('after' in value) || typeof value.after !== 'boolean') return null;
        return { cursor: value.cursor, offset: value.offset, after: value.after };
    } catch { return null; }
}

/** Header identity is a source observation, not an access probe: native File IDs
 * change on rotation while sequential IDs and append timestamps do not.
 * journalctl's header and export commands share the exact manager/unit selection. */
export async function observeJournalSource(selected: JournalSelection, signal: AbortSignal | undefined, context: PluginInvocationContext) {
    const result = await context.services.exec.run({ executable: journal,
        args: [`--${selected.scope}`, `--unit=${selected.unit}`, '--no-pager', '--header'], env: { LC_ALL: 'C' } }, { signal });
    const failed = failure(result, signal);
    if (failed) return { kind: 'failure' as const, result: failed };
    if (result.stdoutTruncated) return { kind: 'failure' as const, result: unavailable };
    const files: { path: string; file: string; boot: string }[] = [];
    for (const section of new TextDecoder().decode(result.stdout).split(/(?=^File path: )/mu)) {
        const path = /^File path: (.+)$/mu.exec(section)?.[1];
        const file = /^File ID: ([a-f0-9]{32})$/mu.exec(section)?.[1];
        const boot = /^Boot ID: ([a-f0-9]{32})$/mu.exec(section)?.[1];
        if (path && file && boot) files.push({ path, file, boot });
    }
    if (!files.length) return { kind: 'failure' as const, result: unavailable };
    const sourceRevision = createHash('sha256').update(JSON.stringify([selected, files.sort((a, b) => a.path.localeCompare(b.path))])).digest('hex');
    return { kind: 'source' as const, sourceRevision, files };
}

export async function readJournal(selected: JournalSelection, request: ManagedServiceNativeLogReadV1,
    context?: PluginInvocationContext): Promise<ManagedServiceNativeLogResultV1> {
    if (process.platform !== 'linux') return { kind: 'unavailable', reason: 'unsupported' };
    if (!context) return { kind: 'unavailable', reason: 'admission_unavailable' };
    if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1) return unavailable;
    const initial = await observeJournalSource(selected, request.signal, context);
    if (initial.kind === 'failure') return initial.result;
    if (request.cursor && request.cursor.sourceRevision !== initial.sourceRevision)
        return { kind: 'source-changed', sourceRevision: initial.sourceRevision };
    const result = await readJournalContent(selected, request, initial.sourceRevision, context);
    if (result.kind !== 'page') return result;
    const current = await observeJournalSource(selected, request.signal, context);
    if (current.kind === 'failure') return current.result;
    return current.sourceRevision !== initial.sourceRevision
        ? { kind: 'source-changed', sourceRevision: current.sourceRevision } : result;
}

/** One byte/cursor codec for finite reads and demanded watch continuation. */
export async function readJournalContent(selected: JournalSelection, request: ManagedServiceNativeLogReadV1,
    sourceRevision: string, context: PluginInvocationContext): Promise<ManagedServiceNativeLogResultV1> {
    const resume = request.cursor ? position(request.cursor.token) : undefined;
    if (resume === null) return unavailable;
    const page = createJournalExportPage(request.maxBytes, resume);
    const child = await context.services.exec.spawn({ executable: journal,
        args: [`--${selected.scope}`, `--unit=${selected.unit}`, '--no-pager', '--output=export', '--all',
            ...(resume ? [`--${resume.after ? 'after-cursor' : 'cursor'}=${resume.cursor}`] : [])],
        env: { LC_ALL: 'C' }, maxStdoutBytes: 0,
    }, { signal: request.signal });
    let stopped: Promise<void> | undefined;
    const output = child.onOutput(chunk => {
        if (chunk.stream !== 'stdout' || stopped) return;
        page.push(chunk.data);
        if (page.done) stopped = child.dispose();
    });
    let result: PluginProcessResult;
    try { result = await child.wait(); }
    finally { await output.dispose(); await (stopped ?? child.dispose()); }
    const value = page.result();
    if (request.signal?.aborted) return { kind: 'unavailable', reason: 'cancelled' };
    const failed = failure(result, request.signal);
    if (!value || value.truncated && !value.text || result.stderrTruncated || failed && (failed.reason === 'denied'
        || !(stopped && result.termination.requestedBy.kind === 'dispose'))) return failed ?? unavailable;
    return { kind: 'page', page: { sourceRevision, text: value.text,
        nextCursor: value.next ? { sourceRevision, token: JSON.stringify({ v: 1, ...value.next }) } : null,
        truncated: value.truncated } };
}
