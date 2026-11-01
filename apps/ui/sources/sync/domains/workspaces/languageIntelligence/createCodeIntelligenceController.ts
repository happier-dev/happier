import type { CodeIntelligenceFallbackInput, CodeIntelligenceFallbackLocation, CodeIntelligenceFallbackResult } from '@happier-dev/protocol/machines/codeIntelligenceFallback';
import type { LanguageIntelligenceQueryResult, LanguageIntelligenceServerStatus, LanguageIntelligenceCapabilities } from '@happier-dev/protocol/machines/languageIntelligence';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { Rect } from '@/components/ui/code/editor/codeEditorTypes';
import { readCodeLineIdentifiers, resolveCodeIdentifier, type CodeIdentifier, type CodeIntelligencePosition } from './codeIdentifiers';
import { createCodeIntelligenceDocument, type CodeIntelligenceServerPort } from './codeIntelligenceDocument';
import { EMPTY_CODE_DIAGNOSTICS, mergeCodeDiagnostics, selectCodeDiagnostics, type CodeDiagnosticsFence } from './codeDiagnostics';
import type { DocumentOutlineServerAnswer } from './documentOutline';

export type CodeIntelligenceSelection = Readonly<{
    position: CodeIntelligencePosition;
    identifier: CodeIdentifier;
    names: readonly CodeIdentifier[];
    anchor?: Rect;
}>;
type InspectionPosition = CodeIntelligencePosition & Readonly<{ anchor?: Rect }>;
export type CodeIntelligenceSnapshot = Readonly<{
    mode: 'fallback' | 'server';
    status: 'idle' | 'searching' | 'loading' | 'ready' | 'unavailable';
    selection: CodeIntelligenceSelection | null;
    /** The result's name stays fixed while the pointer inspects other names. */
    querySelection: CodeIntelligenceSelection | null;
    kind: 'hover' | 'definition' | 'references' | 'diagnostics' | null;
    result: Extract<CodeIntelligenceFallbackResult | LanguageIntelligenceQueryResult, { status: 'ok' }> | null;
    servers?: readonly LanguageIntelligenceServerStatus[];
    capabilities?: LanguageIntelligenceCapabilities;
    diagnostics?: ReturnType<typeof selectCodeDiagnostics>;
    reason?: string;
}>;
export type CodeIntelligenceControllerInput = Readonly<{
    scope: WorkspaceScopeBase;
    path: string;
    languageId: string | null;
    accountLifetime: ServerAccountScopeLifetime;
    getText(): string;
    getUnsaved?(): boolean;
    subscribeText?(listener: () => void): () => void;
    flushPendingChange?(): Promise<void>;
    query(input: CodeIntelligenceFallbackInput, signal: AbortSignal): Promise<CodeIntelligenceFallbackResult>;
    openLocation(location: Pick<CodeIntelligenceFallbackLocation, 'path' | 'range'> & Readonly<{ lineText?: string }>): void | Promise<void>;
    languageServer?: CodeIntelligenceServerPort;
}>;

export function createCodeIntelligenceController(input: CodeIntelligenceControllerInput) {
    let snapshot: CodeIntelligenceSnapshot = { mode: 'fallback', status: 'idle', selection: null, querySelection: null, kind: null, result: null };
    const listeners = new Set<() => void>();
    let pending: AbortController | null = null;
    let disposed = false;
    let lastInspectedText: string | null = null;
    let diagnostics = EMPTY_CODE_DIAGNOSTICS;
    let loadingQuery: { kind: 'hover' | 'definition' | 'references' | 'diagnostics'; position?: CodeIntelligencePosition } | null = null;

    function publish(next: CodeIntelligenceSnapshot): void {
        if (disposed || next === snapshot) return;
        // Before the first pull exists the root projection is idle, but the
        // Problems consumer must already show the user's explicit check. Derive
        // this view state here; do not manufacture diagnostic entries/counts.
        if ((next.kind === 'diagnostics' || snapshot.kind === 'diagnostics')
            && (next.kind !== snapshot.kind || next.status !== snapshot.status || next.diagnostics !== snapshot.diagnostics)) {
            const selected = selectCodeDiagnostics(diagnostics);
            const checking = next.kind === 'diagnostics' && (next.status === 'searching' || next.status === 'loading');
            next = { ...next, diagnostics: checking && selected.state === 'idle'
                ? { ...selected, state: 'checking', count: null } : selected };
        }
        snapshot = next;
        for (const listener of listeners) listener();
    }
    function abortPending(): void {
        pending?.abort();
        pending = null;
        loadingQuery = null;
    }
    function sameSelection(left: CodeIntelligenceSelection | null, right: CodeIntelligenceSelection | null): boolean {
        return left === right || Boolean(left && right && left.position.line === right.position.line
            && left.identifier.startCharacter === right.identifier.startCharacter && left.identifier.endCharacter === right.identifier.endCharacter
            && left.identifier.symbol === right.identifier.symbol && sameAnchor(left.anchor, right.anchor) && left.names.length === right.names.length
            && left.names.every((name, index) => name.symbol === right.names[index].symbol
                && name.startCharacter === right.names[index].startCharacter && name.endCharacter === right.names[index].endCharacter));
    }
    function sameAnchor(left: Rect | undefined, right: Rect | undefined): boolean {
        return left === right || Boolean(left && right && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height);
    }
    function select(text: string, position: InspectionPosition): CodeIntelligenceSelection | null {
        const identifier = resolveCodeIdentifier(text, position, input.languageId);
        if (!identifier) return null;
        const line = text.split(/\r\n|\r|\n/u)[position.line];
        return { position: { line: position.line, character: position.character }, identifier, names: readCodeLineIdentifiers(line, input.languageId),
            ...(position.anchor ? { anchor: position.anchor } : {}) };
    }
    function available(): boolean {
        return !disposed && input.accountLifetime.isCurrent() && input.accountLifetime.scope.serverId === input.scope.serverId;
    }
    function becameReady(previous: readonly LanguageIntelligenceServerStatus[] | undefined, next: readonly LanguageIntelligenceServerStatus[] | undefined): boolean {
        return next?.some(server => {
            if (server.state !== 'ready' || server.loading) return false;
            const before = previous?.find(candidate => candidate.serverId === server.serverId);
            return !before || before.state !== 'ready' || before.loading || before.generation !== server.generation;
        }) ?? false;
    }
    function retire(): void {
        abortPending();
        document?.dispose();
        diagnostics = EMPTY_CODE_DIAGNOSTICS;
        publish({ mode: 'fallback', status: 'unavailable', selection: null, querySelection: null, kind: null, result: null, reason: 'account_unavailable' });
    }
    // The servers that speak for this file, as its own sync last named them (null before the first sync).
    let documentServerIds: ReadonlySet<string> | null = null;
    function diagnosticsFence(servers: readonly LanguageIntelligenceServerStatus[]): CodeDiagnosticsFence {
        const acknowledged = document?.getAcknowledged();
        return {
            documentVersions: new Map(acknowledged ? [[input.path, acknowledged.text === input.getText() ? acknowledged.version : null]] : []),
            serverGenerations: new Map(servers.map(server => [server.serverId, server.generation])),
        };
    }
    const document: ReturnType<typeof createCodeIntelligenceDocument> | null = input.languageServer ? createCodeIntelligenceDocument({
        rootPath: input.scope.rootPath, path: input.path, languageId: input.languageId ?? 'text', port: input.languageServer,
        getText: input.getText, getUnsaved: () => input.getUnsaved?.() ?? false, isCurrent: available,
        onSynchronize: () => {
            const acknowledged = document?.getAcknowledged();
            if (!acknowledged || acknowledged.text === input.getText() || !diagnostics.entries[input.path]) return;
            // Changed coordinates stop being displayable before the remote ack,
            // for typing, presentation switches and queries alike.
            diagnostics = { ...diagnostics, entries: Object.fromEntries(Object.entries(diagnostics.entries).filter(([path]) => path !== input.path)) };
            publish({ ...snapshot, diagnostics: selectCodeDiagnostics(diagnostics) });
        },
        onSync: (response, previousGeneration) => {
            documentServerIds = new Set(response.servers.map(server => server.serverId));
            // A startup watch can precede the first known document version.
            // Revalidate its retained root diagnostics as soon as sync supplies it.
            if (diagnostics.revision >= 0) {
                const revision = previousGeneration !== null && previousGeneration !== response.generation
                    ? EMPTY_CODE_DIAGNOSTICS.revision : diagnostics.revision;
                // A file sync names only its selected servers, not every server
                // in the root. Revalidate this file without retiring other files.
                const otherFiles = Object.fromEntries(Object.entries(diagnostics.entries).filter(([path]) => path !== input.path));
                const currentFile = mergeCodeDiagnostics({ revision,
                    entries: { [input.path]: diagnostics.entries[input.path] ?? {} } }, {
                    status: 'ok', revision, servers: response.servers, diagnostics: {},
                }, diagnosticsFence(response.servers));
                diagnostics = { ...currentFile, entries: { ...otherFiles, ...currentFile.entries } };
            }
            publish({ ...snapshot, mode: 'server', servers: response.servers, capabilities: response.capabilities,
                diagnostics: selectCodeDiagnostics(diagnostics),
                ...(pending && !loadingQuery && snapshot.status === 'loading' ? { status: 'searching' as const } : {}) });
        },
        onWatch: response => {
            const previousServers = snapshot.servers;
            diagnostics = mergeCodeDiagnostics(diagnostics, response, diagnosticsFence(response.servers));
            // The root watch lists every server in the root; the file keeps the ones its sync named.
            const servers = documentServerIds
                ? response.servers.filter(server => documentServerIds?.has(server.serverId))
                : response.servers;
            publish({ ...snapshot, mode: 'server', servers, diagnostics: selectCodeDiagnostics(diagnostics) });
            if (becameReady(previousServers, servers) && loadingQuery) {
                const retry = loadingQuery; loadingQuery = null;
                void query(retry.kind, retry.position);
            }
        },
        onUnavailable: reason => publish({ ...snapshot, status: reason === 'loading' ? 'loading' : 'unavailable', reason }),
    }) : null;
    const retirement = input.accountLifetime.onRetire(retire);
    const stopText = input.subscribeText?.(() => { void document?.synchronize().catch(() => {
        if (available()) publish({ ...snapshot, status: 'unavailable', reason: 'transport_failed' });
    }); });

    async function query(kind: 'hover' | 'definition' | 'references' | 'diagnostics', position?: CodeIntelligencePosition): Promise<void> {
        if (!available()) { if (!disposed) retire(); return; }
        abortPending();
        const request = new AbortController();
        pending = request;
        try {
            if (input.flushPendingChange) await input.flushPendingChange();
            if (request.signal.aborted || !available()) return;
            const text = input.getText();
            const selection = position ? select(text, position) : null;
            if (!selection && kind !== 'diagnostics') {
                publish({ ...snapshot, status: 'idle', selection: null, querySelection: null, kind: null, result: null, reason: undefined });
                return;
            }
            const prior = sameSelection(snapshot.querySelection, selection) && snapshot.kind === kind ? snapshot.result : null;
            const starting = document && !document.isActivated();
            publish({ ...snapshot, ...(starting ? { mode: 'server' as const } : {}), status: starting ? 'loading' : 'searching',
                selection, querySelection: selection, kind, result: prior, reason: undefined });
            if (document) {
                const serversAtIssue = snapshot.servers;
                const response = await document.query(kind, position, request.signal);
                if (request.signal.aborted || !available()) return;
                if (text !== input.getText()) { publish({ ...snapshot, status: 'idle', result: null }); return; }
                if (response?.status === 'ok') {
                    publish({ ...snapshot, mode: 'server', status: 'ready', kind, result: response, reason: undefined });
                    if (response.kind === 'definition') {
                        const target = response.locations.find(location => !location.outsideWorkspace);
                        if (target) await input.openLocation(target);
                    }
                    return;
                }
                if (response?.status === 'loading') {
                    loadingQuery = { kind, position };
                    publish({ ...snapshot, mode: 'server', status: 'loading', result: null });
                    // Progress can end before the response that was issued while loading.
                    if (becameReady(serversAtIssue, snapshot.servers)) {
                        loadingQuery = null;
                        void query(kind, position);
                    }
                    return;
                }
                if (response?.status === 'error' && (response.errorCode === 'stale_query' || response.errorCode === 'cancelled')) {
                    publish({ ...snapshot, status: 'idle', result: null }); return;
                }
                if (response?.status !== 'unavailable' || response.reason !== 'no_capable_server' || (kind !== 'definition' && kind !== 'references')) {
                    if (response) publish({ ...snapshot, mode: 'server', status: 'unavailable', result: null,
                        reason: response.status === 'error' ? response.errorCode : response.status === 'unavailable' ? response.reason : 'session_unavailable' });
                    return;
                }
            }
            if ((kind !== 'definition' && kind !== 'references') || !position || !selection) {
                publish({ ...snapshot, mode: 'fallback', status: 'unavailable', result: null, reason: 'no_capable_server' }); return;
            }
            const response = await input.query({
                rootPath: input.scope.rootPath, path: input.path, kind,
                line: position.line + 1, symbol: selection.identifier.symbol,
                ...(input.languageId ? { languageId: input.languageId } : {}),
            }, request.signal);
            if (request.signal.aborted || !available()) return;
            if (text !== input.getText()) {
                publish({ ...snapshot, status: 'idle', selection: null, querySelection: null, kind: null, result: null, reason: undefined });
                return;
            }
            if (response.status !== 'ok') {
                publish({ ...snapshot, mode: 'fallback', status: 'unavailable', selection: snapshot.selection, querySelection: selection, kind, result: null, reason: response.reason });
                return;
            }
            publish({ ...snapshot, mode: 'fallback', status: 'ready', selection: snapshot.selection, querySelection: selection, kind, result: response, reason: undefined });
            if (kind === 'definition' && response.locations[0]) await input.openLocation(response.locations[0]);
        } catch {
            if (!request.signal.aborted && available()) publish({ ...snapshot, status: 'unavailable', kind, result: null, reason: 'transport_failed' });
        } finally {
            if (pending === request) pending = null;
        }
    }
    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        inspect: (position: InspectionPosition | null): void => {
            if (!available()) return;
            const text = input.getText();
            const previous = snapshot.selection;
            // Pointer motion within one unchanged token does not retokenize the document.
            if (text === lastInspectedText && position && previous && previous.position.line === position.line
                && position.character >= previous.identifier.startCharacter && position.character <= previous.identifier.endCharacter
                && sameAnchor(position.anchor, previous.anchor)) return;
            lastInspectedText = text;
            const selection = position ? select(text, position) : null;
            if (!sameSelection(snapshot.selection, selection)) publish({ ...snapshot, selection });
        },
        definition: (position: CodeIntelligencePosition) => query('definition', position),
        references: (position: CodeIntelligencePosition) => query('references', position),
        hover: (position: CodeIntelligencePosition) => query('hover', position),
        checkProblems: () => query('diagnostics'),
        syncDocument: () => document?.synchronize() ?? Promise.resolve(null),
        external: (paths: readonly string[]) => snapshot.capabilities?.acceptsExternalChanges ? document?.external(paths) ?? Promise.resolve() : Promise.resolve(),
        getDiagnosticsProjection: () => diagnostics,
        async problem(direction: 1 | -1, position?: CodeIntelligencePosition): Promise<boolean> {
            if (!available()) return false;
            const items = [...selectCodeDiagnostics(diagnostics, undefined, { currentOnly: true }).items].sort((left, right) => (
                left.path < right.path ? -1 : left.path > right.path ? 1
                    : left.range.start.line - right.range.start.line || left.range.start.character - right.range.start.character
            ));
            if (!items.length) return false;
            const anchor = position ?? snapshot.selection?.position;
            const after = (item: typeof items[number]) => item.path > input.path || (item.path === input.path && anchor !== undefined
                && (item.range.start.line > anchor.line || (item.range.start.line === anchor.line && item.range.start.character > anchor.character)));
            const before = (item: typeof items[number]) => item.path < input.path || (item.path === input.path && anchor !== undefined
                && (item.range.start.line < anchor.line || (item.range.start.line === anchor.line && item.range.start.character < anchor.character)));
            const target = !anchor ? direction === 1 ? items[0] : items[items.length - 1]
                : direction === 1 ? items.find(after) ?? items[0] : [...items].reverse().find(before) ?? items[items.length - 1];
            await input.openLocation(target);
            return true;
        },
        async outline(signal = new AbortController().signal): Promise<DocumentOutlineServerAnswer | null> {
            if (!document?.isActivated() || !available() || !snapshot.capabilities?.documentSymbol) return null;
            if (input.flushPendingChange) await input.flushPendingChange();
            const text = input.getText();
            const response = await document.query('documentSymbols', undefined, signal, false);
            if (!available() || signal.aborted || input.getText() !== text || response?.status !== 'ok' || response.kind !== 'documentSymbols') return null;
            // This is the answer's authority context, not the root's runtime state:
            // queryAll returns ok for nonempty symbols or a confirmed empty answer.
            // An unrelated incapable/failed server must not overturn that decision.
            return { capable: true, symbols: response.symbols, state: 'ready', loading: false };
        },
        async restart() {
            if (!document) return { status: 'unavailable' as const, reason: 'session_unavailable' as const };
            // P7-R11: the restart is said at once ("Starting …" through the one state note); the sync that
            // follows a successful restart names what came back, and a refused restart leaves things as they were.
            const before = snapshot.servers;
            const restarting = before?.map(server => ({ ...server, state: 'restarting' as const, loading: false }));
            if (restarting?.length && available()) publish({ ...snapshot, servers: restarting });
            const response = await document.restart();
            if (response.status !== 'ok' && available() && snapshot.servers === restarting) publish({ ...snapshot, servers: before });
            return response;
        },
        cancel: (): void => { abortPending(); if (snapshot.status === 'searching' || snapshot.status === 'loading') publish({ ...snapshot, status: snapshot.result ? 'ready' : 'idle' }); },
        dismiss: (): void => {
            abortPending();
            if (snapshot.status === 'idle' && snapshot.selection === null && snapshot.querySelection === null
                && snapshot.kind === null && snapshot.result === null && snapshot.reason === undefined) return;
            publish({ ...snapshot, status: 'idle', selection: null, querySelection: null, kind: null, result: null, reason: undefined });
        },
        dispose: (): void => { abortPending(); stopText?.(); document?.dispose(); retirement.dispose(); disposed = true; listeners.clear(); },
    };
}
export type CodeIntelligenceController = ReturnType<typeof createCodeIntelligenceController>;
