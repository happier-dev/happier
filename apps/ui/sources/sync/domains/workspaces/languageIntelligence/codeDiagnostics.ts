import type { LanguageIntelligenceDiagnostic, LanguageIntelligenceWatchResult } from '@happier-dev/protocol/machines/languageIntelligence';
import type { CodeEditorHandle, EditorDecoration } from '@/components/ui/code/editor/codeEditorTypes';

type Watch = Extract<LanguageIntelligenceWatchResult, { status: 'ok' }>;
type DiagnosticEntry = Watch['diagnostics'][string][string] & Readonly<{ stale?: true }>;
export type CodeDiagnosticsProjection = Readonly<{ revision: number; entries: Readonly<Record<string, Readonly<Record<string, DiagnosticEntry>>>> }>;
/** null means the selected text has no acknowledged version yet; absence means no held document. */
export type CodeDiagnosticsFence = Readonly<{ documentVersions: ReadonlyMap<string, number | null>; serverGenerations: ReadonlyMap<string, string> }>;
export const EMPTY_CODE_DIAGNOSTICS: CodeDiagnosticsProjection = { revision: -1, entries: {} };

function sameDiagnosticEntry(left: DiagnosticEntry, right: DiagnosticEntry): boolean {
    return left === right || left.state === right.state && left.version === right.version && left.generation === right.generation
        && left.stale === right.stale && left.items.length === right.items.length && left.items.every((item, index) => {
            const next = right.items[index];
            return item === next || item.serverId === next.serverId && item.path === next.path && item.severity === next.severity
                && item.message === next.message && item.code === next.code && item.source === next.source
                && item.range.start.line === next.range.start.line && item.range.start.character === next.range.start.character
                && item.range.end.line === next.range.end.line && item.range.end.character === next.range.end.character;
        });
}

export function mergeCodeDiagnostics(previous: CodeDiagnosticsProjection, update: Watch, fence: CodeDiagnosticsFence): CodeDiagnosticsProjection {
    if (update.revision < previous.revision) return previous;
    type Entry = DiagnosticEntry;
    const current = (path: string, serverId: string, entry: Entry) => {
        const version = fence.documentVersions.get(path);
        return (version === undefined || version === entry.version) && fence.serverGenerations.get(serverId) === entry.generation;
    };
    const failed = new Set(update.servers.filter((server) => fence.serverGenerations.get(server.serverId) === server.generation
        && (server.state === 'crashed' || server.state === 'stopped' || server.state === 'unavailable')).map((server) => server.serverId));
    const paths = new Map<string, Map<string, Entry>>();
    for (const [path, servers] of Object.entries(previous.entries)) {
        const entries = new Map<string, Entry>();
        for (const [serverId, entry] of Object.entries(servers)) {
            if (failed.has(serverId) || fence.serverGenerations.get(serverId) !== entry.generation) continue;
            if (current(path, serverId, entry)) entries.set(serverId, entry);
            else {
                const version = fence.documentVersions.get(path);
                // Retain last-known problems, but never use their old coordinates
                // in a changed document or treat an unconfirmed version as empty.
                if (version === null || (version !== undefined && entry.version < version))
                    entries.set(serverId, entry.stale ? entry : { ...entry, state: 'checking', stale: true });
            }
        }
        if (entries.size) paths.set(path, entries);
    }
    for (const [path, servers] of Object.entries(update.diagnostics)) {
        for (const [serverId, entry] of Object.entries(servers)) {
            if (failed.has(serverId) || !current(path, serverId, entry)) continue;
            let entries = paths.get(path);
            if (!entries) { entries = new Map(); paths.set(path, entries); }
            const prior = entries.get(serverId);
            entries.set(serverId, prior && sameDiagnosticEntry(prior, entry) ? prior : entry);
        }
    }
    const reconciled = [...paths].map(([path, servers]) => {
        const prior = previous.entries[path];
        return [path, prior && Object.keys(prior).length === servers.size
            && [...servers].every(([serverId, entry]) => prior[serverId] === entry) ? prior : Object.fromEntries(servers)] as const;
    });
    const entries = Object.keys(previous.entries).length === reconciled.length
        && reconciled.every(([path, servers]) => previous.entries[path] === servers) ? previous.entries : Object.fromEntries(reconciled);
    return entries === previous.entries && update.revision === previous.revision ? previous : { revision: update.revision, entries };
}

function diagnosticKey(item: LanguageIntelligenceDiagnostic): string {
    return JSON.stringify([item.path, item.range.start.line, item.range.start.character, item.range.end.line, item.range.end.character,
        item.severity, item.code ?? null, item.message]);
}

/** The same diagnostic identity governs open-document and explicitly checked project results. */
export function selectCodeDiagnosticItems(items: readonly LanguageIntelligenceDiagnostic[], state: 'idle' | 'ready' | 'checking' | 'unavailable') {
    const unique = [...new Map(items.map(item => [diagnosticKey(item), item])).values()];
    return { state, items: unique, count: state === 'ready' ? unique.length : null };
}

export function selectCodeDiagnostics(projection: CodeDiagnosticsProjection, path?: string, options?: Readonly<{ currentOnly: boolean }>): Readonly<{
    state: 'idle' | 'ready' | 'checking' | 'unavailable'; items: readonly LanguageIntelligenceDiagnostic[]; count: number | null;
}> {
    const entries = (path === undefined ? Object.keys(projection.entries).sort() : [path])
        .flatMap((filePath) => Object.entries(projection.entries[filePath] ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([, entry]) => entry))
        .filter(entry => !options?.currentOnly || !entry.stale);
    const state = !entries.length ? 'idle' : entries.some((entry) => entry.state === 'checking') ? 'checking'
        : entries.some((entry) => entry.state === 'unavailable') ? 'unavailable' : 'ready';
    return selectCodeDiagnosticItems(entries.flatMap((entry) => entry.items), state);
}

export function projectCodeDiagnosticDecorations(projection: CodeDiagnosticsProjection, path: string): readonly EditorDecoration[] {
    return selectCodeDiagnostics(projection, path, { currentOnly: true }).items.map((item) => ({
        layer: 'diagnostic', id: diagnosticKey(item), severity: item.severity,
        startLine: item.range.start.line + 1, startCharacter: item.range.start.character,
        endLine: item.range.end.line + 1, endCharacter: item.range.end.character,
        message: item.message, ...(item.code === undefined ? {} : { code: item.code }), ...(item.source ? { source: item.source } : {}),
    }));
}

export function bindCodeDiagnosticDecorations(input: Readonly<{
    handle: Pick<CodeEditorHandle, 'setDecorations'>; path: string;
    getProjection(): CodeDiagnosticsProjection; subscribe(listener: () => void): () => void;
}>): () => void {
    let previous: CodeDiagnosticsProjection['entries'][string] | undefined | null = null;
    let disposed = false;
    const publish = () => {
        if (disposed) return;
        const projection = input.getProjection();
        const entry = projection.entries[input.path];
        if (previous === entry) return;
        previous = entry;
        input.handle.setDecorations('diagnostic', projectCodeDiagnosticDecorations(projection, input.path));
    };
    const unsubscribe = input.subscribe(publish);
    publish();
    return () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        input.handle.setDecorations('diagnostic', []);
    };
}
