import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { LanguageIntelligenceCommandSchema, type DaemonLspApplyRequest, type DaemonLspApplyResponse, type DaemonLspSyncRequest, type DaemonLspSyncResponse, type DaemonLspQueryRequest, type DaemonLspQueryResponse, type DaemonLspWatchRequest, type DaemonLspWatchResponse, type DaemonLspRestartRequest, type DaemonLspRestartResponse, type LanguageIntelligenceCapabilities, type LanguageIntelligenceDiagnostic, type LanguageIntelligenceDiagnosticsEntry, } from '@happier-dev/protocol/machines/languageIntelligence';
import type { WorkspaceFileEditSetFile, DaemonWorkspaceFileReplaceApplyResponse } from '@happier-dev/protocol/machines/workspaceFiles';
import { MachineProcessesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { MACHINE_WATCH_WINDOW_MS } from '@happier-dev/protocol/rpc/machineWatchWindow';
import { getFileLanguageFromPath } from '@happier-dev/protocol/machines/fileLanguage';
import { armDeadlineTimer } from '@happier-dev/protocol/common/deadlineTimer';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import type { MachineResourcesPolicyReader } from '@/processes/toolIdleTimeouts';
import { parkWatch } from '@/daemon/lifecycle/parkWatch';
import { resolveCanonicalAbsolutePathComparisonIdentity } from '@/utils/path/expandHomeDirPath';
import { logger } from '@/ui/logger';
import type { HappierProcessRootSource } from '@/daemon/processes/roots/listHappierProcessRoots';
import { createLanguageServerDefinitions, type LanguageServerDefinition } from './languageServerDefinitions';
import type { ReadLanguageServerInitializationOptions } from './managedProtocol';
import { createServerSession, LanguageServerSessionError, normalizeLanguageServerDocumentVersion, type OpenLanguageServerProtocol, type ServerSession, type ServerSessionAnswer } from './serverSession';
import { applyWorkspaceFileTextEdits, LspDocumentTextError, readDocumentLine, resolveDocumentPosition } from './documentText';
import { LspWorkspacePathError, resolveWorkspacePath, workspaceUriToPath, workspacePathToUri } from './workspaceUris';
import { resolveLanguageServerRoot } from './rootResolution';
import { normalizeLspDocumentSymbols, normalizeLspHover, normalizeLspDiagnostics, readLspObject, readLspRange, readLspList } from './languageServerResults';
import { createCompletionNormalizer, normalizeSignatureHelp, normalizeInlayHint, normalizeSemanticTokens, normalizeCallHierarchyItem } from './languageServerEditingResults';
import { runLanguageServerProjectCheck, readLanguageServerProjectCheckProcessRoots } from './projectCheck';
import { LspWorkspaceEditError, normalizeWorkspaceEdit } from './workspaceEdit';
import { applyWorkspaceFileReplace } from '@/rpc/handlers/workspaceFileReplace';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
type RequestContext = Readonly<{
    signal?: AbortSignal;
    assertCurrentAuthority?: () => Promise<void>;
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
}>;
/** Native arguments can contain absolute URIs and remain inside the host. */
function readCodeActionCommand(value: Record<string, unknown>) {
    const command = typeof value.command === 'string' ? value : readLspObject(value.command);
    return command ? LanguageIntelligenceCommandSchema.parse({ command: command.command,
        ...(command.arguments !== undefined ? { arguments: command.arguments } : {}) }) : undefined;
}
export type LanguageServerHost = Readonly<{
    readProcessRoots(): readonly HappierProcessRootSource[];
    sync(input: DaemonLspSyncRequest, context?: RequestContext): Promise<DaemonLspSyncResponse>;
    query(input: DaemonLspQueryRequest, context?: RequestContext): Promise<DaemonLspQueryResponse>;
    apply(input: DaemonLspApplyRequest, context?: RequestContext): Promise<DaemonLspApplyResponse>;
    watch(input: DaemonLspWatchRequest, context?: RequestContext): Promise<DaemonLspWatchResponse>;
    restart(input: DaemonLspRestartRequest, context?: RequestContext): Promise<DaemonLspRestartResponse>;
    dispose(): Promise<void>;
}>;
export type LanguageServerHostOptions = Readonly<{
    readCurrentContributionRegistry?: () => ResolvedContributionRegistry | null | undefined;
    openProtocol?: OpenLanguageServerProtocol;
    readInitializationOptions?: ReadLanguageServerInitializationOptions;
    projectChecker?: Readonly<{
        run: typeof runLanguageServerProjectCheck;
        readProcessRoots: typeof readLanguageServerProjectCheckProcessRoots;
    }>;
    readPolicy?: MachineResourcesPolicyReader;
    platform?: NodeJS.Platform;
}>;
type RootDocument = {
    languageId: string;
    references: number;
    sessions: Set<string>;
};
type RootState = {
    path: string;
    generation: string;
    revision: number;
    documents: Map<string, RootDocument>;
    sessions: Set<string>;
    listeners: Set<() => void>;
    watchers: number;
    diagnostics: Map<string, Map<string, {
        revision: number;
        entry: LanguageIntelligenceDiagnosticsEntry;
    }>>;
};
type HostedSession = {
    session: ServerSession;
    closing?: Promise<void>;
    timer: (() => void) | undefined;
    lastActivity: number;
    activeOperations: number;
};
type QueryOk = Extract<DaemonLspQueryResponse, {
    status: 'ok';
    kind: Exclude<DaemonLspQueryRequest['kind'], 'ai.inlineSuggest' | 'ai.nextEdit'>;
}>;
const emptyCapabilities = (): LanguageIntelligenceCapabilities => ({ hover: false, definition: false, references: false, documentSymbol: false, diagnostics: 'none', acceptsExternalChanges: false });
function combineCapabilities(sessions: readonly ServerSession[]): LanguageIntelligenceCapabilities {
    const all = sessions.map(s => s.capabilities());
    const booleans = ['hover', 'definition', 'references', 'documentSymbol', 'acceptsExternalChanges', 'rename', 'prepareRename', 'fileRename', 'codeAction',
        'completion', 'completionResolve', 'signatureHelp', 'formatting', 'rangeFormatting', 'organizeImports', 'typeDefinition', 'implementation', 'documentHighlight',
        'selectionRange', 'inlayHint', 'semanticTokensRange', 'semanticTokensDelta', 'callHierarchy', 'workspaceSymbol', 'workspaceDiagnostics'] as const;
    const combined = { ...emptyCapabilities(), ...Object.fromEntries(booleans.map(name => [name, all.some(c => c[name] === true)])) };
    return { ...combined, diagnostics: all.some(c => c.diagnostics === 'pull') ? 'pull' : all.some(c => c.diagnostics === 'push') ? 'push' : 'none',
        completionTriggerCharacters: [...new Set(all.flatMap(c => c.completionTriggerCharacters ?? []))],
        signatureTriggerCharacters: [...new Set(all.flatMap(c => c.signatureTriggerCharacters ?? []))],
        signatureRetriggerCharacters: [...new Set(all.flatMap(c => c.signatureRetriggerCharacters ?? []))] };
}
function unique<T>(items: T[], key: (item: T) => string): T[] { const seen = new Set<string>(); return items.filter(item => { const k = key(item); if (seen.has(k))
    return false; seen.add(k); return true; }); }
async function mergeEditSets(rootPath: string, platform: NodeJS.Platform, files: readonly WorkspaceFileEditSetFile[], heldText?: (path: string) => string | undefined): Promise<WorkspaceFileEditSetFile[]> {
    const merged = new Map<string, WorkspaceFileEditSetFile>();
    for (const file of files) {
        const previous = merged.get(file.path);
        if (previous && (previous.expectedHash !== file.expectedHash || previous.renameTo && file.renameTo && previous.renameTo !== file.renameTo)) throw new LspWorkspaceEditError('stale_query');
        // Equivalent whole contributions from stacked servers are one edit set;
        // repeated same-position inserts inside a server's array are ordered LSP edits.
        const edits = previous && JSON.stringify(previous.edits) === JSON.stringify(file.edits)
            ? previous.edits : [...(previous?.edits ?? []), ...file.edits];
        const text = heldText?.(file.path) ?? (await readFile(resolveWorkspacePath({ rootPath, platform }, file.path))).toString('utf8');
        try { applyWorkspaceFileTextEdits(text, edits); } catch { throw new LspWorkspaceEditError('invalid_request'); }
        merged.set(file.path, { ...file, edits, ...(previous?.renameTo ? { renameTo: previous.renameTo } : {}) });
    }
    return [...merged.values()];
}
export function createLanguageServerHost(options: LanguageServerHostOptions = {}): LanguageServerHost {
    const platform = options.platform ?? process.platform;
    const definitions = createLanguageServerDefinitions({ readCurrentContributionRegistry: options.readCurrentContributionRegistry ?? readCurrentContributionRegistry });
    const openProtocol: OpenLanguageServerProtocol = options.openProtocol ?? (async (input) => (await import('./managedProtocol')).openLanguageServerProtocol(input));
    const projectChecker = options.projectChecker ?? { run: runLanguageServerProjectCheck, readProcessRoots: readLanguageServerProjectCheckProcessRoots };
    const roots = new Map<string, RootState>();
    const sessions = new Map<string, HostedSession>();
    let disposed = false;
    function key(path: string): string {
        const identity = resolveCanonicalAbsolutePathComparisonIdentity(path, { platform });
        if (identity === null)
            throw new LspWorkspacePathError('invalid_path', 'An absolute workspace root is required');
        return identity;
    }
    function rootFor(rootPath: string): RootState {
        resolveWorkspacePath({ rootPath, platform }, '.');
        const id = key(rootPath);
        let root = roots.get(id);
        if (!root) {
            root = { path: rootPath, generation: randomUUID(), revision: 0, documents: new Map(), sessions: new Set(), listeners: new Set(), watchers: 0, diagnostics: new Map() };
            roots.set(id, root);
        }
        return root;
    }
    const rootSessions = (root: RootState) => [...root.sessions].flatMap(id => { const hosted = sessions.get(id); return hosted ? [hosted.session] : []; });
    function heldDocument(root: RootState, path: string) {
        const documents = rootSessions(root).flatMap(session => {
            try { const document = session.document(localPath(session, root, path)); return document ? [document] : []; }
            catch { return []; }
        });
        return documents.find(document => document.unsaved) ?? documents[0];
    }
    function retireSession(id: string, session: ServerSession): void {
        const hosted = sessions.get(id);
        if (hosted?.session !== session)
            return;
        hosted.timer?.();
        sessions.delete(id);
        for (const root of roots.values()) {
            if (!root.sessions.delete(id)) continue;
            for (const [path, document] of root.documents) {
                if (document.sessions.delete(id) && document.sessions.size === 0) root.documents.delete(path);
            }
            root.revision++;
            for (const listener of root.listeners) listener();
        }
    }
    function retireEmptySession(id: string, session: ServerSession): void {
        if (session.paths().length === 0) retireSession(id, session);
    }
    async function closeDocument(id: string, session: ServerSession, path: string): Promise<void> {
        const hosted = sessions.get(id);
        if (hosted?.session !== session) return await session.close(path);
        // Keep the actual closing process visible until its native teardown
        // settles. Acquisition joins this same close before selecting a session.
        const closing = hosted.closing
            ? hosted.closing.then(() => session.close(path)) : session.close(path);
        hosted.closing = closing;
        try {
            await closing;
            if (hosted.closing === closing) retireEmptySession(id, session);
        } finally {
            if (hosted.closing === closing) hosted.closing = undefined;
        }
    }
    function localPath(session: ServerSession, root: RootState, path: string): string {
        const absolute = resolveWorkspacePath({ rootPath: root.path, platform }, path);
        const local = relative(session.workspaceRoot, absolute).replaceAll('\\', '/');
        resolveWorkspacePath({ rootPath: session.workspaceRoot, platform }, local);
        return local;
    }
    /** Query replies and watch deltas share the same session-to-root projection. */
    function diagnosticLocation(session: ServerSession, root: RootState, path: string) {
        return workspaceUriToPath({ rootPath: root.path, platform },
            workspacePathToUri({ rootPath: session.workspaceRoot, platform }, path));
    }
    function projectChange(sessionKey: string, diagnosticPaths: readonly string[]): void {
        const session = sessions.get(sessionKey)?.session;
        if (!session)
            return;
        for (const root of roots.values()) {
            if (!root.sessions.has(sessionKey))
                continue;
            root.revision++;
            for (const diagnosticPath of diagnosticPaths) {
                const location = diagnosticLocation(session, root, diagnosticPath);
                if (location.outsideWorkspace)
                    continue;
                const path = location.path;
                if (!root.documents.get(path)?.sessions.has(sessionKey)) continue;
                const entry = session.diagnostics.get(diagnosticPath);
                const prior = root.diagnostics.get(path)?.get(session.definition.id);
                if (!entry && !prior)
                    continue;
                let perServer = root.diagnostics.get(path);
                if (!perServer) {
                    perServer = new Map();
                    root.diagnostics.set(path, perServer);
                }
                perServer.set(session.definition.id, { revision: root.revision, entry: entry ? {
                    state: entry.state, version: entry.version, generation: entry.generation, items: entry.items.map(item => ({ ...item, path })),
                } : { state: 'ready', version: prior!.entry.version, generation: session.status().generation, items: [] } });
            }
            for (const listener of root.listeners)
                listener();
        }
    }
    function idleMs(): number | null {
        if (!options.readPolicy)
            return MachineProcessesPolicyV1Schema.parse({}).toolIdleCloseMs;
        const policy = options.readPolicy();
        return policy.status === 'ready' ? policy.policy.processes.toolIdleCloseMs : null;
    }
    function touch(sessionKey: string): void {
        const hosted = sessions.get(sessionKey);
        if (!hosted)
            return;
        hosted.lastActivity = Date.now();
        hosted.timer?.();
        const duration = idleMs();
        if (duration === null || hosted.session.status().state === 'idle' || hosted.session.status().state === 'stopped') {
            hosted.timer = undefined;
            return;
        }
        hosted.timer = armDeadlineTimer(hosted.lastActivity + duration, () => {
            hosted.timer = undefined;
            if (hosted.activeOperations > 0 || [...roots.values()].some(root => root.sessions.has(sessionKey) && root.watchers > 0)) {
                touch(sessionKey);
                return;
            }
            const current = idleMs();
            if (current === null)
                return;
            if (Date.now() - hosted.lastActivity < current) {
                touch(sessionKey);
                return;
            }
            void hosted.session.dispose().then(() => retireSession(sessionKey, hosted.session),
                error => logger.debug('[LSP] Idle cleanup failed', { error }));
        }, { unref: true });
    }
    async function ensureSession(root: RootState, path: string, definition: LanguageServerDefinition,
        acquire: (selected: { id: string; session: ServerSession }) => Promise<void>, context?: RequestContext, isCurrent?: () => boolean): Promise<{
        id: string;
        session: ServerSession;
    }> {
        const nativeRoot = await resolveLanguageServerRoot({ rootPath: root.path, path, rootMarkers: definition.rootMarkers, platform });
        if (disposed || (isCurrent && !isCurrent())) throw new LanguageServerSessionError('cancelled');
        const id = JSON.stringify([definition.id, key(nativeRoot)]);
        let hosted = sessions.get(id);
        while (hosted?.closing) {
            await hosted.closing;
            if (disposed || (isCurrent && !isCurrent())) throw new LanguageServerSessionError('cancelled');
            hosted = sessions.get(id);
        }
        if (!hosted) {
            const session = createServerSession({ definition, rootPath: nativeRoot, workspaceRoot: nativeRoot, platform, openProtocol,
                readInitializationOptions: options.readInitializationOptions,
                requesterWorkAttributionV1: context?.requesterWorkAttributionV1,
                onRetired: () => { void session.dispose().then(() => retireSession(id, session),
                    error => logger.debug('[LSP] Plugin retirement cleanup failed', { error })); },
                onChange: paths => { projectChange(id, paths); touch(id); } });
            hosted = { session, timer: undefined, lastActivity: Date.now(), activeOperations: 0 };
            sessions.set(id, hosted);
        }
        root.sessions.add(id);
        const selected = { id, session: hosted.session };
        // Enqueue document acquisition before publishing the selection across
        // an await (including another stacked definition's root discovery).
        await acquire(selected);
        return selected;
    }
    function errorResponse(error: unknown): Extract<DaemonLspQueryResponse, {
        status: 'error' | 'unavailable';
    }> {
        if (error instanceof LspWorkspacePathError)
            return error.code === 'unsupported_root' ? { status: 'unavailable', reason: 'unsupported_root' } : { status: 'error', errorCode: 'path_not_allowed' };
        if (error instanceof LspDocumentTextError)
            return error.code === 'symbol_not_found' ? { status: 'error', errorCode: 'symbol_not_found', candidates: [...(error.candidates ?? [])] } : { status: 'error', errorCode: 'invalid_position' };
        if (error instanceof LspWorkspaceEditError) return error.code === 'unsaved_editor_changes'
            ? { status: 'error', errorCode: error.code, diskHash: error.diskHash! } : { status: 'error', errorCode: error.code };
        if (error instanceof LanguageServerSessionError)
            return { status: 'error', errorCode: error.code };
        const native = readLspObject(error);
        if (native?.code === 'ENOENT')
            return { status: 'error', errorCode: 'root_not_found' };
        if (native?.name === 'AbortError')
            return { status: 'error', errorCode: 'cancelled' };
        logger.debug('[LSP] Host operation failed', { error });
        return { status: 'error', errorCode: 'request_failed' };
    }
    function watchSnapshot(root: RootState, sinceRevision = -1): Extract<DaemonLspWatchResponse, {
        status: 'ok';
    }> {
        const paths: Array<[string, Record<string, LanguageIntelligenceDiagnosticsEntry>]> = [];
        for (const [path, entries] of root.diagnostics) {
            const changedEntries: Array<[string, LanguageIntelligenceDiagnosticsEntry]> = [];
            for (const [serverId, entry] of entries) {
                if (entry.revision > sinceRevision) changedEntries.push([serverId, entry.entry]);
            }
            if (changedEntries.length) paths.push([path, Object.fromEntries(changedEntries)]);
        }
        const diagnostics = Object.fromEntries(paths);
        return { status: 'ok', revision: root.revision, servers: rootSessions(root).map(session => session.status()), diagnostics };
    }
    const host: LanguageServerHost = {
        readProcessRoots: () => [...sessions.values()].flatMap(({ session }) => session.readProcessRoots()).concat(projectChecker.readProcessRoots()),
        async sync(input, context) {
            try {
                if (disposed)
                    return { status: 'unavailable', reason: 'session_unavailable' };
                context?.signal?.throwIfAborted();
                const root = rootFor(input.rootPath), op = input.op;
                let acceptedVersion: number | undefined;
                if (op.op === 'external') {
                    for (const path of op.paths)
                        resolveWorkspacePath({ rootPath: root.path, platform }, path);
                    await Promise.all(rootSessions(root).map(session => session.external(op.paths, root.path)));
                }
                else if (op.op === 'close') {
                    const document = root.documents.get(op.path);
                    if (document && document.references > 0) {
                        const heldSessions = [...document.sessions];
                        document.references--;
                        await Promise.all(heldSessions.map(async (id) => { const hosted = sessions.get(id); if (hosted)
                            await closeDocument(id, hosted.session, localPath(hosted.session, root, op.path)); }));
                        if (document.references === 0 && root.documents.get(op.path) === document)
                            root.documents.delete(op.path);
                    }
                }
                else if (op.op === 'change') {
                    const document = root.documents.get(op.path);
                    if (!document)
                        return { status: 'error', errorCode: 'document_out_of_sync' };
                    const previous = heldDocument(root, op.path);
                    if (!previous || previous.version !== op.baseVersion) return { status: 'error', errorCode: 'document_out_of_sync' };
                    const accepted = await Promise.all([...document.sessions].map(id => { const session = sessions.get(id)?.session;
                        return session?.change({ ...op, path: localPath(session, root, op.path) }); }));
                    acceptedVersion = accepted.find(document => document !== undefined)?.version;
                }
                else {
                    resolveWorkspacePath({ rootPath: root.path, platform }, op.path);
                    const matching = definitions.findDefinitionsForDocument({ languageId: op.languageId, path: op.path });
                    if (!matching.length)
                        return { status: 'unavailable', reason: 'no_capable_server' };
                    const held = root.documents.get(op.path);
                    const prior = held && held.references > 0 ? held : undefined;
                    if (op.op === 'snapshot' && !prior)
                        return { status: 'error', errorCode: 'document_out_of_sync' };
                    const document = prior ?? { languageId: op.languageId, references: 0, sessions: new Set<string>() };
                    root.documents.set(op.path, document);
                    if (op.op === 'open')
                        document.references++;
                    const isCurrent = () => !disposed && root.documents.get(op.path) === document && document.references > 0;
                    for (const definition of matching) {
                        await ensureSession(root, op.path, definition, async ({ id, session }) => {
                            if (!isCurrent()) throw new LanguageServerSessionError('cancelled');
                            document.sessions.add(id);
                            const text = { path: localPath(session, root, op.path), languageId: op.languageId, text: op.text,
                                version: acceptedVersion ?? normalizeLanguageServerDocumentVersion(heldDocument(root, op.path), op), unsaved: op.unsaved };
                            if (op.op === 'open' || !session.document(text.path)) {
                                const holders = session.document(text.path) ? 1 : document.references;
                                for (let index = 0; index < holders; index++) {
                                    const accepted = await session.open(text);
                                    acceptedVersion ??= accepted.version;
                                }
                                if (!isCurrent()) throw new LanguageServerSessionError('cancelled');
                                const hosted = sessions.get(id)!;
                                hosted.activeOperations++;
                                try {
                                    await session.start();
                                }
                                catch (error) {
                                    if (session.status().state !== 'unavailable' && session.status().state !== 'crashed')
                                        throw error;
                                }
                                finally {
                                    hosted.activeOperations--;
                                    touch(id);
                                }
                            }
                            else {
                                const accepted = await session.snapshot(text);
                                acceptedVersion ??= accepted.version;
                            }
                        }, context, isCurrent);
                    }
                    document.languageId = op.languageId;
                }
                for (const id of root.sessions)
                    touch(id);
                const active = op.op === 'external' ? rootSessions(root)
                    : [...(root.documents.get(op.path)?.sessions ?? [])].flatMap(id => {
                        const hosted = sessions.get(id);
                        return hosted ? [hosted.session] : [];
                    });
                return { status: 'ok', generation: root.generation, ...('version' in op ? { version: acceptedVersion ?? op.version } : {}), servers: active.map(s => s.status()), capabilities: active.length ? combineCapabilities(active) : emptyCapabilities() };
            }
            catch (error) {
                if (context?.signal?.aborted) return { status: 'error', errorCode: 'cancelled' };
                return errorResponse(error);
            }
        },
        async query(input, context) {
            const transient: Array<{
                id: string;
                session: ServerSession;
                path: string;
            }> = [];
            try {
                if (disposed)
                    return { status: 'unavailable', reason: 'session_unavailable' };
                context?.signal?.throwIfAborted();
                await context?.assertCurrentAuthority?.();
                // Provider suggestions are dispatched by the shared RPC ingress to
                // their Provider owner, independently of language-server lifetime.
                if (input.kind === 'ai.inlineSuggest' || input.kind === 'ai.nextEdit') return { status: 'error', errorCode: 'unsupported' };
                const queryKind = input.kind;
                const root = rootFor(input.rootPath);
                if (input.generation !== undefined && input.generation !== root.generation)
                    return { status: 'error', errorCode: 'stale_query' };
                const projectDiskConflict = async () => {
                    if (input.kind !== 'diagnostics' || input.scope !== 'project' || input.text !== 'disk') return null;
                    for (const path of root.documents.keys()) {
                        if (!heldDocument(root, path)?.unsaved) continue;
                        await context?.assertCurrentAuthority?.();
                        const bytes = await readFile(resolveWorkspacePath({ rootPath: root.path, platform }, path));
                        await context?.assertCurrentAuthority?.();
                        return { status: 'error' as const, errorCode: 'unsaved_editor_changes' as const, diskHash: createHash('sha256').update(bytes).digest('hex') };
                    }
                    return null;
                };
                const beforeConflict = await projectDiskConflict();
                if (beforeConflict) return beforeConflict;
                const languageId = input.languageId ?? root.documents.get(input.path)?.languageId ?? getFileLanguageFromPath(input.path) ?? '';
                const matching = definitions.findDefinitionsForDocument({ languageId: languageId || null, path: input.path }).filter(d => !input.serverId || d.id === input.serverId);
                if (!matching.length)
                    return { status: 'unavailable', reason: 'no_capable_server' };
                const absolute = resolveWorkspacePath({ rootPath: root.path, platform }, input.path);
                let diskText: string | undefined, fileHash: string | undefined;
                const existing = heldDocument(root, input.path);
                if (input.text === 'disk' || !existing) {
                    await context?.assertCurrentAuthority?.();
                    const bytes = await readFile(absolute);
                    await context?.assertCurrentAuthority?.();
                    diskText = bytes.toString('utf8');
                    fileHash = createHash('sha256').update(bytes).digest('hex');
                }
                const selections = await Promise.allSettled(matching.map(definition => ensureSession(root, input.path, definition, async ({ id, session }) => {
                    const path = localPath(session, root, input.path), held = session.document(path);
                    if (input.text === 'disk' && held?.unsaved)
                        throw new LspWorkspaceEditError('unsaved_editor_changes', fileHash!);
                    const sourceDocument = root.documents.get(input.path);
                    const selectedDiskText = input.text === 'disk' || !held ? diskText : undefined;
                    if (held && input.text !== 'disk') fileHash = undefined;
                    const document = { path, languageId: held?.languageId ?? languageId, text: selectedDiskText ?? held?.text ?? existing?.text ?? '',
                        version: held?.version ?? existing?.version ?? 0,
                        unsaved: selectedDiskText === undefined && (held?.unsaved ?? existing?.unsaved ?? false) };
                    document.version = normalizeLanguageServerDocumentVersion(held, document);
                    // Enqueue the query's own reference before any await. An
                    // editor close or sibling cleanup cannot end its custody.
                    transient.push({ id, session, path });
                    await session.open(document);
                    if (!held && sourceDocument) {
                        for (let i = 0; i < sourceDocument.references; i++) await session.open(document);
                        sourceDocument.sessions.add(id);
                    }
                }, context)));
                const failedSelection = selections.find(selection => selection.status === 'rejected');
                if (failedSelection?.status === 'rejected') throw failedSelection.reason;
                const selected = selections.flatMap(selection => selection.status === 'fulfilled' ? [selection.value] : []);
                const document = selected[0].session.document(localPath(selected[0].session, root, input.path));
                if (!document)
                    return { status: 'error', errorCode: 'session_unavailable' };
                if (input.version !== undefined && input.version !== document.version)
                    return { status: 'error', errorCode: 'stale_query' };
                const position = input.position === undefined ? undefined : resolveDocumentPosition(document.text, input.position);
                if (input.kind === 'rename' && !input.newName || input.kind === 'willRenameFiles' && !input.newPath)
                    return { status: 'error', errorCode: 'invalid_request' };
                if ((['hover', 'definition', 'references', 'prepareRename', 'rename', 'completion', 'signatureHelp', 'typeDefinition', 'implementation', 'documentHighlight', 'selectionRange'].includes(input.kind)
                    || input.kind === 'codeActions' && !input.range || input.kind === 'callHierarchy' && (!input.hierarchy || input.hierarchy.direction === 'prepare')) && !position)
                    return { status: 'error', errorCode: 'invalid_position' };
                if ((input.kind === 'rangeFormatting' || input.kind === 'inlayHint') && !input.range
                    || (input.kind === 'formatting' || input.kind === 'rangeFormatting') && !input.formattingOptions
                    || input.kind === 'workspaceSymbol' && input.query === undefined
                    || input.kind === 'completionResolve' && (!input.itemId || !input.serverId)
                    || input.kind === 'semanticTokens' && (!input.range && (!input.previousResultId || !input.serverId))
                    || input.kind === 'callHierarchy' && input.hierarchy?.direction !== 'prepare' && input.hierarchy && !position && (!input.hierarchy.itemId || !input.serverId))
                    return { status: 'error', errorCode: 'invalid_request' };
                const requestedGeneration = root.generation;
                const answers = await Promise.allSettled(selected.map(async ({ id, session }) => { const hosted = sessions.get(id)!; hosted.activeOperations++; touch(id); try {
                    let answer: ServerSessionAnswer;
                    if (input.kind === 'diagnostics' && input.scope === 'project') {
                        await session.start();
                        if (!session.capabilities().workspaceDiagnostics && session.definition.projectCheck) {
                            const before = session.status().generation;
                            const processOwner = session.readProcessRoots()[0]?.owner;
                            if (!processOwner) throw new LanguageServerSessionError('session_unavailable');
                            const check = await projectChecker.run({ definition: session.definition, rootPath: session.workspaceRoot,
                                processOwner,
                                signal: context?.signal ?? new AbortController().signal, platform,
                                requesterWorkAttributionV1: context?.requesterWorkAttributionV1 });
                            if (check.status === 'cancelled') throw new LanguageServerSessionError('cancelled');
                            if (check.status === 'unsupported') throw new LanguageServerSessionError('unsupported');
                            if (check.status === 'failed') throw new LanguageServerSessionError('request_failed');
                            if (before !== session.status().generation) throw new LanguageServerSessionError('stale_query');
                            answer = { value: check.diagnostics, loading: false, generation: before, version: document.version };
                        } else answer = await session.query({ ...input, kind: queryKind, path: localPath(session, root, input.path), position, signal: context?.signal });
                    } else answer = await session.query({ ...input, kind: queryKind, path: localPath(session, root, input.path), position,
                        newPath: input.newPath ? localPath(session, root, input.newPath) : undefined, signal: context?.signal });
                    return { session, answer };
                }
                finally {
                    hosted.activeOperations--;
                    touch(id);
                } }));
                if (requestedGeneration !== root.generation)
                    return { status: 'error', errorCode: 'stale_query' };
                const ready = answers.flatMap(answer => answer.status === 'fulfilled' ? [answer.value] : []);
                if (!ready.length) {
                    const errors = answers.flatMap(answer => answer.status === 'rejected' ? [answer.reason as unknown] : []);
                    if (errors.every(error => error instanceof LanguageServerSessionError && error.code === 'unsupported'))
                        return { status: 'unavailable', reason: 'no_capable_server' };
                    const failed = selected.map(({ session }) => session.status()).find(status => status.reason);
                    if (failed?.reason)
                        return { status: 'unavailable', reason: failed.reason };
                    return errorResponse(errors[0]);
                }
                const provenance = { status: 'ok' as const, version: document.version, generation: root.generation, ...(fileHash ? { fileHash } : {}) };
                await context?.assertCurrentAuthority?.();
                const result = await projectResults(root, input.kind, ready, provenance, { ...input, position });
                await context?.assertCurrentAuthority?.();
                const afterConflict = await projectDiskConflict();
                if (afterConflict) return afterConflict;
                context?.signal?.throwIfAborted();
                if (requestedGeneration !== root.generation || ready.some(({ session, answer }) => session.status().generation !== answer.generation || answer.version !== document.version || session.document(localPath(session, root, input.path))?.version !== answer.version || session.document(localPath(session, root, input.path))?.text !== document.text))
                    return { status: 'error', errorCode: 'stale_query' };
                const isEmpty = result.kind === 'hover' ? result.sections.length === 0 : result.kind === 'documentSymbols' || result.kind === 'workspaceSymbol' ? result.symbols.length === 0
                    : result.kind === 'diagnostics' ? result.diagnostics.length === 0 : result.kind === 'prepareRename' ? result.targets.length === 0 : result.kind === 'codeActions' ? result.actions.length === 0
                    : 'files' in result ? result.files.length === 0 : 'locations' in result ? result.locations.length === 0 : result.kind === 'completion' ? result.items.length === 0
                    : result.kind === 'completionResolve' ? false : result.kind === 'signatureHelp' ? !result.help?.signatures.length : result.kind === 'inlayHint' ? result.hints.length === 0
                    : result.kind === 'semanticTokens' ? result.tokens.length === 0 : result.kind === 'documentHighlight' ? result.highlights.length === 0
                    : result.kind === 'selectionRange' ? result.ranges.length === 0 : result.items.length + result.calls.length === 0;
                return isEmpty && ready.some(answer => answer.answer.loading) ? { status: 'loading' } : result;
            }
            catch (error) {
                return errorResponse(error);
            }
            finally {
                await Promise.all(transient.map(async ({ id, session, path }) => { try {
                    await closeDocument(id, session, path);
                }
                catch (error) {
                    logger.debug('[LSP] Transient cleanup failed', { error });
                } }));
            }
        },
        async apply(input, context) {
            const retained: Array<{ id: string; session: ServerSession; path: string }> = [];
            const results: Extract<DaemonWorkspaceFileReplaceApplyResponse, { ok: true }>['results'] = [];
            try {
                context?.signal?.throwIfAborted();
                await context?.assertCurrentAuthority?.();
                const root = rootFor(input.rootPath);
                const applyFiles = async (files: WorkspaceFileEditSetFile[]) => {
                    for (const file of files) {
                        if (heldDocument(root, file.path)?.unsaved) {
                            await context?.assertCurrentAuthority?.();
                            const bytes = await readFile(resolveWorkspacePath({ rootPath: root.path, platform }, file.path));
                            await context?.assertCurrentAuthority?.();
                            throw new LspWorkspaceEditError('unsaved_editor_changes', createHash('sha256').update(bytes).digest('hex'));
                        }
                    }
                    const response = await applyWorkspaceFileReplace({ rootPath: root.path, operation: { kind: 'editSet', files } }, root.path,
                        { kind: 'restrictedRoots', roots: [root.path] }, context);
                    if (response.ok) {
                        results.push(...response.results);
                        const renamed = response.results.flatMap(result => result.status === 'replaced' && result.renameTo ? [{ path: result.path, renameTo: result.renameTo }] : []);
                        for (const session of rootSessions(root)) {
                            for (const result of response.results) {
                                if (result.status !== 'replaced' || result.renameTo) continue;
                                let path: string;
                                try { path = localPath(session, root, result.path); } catch { continue; }
                                const held = session.document(path);
                                if (held && !held.unsaved) {
                                    await context?.assertCurrentAuthority?.();
                                    const text = (await readFile(resolveWorkspacePath({ rootPath: root.path, platform }, result.path))).toString('utf8');
                                    await context?.assertCurrentAuthority?.();
                                    await session.snapshot({ ...held, text, version: held.version + 1 });
                                }
                            }
                            if (renamed.length) await session.didRenameFiles(renamed.map(file => ({ path: localPath(session, root, file.path), renameTo: localPath(session, root, file.renameTo) })));
                        }
                    }
                    return response;
                };
                if (input.operation.kind !== 'codeAction') {
                    if (input.operation.kind !== 'fileRename' && input.operation.files.some(file => file.renameTo)
                        || input.operation.kind === 'fileRename' && !input.operation.files.some(file => file.path === input.path && file.renameTo)) return { status: 'error', errorCode: 'invalid_request' };
                    return await applyFiles(input.operation.files);
                }
                const operation = input.operation;
                if (operation.action.disabledReason !== undefined) return { status: 'error', errorCode: 'unsupported' };
                await context?.assertCurrentAuthority?.();
                const bytes = await readFile(resolveWorkspacePath({ rootPath: root.path, platform }, input.path));
                await context?.assertCurrentAuthority?.();
                const diskHash = createHash('sha256').update(bytes).digest('hex');
                if (heldDocument(root, input.path)?.unsaved) return { status: 'error', errorCode: 'unsaved_editor_changes', diskHash };
                if (diskHash !== operation.expectedHash) return { status: 'error', errorCode: 'stale_query' };
                const languageId = input.languageId ?? root.documents.get(input.path)?.languageId ?? getFileLanguageFromPath(input.path) ?? '';
                const definition = definitions.findDefinitionsForDocument({ languageId, path: input.path }).find(item => item.id === operation.action.serverId);
                if (!definition) return { status: 'unavailable', reason: 'no_capable_server' };
                const { id, session } = await ensureSession(root, input.path, definition, async ({ id, session }) => {
                    const path = localPath(session, root, input.path), previous = session.document(path);
                    retained.push({ id, session, path });
                    await session.open({ path, languageId, text: bytes.toString('utf8'), version: previous?.version ?? 0, unsaved: false });
                }, context);
                const path = localPath(session, root, input.path);
                const hosted = sessions.get(id)!;
                hosted.activeOperations++;
                try {
                    const answer = await session.query({ path, kind: 'codeActions', range: operation.action.range, signal: context?.signal });
                    const current = await projectResults(root, 'codeActions', [{ session, answer }], { status: 'ok', fileHash: diskHash, version: answer.version, generation: answer.generation },
                        { rootPath: root.path, path: input.path, kind: 'codeActions', range: operation.action.range });
                    if (current.kind !== 'codeActions') throw new LspWorkspaceEditError('invalid_request');
                    const candidates = current.actions.filter(action => action.title === operation.action.title && action.kind === operation.action.kind);
                    if (candidates.length !== 1 || candidates[0].disabledReason !== undefined) return { status: 'error', errorCode: 'unsupported' };
                    const action = candidates[0];
                    if (action.hasCommand !== operation.action.hasCommand || JSON.stringify(action.files) !== JSON.stringify(operation.action.files)) return { status: 'error', errorCode: 'stale_query' };
                    const nativeAction = Array.isArray(answer.value) ? answer.value.map(readLspObject).find(value => value
                        && value.title === action.title && (typeof value.kind === 'string' ? value.kind : undefined) === action.kind) : undefined;
                    if (!nativeAction) throw new LspWorkspaceEditError('invalid_request');
                    const command = readCodeActionCommand(nativeAction);
                    const initial = await applyFiles(action.files);
                    if (!initial.ok || initial.results.some(result => result.status !== 'replaced' || result.reason !== undefined)) return initial;
                    if (command) {
                      await context?.assertCurrentAuthority?.();
                      await session.executeCommand(command, async edit => {
                        await context?.assertCurrentAuthority?.();
                        const files = await normalizeWorkspaceEdit({ rootPath: root.path, platform, edit, document: path => heldDocument(root, path) });
                        const applied = await applyFiles(files);
                        return applied.ok && applied.results.every(result => result.status === 'replaced' && result.reason === undefined);
                      }, context?.signal);
                    }
                    return { ok: true, results };
                } finally { hosted.activeOperations--; touch(id); }
            } catch (error) {
                if (results.length) return { ok: true, results: [...results, { path: input.path, status: 'failed', reason: context?.signal?.aborted ? 'cancelled' : error instanceof LanguageServerSessionError ? error.code : 'request_failed' }], ...(context?.signal?.aborted ? { cancelled: [input.path] } : {}) };
                return errorResponse(error);
            } finally {
                await Promise.all(retained.map(({ id, session, path }) => closeDocument(id, session, path)));
            }
        },
        async watch(input, context) {
            try {
                if (disposed)
                    return { status: 'unavailable', reason: 'session_unavailable' };
                const root = rootFor(input.rootPath);
                for (const id of root.sessions)
                    touch(id);
                if (input.sinceRevision === undefined)
                    return watchSnapshot(root);
                root.watchers++;
                try {
                    const result = await parkWatch({ signal: context?.signal, windowMs: MACHINE_WATCH_WINDOW_MS, isNewer: () => root.revision > input.sinceRevision!, subscribe: listener => { root.listeners.add(listener); return () => root.listeners.delete(listener); }, read: () => watchSnapshot(root, input.sinceRevision) });
                    return result.changed ? result.snapshot : watchSnapshot(root, input.sinceRevision);
                }
                finally {
                    root.watchers--;
                    for (const id of root.sessions)
                        touch(id);
                }
            }
            catch (error) {
                return errorResponse(error);
            }
        },
        async restart(input) {
            try {
                const root = rootFor(input.rootPath), selected = rootSessions(root).filter(s => !input.serverId || s.definition.id === input.serverId);
                if (!selected.length)
                    return { status: 'unavailable', reason: 'session_unavailable' };
                root.generation = randomUUID();
                await Promise.all(selected.map(session => session.restart()));
                return { status: 'ok' };
            }
            catch (error) {
                return errorResponse(error);
            }
        },
        async dispose() { disposed = true; for (const hosted of sessions.values())
            hosted.timer?.(); await Promise.all([...sessions.values()].map(({ session }) => session.dispose())); sessions.clear(); for (const root of roots.values())
            for (const listener of root.listeners)
                listener(); roots.clear(); },
    };
    async function projectResults(root: RootState, kind: DaemonLspQueryRequest['kind'], ready: Array<{
        session: ServerSession;
        answer: ServerSessionAnswer;
    }>, provenance: Readonly<{
        status: 'ok';
        version: number;
        generation: string;
        fileHash?: string;
    }>, input: DaemonLspQueryRequest): Promise<QueryOk> {
        const normalize = (edit: unknown) => normalizeWorkspaceEdit({ rootPath: root.path, platform, edit,
            document: path => heldDocument(root, path) });
        if (kind === 'completion') {
            return { ...provenance, kind, items: ready.flatMap(({ session, answer }) => {
                const document = session.document(localPath(session, root, input.path));
                if (!document) throw new LanguageServerSessionError('session_unavailable');
                return readLspList(readLspObject(answer.value)?.items).map(createCompletionNormalizer(session.definition.id, document.text));
            }), isIncomplete: ready.some(({ answer }) => readLspObject(answer.value)?.isIncomplete === true) };
        }
        if (kind === 'completionResolve') {
            const { session, answer } = ready[0];
            const document = session.document(localPath(session, root, input.path));
            if (!document) throw new LanguageServerSessionError('session_unavailable');
            return { ...provenance, kind, item: createCompletionNormalizer(session.definition.id, document.text)(answer.value) };
        }
        if (kind === 'signatureHelp') {
            const helps = ready.flatMap(({ answer }) => { const help = normalizeSignatureHelp(answer.value); return help ? [help] : []; });
            return { ...provenance, kind, help: helps.length ? { ...helps[0], signatures: helps.flatMap(help => help.signatures) } : null };
        }
        if (kind === 'formatting' || kind === 'rangeFormatting' || kind === 'organizeImports') {
            const edits: WorkspaceFileEditSetFile[] = [];
            for (const { session, answer } of ready) {
                let native: unknown;
                if (kind === 'organizeImports') {
                    const actions = readLspList(answer.value).map(readLspObject).filter(action => action && action.disabled === undefined);
                    const selected = actions.find(action => action?.isPreferred === true) ?? actions[0];
                    native = selected?.edit ?? null;
                } else native = { changes: { [workspacePathToUri({ rootPath: root.path, platform }, input.path)]: readLspList(answer.value) } };
                edits.push(...await normalizeWorkspaceEdit({ rootPath: root.path, platform, edit: native,
                    document: path => heldDocument(root, path), text: input.text === 'disk' ? 'disk' : 'held' }));
            }
            return { ...provenance, kind, files: await mergeEditSets(root.path, platform, edits, input.text === 'disk' ? undefined : path => heldDocument(root, path)?.text) };
        }
        if (kind === 'documentHighlight') return { ...provenance, kind, highlights: unique(ready.flatMap(({ session, answer }) => readLspList(answer.value).map(raw => {
            const item = readLspObject(raw);
            if (!item) throw new Error('Invalid document highlight');
            if (item.kind !== undefined && item.kind !== 1 && item.kind !== 2 && item.kind !== 3) throw new Error('Invalid highlight kind');
            return { serverId: session.definition.id, range: readLspRange(item.range), ...(item.kind === undefined ? {} : { kind: item.kind as 1 | 2 | 3 }) };
        })), item => JSON.stringify([item.range, item.kind])) };
        if (kind === 'selectionRange') return { ...provenance, kind, ranges: unique(ready.flatMap(({ session, answer }) => readLspList(answer.value).map(raw => {
            const ranges = [];
            let current = readLspObject(raw);
            if (!current) throw new Error('Invalid selection range');
            while (current) { ranges.push(readLspRange(current.range)); current = current.parent === undefined ? undefined : readLspObject(current.parent); }
            return { serverId: session.definition.id, ranges };
        })), item => JSON.stringify(item.ranges)) };
        if (kind === 'inlayHint') return { ...provenance, kind, hints: unique(ready.flatMap(({ session, answer }) => readLspList(answer.value).map(raw => normalizeInlayHint(session.definition.id, raw))),
            hint => JSON.stringify([hint.position, hint.label, hint.kind])) };
        if (kind === 'semanticTokens') return { ...provenance, kind, tokens: ready.flatMap(({ session, answer }) => answer.value === null ? [] : [normalizeSemanticTokens(session.definition.id, answer.value)]) };
        if (kind === 'callHierarchy') {
            const direction = input.hierarchy?.direction ?? 'prepare';
            const items = direction === 'prepare' ? ready.flatMap(({ session, answer }) => readLspList(answer.value).map(raw => normalizeCallHierarchyItem({ rootPath: root.path, platform }, session.definition.id, raw))) : [];
            const calls = direction === 'prepare' ? [] : ready.flatMap(({ session, answer }) => readLspList(answer.value).map(raw => {
                const call = readLspObject(raw);
                if (!call) throw new Error('Invalid hierarchy call');
                return { item: normalizeCallHierarchyItem({ rootPath: root.path, platform }, session.definition.id, call[direction === 'incoming' ? 'from' : 'to']), ranges: readLspList(call.fromRanges).map(readLspRange) };
            }));
            return { ...provenance, kind, direction, items: unique(items, item => JSON.stringify([item.path, item.selectionRange, item.name])),
                calls: unique(calls, call => JSON.stringify([call.item.path, call.item.selectionRange, call.ranges])) };
        }
        if (kind === 'workspaceSymbol') return { ...provenance, kind, symbols: unique(ready.flatMap(({ session, answer }) => readLspList(answer.value).map(raw => {
            const symbol = readLspObject(raw), location = readLspObject(symbol?.location);
            if (!symbol || typeof symbol.name !== 'string' || !Number.isInteger(symbol.kind) || typeof location?.uri !== 'string') throw new Error('Invalid workspace symbol');
            return { serverId: session.definition.id, name: symbol.name, kind: Number(symbol.kind), ...workspaceUriToPath({ rootPath: root.path, platform }, location.uri),
                range: readLspRange(location.range), ...(typeof symbol.containerName === 'string' ? { containerName: symbol.containerName } : {}) };
        })), symbol => JSON.stringify([symbol.path, symbol.range, symbol.name, symbol.kind])), hasMore: false };
        if (kind === 'prepareRename') return { ...provenance, kind, targets: ready.flatMap(({ session, answer }) => {
            if (answer.value === null) return [];
            const value = readLspObject(answer.value);
            if (!value) throw new LspWorkspaceEditError('invalid_request');
            return [{ serverId: session.definition.id, ...(value.defaultBehavior === true ? {} : { range: readLspRange(value.range ?? value) }), ...(typeof value.placeholder === 'string' ? { placeholder: value.placeholder } : {}) }];
        }) };
        if (kind === 'rename' || kind === 'willRenameFiles') {
            const edits = await Promise.all(ready.map(({ answer }) => normalize(answer.value)));
            const merged = await mergeEditSets(root.path, platform, edits.flat());
            if (kind === 'willRenameFiles') {
                const source = await normalizeWorkspaceEdit({ rootPath: root.path, platform, edit: null,
                    document: path => heldDocument(root, path), rename: { path: input.path, newPath: input.newPath! } });
                return { ...provenance, kind, files: await mergeEditSets(root.path, platform, [...source, ...merged]) };
            }
            return { ...provenance, kind, files: merged };
        }
        if (kind === 'codeActions') {
            const actions = [];
            for (const { session, answer } of ready) {
                if (answer.value === null) continue;
                if (!Array.isArray(answer.value)) throw new LspWorkspaceEditError('invalid_request');
                for (const raw of answer.value) {
                    const value = readLspObject(raw);
                    if (!value || typeof value.title !== 'string') throw new LspWorkspaceEditError('invalid_request');
                    const command = readCodeActionCommand(value);
                    const disabledReason = readLspObject(value.disabled)?.reason;
                    const position = input.position && 'character' in input.position ? input.position : undefined;
                    if (!input.range && !position) throw new LspWorkspaceEditError('invalid_request');
                    actions.push({ serverId: session.definition.id, title: value.title, range: input.range ?? { start: position!, end: position! }, files: await normalize(value.edit),
                        ...(typeof value.kind === 'string' ? { kind: value.kind } : {}),
                        hasCommand: command !== undefined,
                        ...(typeof disabledReason === 'string' ? { disabledReason } : {}) });
                }
            }
            return { ...provenance, kind, actions };
        }
        if (kind === 'hover')
            return { ...provenance, kind, sections: ready.flatMap(({ session, answer }) => { const hover = normalizeLspHover(answer.value); return hover ? [{ serverId: session.definition.id, label: session.definition.title, ...hover }] : []; }) };
        if (kind === 'documentSymbols')
            return { ...provenance, kind, symbols: unique(ready.flatMap(({ session, answer }) => normalizeLspDocumentSymbols(session.definition.id, answer.value)), item => JSON.stringify([item.name, item.kind, item.selectionRange])), hasMore: false };
        if (kind === 'diagnostics') {
            const diagnostics = [];
            for (const { session, answer } of ready) {
                if (input.scope === 'project' && !Array.isArray(answer.value)) {
                    const report = readLspObject(answer.value);
                    if (!report || !Array.isArray(report.items)) throw new Error('Invalid workspace diagnostic report');
                    for (const raw of report.items) {
                        const item = readLspObject(raw);
                        if (!item || typeof item.uri !== 'string' || item.kind !== 'full') throw new Error('Invalid project diagnostic report');
                        const target = workspaceUriToPath({ rootPath: root.path, platform }, item.uri);
                        if (target.outsideWorkspace) continue;
                        for (const diagnostic of normalizeLspDiagnostics(session.definition.id, target.path, item.items)) diagnostics.push(diagnostic);
                    }
                } else {
                    for (const item of answer.value as LanguageIntelligenceDiagnostic[]) {
                        const location = diagnosticLocation(session, root, item.path);
                        if (!location.outsideWorkspace) diagnostics.push({ ...item, path: location.path });
                    }
                }
            }
            return { ...provenance, kind, diagnostics: unique(diagnostics, item => JSON.stringify([item.path, item.range, item.severity, item.code, item.message])), hasMore: false };
        }
        const locations: Array<{
            serverId: string;
            path: string;
            outsideWorkspace?: boolean;
            range: ReturnType<typeof readLspRange>;
            lineText: string;
        }> = [];
        for (const { session, answer } of ready) {
            const items = answer.value === null ? [] : Array.isArray(answer.value) ? answer.value : [answer.value];
            for (const item of items) {
                const location = readLspObject(item);
                if (!location)
                    throw new Error('Invalid language-server location');
                const uri = location.uri ?? location.targetUri;
                if (typeof uri !== 'string')
                    throw new Error('Invalid language-server location URI');
                const target = workspaceUriToPath({ rootPath: root.path, platform }, uri), range = readLspRange(location.range ?? location.targetSelectionRange ?? location.targetRange);
                if (kind === 'references' && target.outsideWorkspace)
                    continue;
                let lineText = '';
                if (kind === 'references') {
                    const absolute = resolveWorkspacePath({ rootPath: root.path, platform }, target.path), held = session.document(relative(session.workspaceRoot, absolute).replaceAll('\\', '/'));
                    lineText = readDocumentLine(held?.text ?? (await readFile(absolute)).toString('utf8'), range.start.line);
                }
                locations.push({ serverId: session.definition.id, ...target, range, lineText });
            }
        }
        const deduped = unique(locations, item => JSON.stringify([item.path, item.range]));
        if (kind === 'references')
            return { ...provenance, kind, locations: deduped.map(({ outsideWorkspace, ...item }) => item), hasMore: false };
        if (kind !== 'definition' && kind !== 'typeDefinition' && kind !== 'implementation') throw new Error('Unsupported language-server result');
        return { ...provenance, kind, locations: deduped.map(({ lineText, ...item }) => item), hasMore: false };
    }
    return host;
}
let configuredOptions: LanguageServerHostOptions | undefined;
let sharedHost: LanguageServerHost | undefined;
export function configureLanguageServerHost(options: LanguageServerHostOptions): void {
    if (sharedHost)
        throw new Error('Language-server host is already serving');
    configuredOptions = options;
}
export function getLanguageServerHost(): LanguageServerHost { return sharedHost ??= createLanguageServerHost(configuredOptions); }
export function readLanguageServerProcessRoots(): readonly HappierProcessRootSource[] { return sharedHost?.readProcessRoots() ?? []; }
export async function disposeLanguageServerHost(): Promise<void> { const host = sharedHost; sharedHost = undefined; configuredOptions = undefined; await host?.dispose(); }
