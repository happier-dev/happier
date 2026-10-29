import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { ProcessOwnerRef } from '@/processes/ownerTag';
import { invalidateProcessLaunchDiscovery } from '@/processes/launchNotification';
import { readSupervisedPluginProcessIdForHost } from '@/plugins/runtime/exec/processSupervisor';
import type { HappierProcessRootSource } from '@/daemon/processes/roots/listHappierProcessRoots';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import { resolveCanonicalAbsolutePathComparisonIdentity } from '@/utils/path/expandHomeDirPath';
import { logger } from '@/ui/logger';
import { disposePluginProtocolClientGracefullyForHost } from '@/plugins/runtime/invocation/services/exec';
import { resolveLanguageServerDocumentLanguageId, type LanguageServerDefinition } from './languageServerDefinitions';
import type { ReadLanguageServerInitializationOptions } from './managedProtocol';
import type { DaemonLspQueryRequest, LanguageIntelligenceCommandSchema, LanguageIntelligenceCapabilities, LanguageIntelligenceDiagnosticsEntry, LanguageIntelligencePosition, LanguageIntelligenceServerStatus } from '@happier-dev/protocol/machines/languageIntelligence';
import type { z } from 'zod/mini';
import { applyDocumentTextEdit } from './documentText';
import { createDiagnosticsPullScheduler } from './diagnosticsPull';
import { normalizeLspDiagnostics, readLspObject } from './languageServerResults';
import { workspacePathToUri, workspaceUriToPath } from './workspaceUris';
import { readSemanticTokenBaseline, selectSemanticTokenRange, type SemanticTokenBaseline } from './semanticTokens';
export type LanguageServerDocument = Readonly<{
    path: string;
    languageId: string;
    text: string;
    version: number;
    unsaved: boolean;
}>;
/** Native document versions identify semantic revisions, not a holder's local counter. */
export function normalizeLanguageServerDocumentVersion(previous: LanguageServerDocument | undefined,
    next: Pick<LanguageServerDocument, 'text' | 'languageId' | 'version'>): number {
    if (!previous) return next.version;
    return previous.text === next.text && previous.languageId === next.languageId
        ? previous.version : Math.max(next.version, previous.version + 1);
}
export type LanguageServerChange = Readonly<{
    path: string;
    version: number;
    baseVersion: number;
    edit: {
        startLine: number;
        startCharacter: number;
        endLine: number;
        endCharacter: number;
        text: string;
    };
    unsaved: boolean;
}>;
export type OpenLanguageServerProtocol = (input: Readonly<{
    definition: LanguageServerDefinition;
    rootPath: string;
    processOwner: ProcessOwnerRef;
    signal: AbortSignal;
    onRetired?: () => void;
}>) => Promise<PluginProtocolClientHandle<'jsonRpc'>>;
export type ServerSessionQuery = Readonly<Pick<DaemonLspQueryRequest,
    'includeDeclaration' | 'newName' | 'newPath' | 'range' | 'scope' | 'query' | 'itemId' |
    'previousResultId' | 'hierarchy' | 'completionContext' | 'signatureContext' | 'formattingOptions'> & {
    kind: Exclude<DaemonLspQueryRequest['kind'], 'ai.inlineSuggest' | 'ai.nextEdit'>;
    path: string;
    position?: LanguageIntelligencePosition;
    signal?: AbortSignal;
}>;
export type ServerSessionAnswer = Readonly<{
    value: unknown;
    loading: boolean;
    generation: string;
    version: number;
}>;
export class LanguageServerSessionError extends Error {
    constructor(readonly code: 'session_unavailable' | 'document_out_of_sync' | 'stale_query' | 'cancelled' | 'request_failed' | 'unsupported', options?: ErrorOptions) { super(code, options); }
}
export type ServerSession = Readonly<{
    readProcessRoots(): readonly HappierProcessRootSource[];
    definition: LanguageServerDefinition;
    rootPath: string;
    workspaceRoot: string;
    diagnostics: ReadonlyMap<string, LanguageIntelligenceDiagnosticsEntry>;
    status(): LanguageIntelligenceServerStatus;
    capabilities(): LanguageIntelligenceCapabilities;
    document(path: string): LanguageServerDocument | undefined;
    paths(): readonly string[];
    open(document: LanguageServerDocument): Promise<LanguageServerDocument>;
    snapshot(document: LanguageServerDocument): Promise<LanguageServerDocument>;
    change(input: LanguageServerChange): Promise<LanguageServerDocument>;
    close(path: string): Promise<void>;
    start(): Promise<void>;
    external(paths: readonly string[], workspaceRoot?: string): Promise<void>;
    query(input: ServerSessionQuery): Promise<ServerSessionAnswer>;
    executeCommand(command: z.infer<typeof LanguageIntelligenceCommandSchema>, applyEdit: (edit: unknown) => Promise<boolean>, signal?: AbortSignal): Promise<void>;
    didRenameFiles(files: readonly Readonly<{ path: string; renameTo: string }>[]): Promise<void>;
    restart(): Promise<void>;
    dispose(): Promise<void>;
}>;
export type CreateServerSessionOptions = Readonly<{
    definition: LanguageServerDefinition;
    rootPath: string;
    workspaceRoot: string;
    openProtocol: OpenLanguageServerProtocol;
    readInitializationOptions?: ReadLanguageServerInitializationOptions;
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
    /** Diagnostic paths are session-relative; an empty list changes status only. */
    onChange(diagnosticPaths: readonly string[]): void;
    onRetired?(): void;
    platform?: NodeJS.Platform;
}>;
export function createServerSession(options: CreateServerSessionOptions): ServerSession {
    // Attribution follows the acquiring work for this session's whole lifetime;
    // later shared queries must not relabel an existing native service.
    const requesterWorkAttributionV1 = options.requesterWorkAttributionV1
        ? Object.freeze({ ...options.requesterWorkAttributionV1 }) : undefined;
    const documents = new Map<string, LanguageServerDocument & {
        references: number;
    }>();
    const diagnostics = new Map<string, LanguageIntelligenceDiagnosticsEntry & { nativeItems?: JsonValue[] }>();
    const hiddenDiagnostics: ReadonlyMap<string, LanguageIntelligenceDiagnosticsEntry> = new Map();
    const platform = options.platform ?? process.platform;
    const uriContext = { rootPath: options.workspaceRoot, platform };
    let generation = randomUUID();
    let state: LanguageIntelligenceServerStatus['state'] = 'idle';
    let reason: LanguageIntelligenceServerStatus['reason'];
    let stderrPreview: string | undefined;
    let protocol: PluginProtocolClientHandle<'jsonRpc'> | undefined;
    let processRoot: HappierProcessRootSource | undefined;
    let lifetime: AbortController | undefined;
    let starting: Promise<void> | undefined;
    let operations: Promise<void> = Promise.resolve();
    let stopping = false;
    let disposed = false;
    let diagnosticsEnabled = false;
    let watchedFilesRegistered = false;
    let syncKind = 0;
    let executeCommands: readonly string[] = [];
    let codeActionResolve = false;
    let semanticLegend: { tokenTypes: string[]; tokenModifiers: string[] } | undefined;
    // A delta-only server needs one full baseline per held document, owned by this native session.
    const semanticBaselines = new Map<string, SemanticTokenBaseline>();
    // Native item data is opaque to clients and lives only with its held buffer.
    const completionItems = new Map<string, Map<string, JsonValue>>();
    const hierarchyItems = new Map<string, Map<string, JsonValue>>();
    const forgetItems = (path: string) => { completionItems.delete(path); hierarchyItems.delete(path); };
    let mutation: Readonly<{ applyEdit(edit: unknown): Promise<boolean>; signal?: AbortSignal }> | undefined;
    const progressTokens = new Set<string | number>();
    const loadingTokens = new Set<string | number>();
    let capabilities: LanguageIntelligenceCapabilities = { hover: false, definition: false, references: false, documentSymbol: false, diagnostics: 'none', acceptsExternalChanges: false };
    const changed = (diagnosticPaths: readonly string[] = []) => options.onChange(diagnosticPaths);
    const setDiagnostics = (path: string, entry: LanguageIntelligenceDiagnosticsEntry & { nativeItems?: JsonValue[] }): boolean => {
        const previous = diagnostics.get(path);
        const equal = previous && previous.state === entry.state && previous.version === entry.version
            && previous.generation === entry.generation && isDeepStrictEqual(previous.items, entry.items);
        // Native code-action data can change independently of the public diagnostics.
        diagnostics.set(path, equal ? { ...entry, items: previous.items } : entry);
        return !equal;
    };
    const publishDiagnostics = (path: string, entry: LanguageIntelligenceDiagnosticsEntry & { nativeItems?: JsonValue[] }) => {
        if (setDiagnostics(path, entry) && diagnosticsEnabled) changed([path]);
    };
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = operations.then(operation);
        operations = result.then(() => undefined, () => undefined);
        return result;
    };
    const uri = (path: string) => workspacePathToUri(uriContext, path);
    const clearDiagnostics = () => {
        const paths: string[] = [];
        for (const [path, entry] of diagnostics) {
            if (setDiagnostics(path, { ...entry, generation, items: [], state: 'unavailable' }) && diagnosticsEnabled) paths.push(path);
        }
        changed(paths);
    };
    const failure = (error: unknown): LanguageServerSessionError => {
        const value = readLspObject(error);
        if (value?.code === -32801)
            return new LanguageServerSessionError('stale_query', { cause: error });
        if (value?.code === -32800 || value?.code === -32802 || value?.code === 'PLUGIN_EXEC_CLIENT_ABORTED')
            return new LanguageServerSessionError('cancelled', { cause: error });
        return error instanceof LanguageServerSessionError ? error : new LanguageServerSessionError('request_failed', { cause: error });
    };
    const pulls = createDiagnosticsPullScheduler({ async pull(path, signal) {
            const document = documents.get(path), client = protocol?.client;
            if (!document || !client || state !== 'ready' || !diagnosticsEnabled)
                return;
            const requestGeneration = generation, version = document.version;
            const previous = diagnostics.get(path);
            publishDiagnostics(path, { state: 'checking', version, generation, items: previous?.items ?? [] });
            try {
                const raw = await client.request('textDocument/diagnostic', { textDocument: { uri: uri(path) } }, { signal });
                if (signal.aborted || requestGeneration !== generation || documents.get(path)?.version !== version || documents.get(path)?.text !== document.text)
                    return;
                const report = readLspObject(raw);
                if (report?.kind !== 'full')
                    throw new Error('Language server returned an unsupported diagnostic report');
                const items = normalizeLspDiagnostics(options.definition.id, path, report.items);
                // The managed JSON-RPC boundary supplies JSON; retain native Diagnostic.data
                // in this same store for codeAction, outside the public marker projection.
                publishDiagnostics(path, { state: loadingTokens.size ? 'checking' : 'ready', version, generation, items, nativeItems: report.items as JsonValue[] });
            }
            catch (error) {
                if (!signal.aborted && requestGeneration === generation && documents.get(path)?.version === version && documents.get(path)?.text === document.text) {
                    publishDiagnostics(path, { state: 'unavailable', version, generation, items: previous?.items ?? [] });
                }
                throw error;
            }
        } });
    const pullSoon = (path: string) => { if (diagnosticsEnabled && capabilities.diagnostics === 'pull')
        void pulls.trigger(path).catch(error => logger.debug('[LSP] Diagnostics pull failed', { serverId: options.definition.id, error })); };
    const refresh = async (signal?: AbortSignal) => {
        if (!diagnosticsEnabled || capabilities.diagnostics !== 'pull') return;
        for (const path of [...documents.keys()]) {
            if (signal?.aborted) return;
            try { await pulls.trigger(path); }
            catch (error) { logger.debug('[LSP] Diagnostics refresh failed', { serverId: options.definition.id, path, error }); }
        }
    };
    const notifyOpen = async (document: LanguageServerDocument) => {
        const languageId = resolveLanguageServerDocumentLanguageId(options.definition, document.languageId);
        if (languageId === null) throw new LanguageServerSessionError('unsupported');
        await protocol?.client.notify('textDocument/didOpen', { textDocument: { uri: uri(document.path), languageId, version: document.version, text: document.text } });
    };
    const notifySnapshot = async (document: LanguageServerDocument) => {
        if (syncKind !== 0)
            await protocol?.client.notify('textDocument/didChange', { textDocument: { uri: uri(document.path), version: document.version }, contentChanges: [{ text: document.text }] });
    };
    async function start(): Promise<void> {
        if (disposed || stopping)
            throw new LanguageServerSessionError('session_unavailable');
        if (state === 'ready')
            return;
        if (starting)
            return await starting;
        if (state === 'crashed' || state === 'unavailable' || state === 'stopped')
            throw new LanguageServerSessionError('session_unavailable');
        state = 'starting';
        generation = randomUUID();
        // A response can settle during the old child's graceful shutdown; result ids belong to that child.
        semanticBaselines.clear();
        reason = undefined;
        stderrPreview = undefined;
        changed();
        const nativeGeneration = generation;
        lifetime = new AbortController();
        starting = (async () => {
            try {
                const initializationOptions = options.definition.initializationOptionsSetting
                    ? await (options.readInitializationOptions ?? (await import('./managedProtocol')).readLanguageServerInitializationOptions)(options.definition, lifetime!.signal)
                    : options.definition.initializationOptions;
                const rootIdentity = resolveCanonicalAbsolutePathComparisonIdentity(options.rootPath, { platform });
                if (rootIdentity === null)
                    throw new Error('Language-server root is invalid');
                const rootHash = createHash('sha256').update(rootIdentity).digest('hex').slice(0, 12);
                const processOwner = { kind: 'service', serviceId: `lsp:${options.definition.id}:${rootHash}`, pluginId: options.definition.pluginId } as const;
                const ownerCreatedAtMs = Date.now();
                const opened = await options.openProtocol({ definition: options.definition, rootPath: options.rootPath, signal: lifetime!.signal, processOwner,
                    onRetired: options.onRetired });
                if (disposed || nativeGeneration !== generation) {
                    await opened.dispose();
                    throw new LanguageServerSessionError('session_unavailable');
                }
                protocol = opened;
                const pid = readSupervisedPluginProcessIdForHost(opened.process);
                if (pid !== null) {
                    // Processes joins this live custody source to its native census and owner tag.
                    processRoot = { owner: processOwner, pid, live: true, ownerCreatedAtMs,
                        ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}),
                        workspacePath: options.workspaceRoot, stop: async () => { if (protocol === opened) await stop(); },
                        async startAgain() {
                            // Retained Processes refs may outlive the native child, but cannot
                            // restart a replacement generation or a session with no holders.
                            if (disposed || stopping || generation !== nativeGeneration || documents.size === 0)
                                return { status: 'refused', reasonCode: 'original_start_unavailable' };
                            await session.restart();
                            return state === 'ready' ? { status: 'started' }
                                : { status: 'refused', reasonCode: reason ?? 'start_failed' };
                        } };
                    invalidateProcessLaunchDiscovery();
                }
                void opened.wait().then(() => {
                    if (protocol === opened) {
                        processRoot = undefined;
                        invalidateProcessLaunchDiscovery();
                    }
                    if (!stopping && nativeGeneration === generation && (state === 'starting' || state === 'ready')) {
                        state = state === 'starting' ? 'unavailable' : 'crashed';
                        reason = state === 'crashed' ? 'crashed' : 'start_failed';
                        completionItems.clear(); hierarchyItems.clear();
                        clearDiagnostics();
                    }
                }, error => logger.debug('[LSP] Process exit observation failed', { serverId: options.definition.id, error }));
                const client = opened.client;
                client.onRequest('client/registerCapability', request => {
                    const params = readLspObject(request.params);
                    if (Array.isArray(params?.registrations) && params.registrations.some(item => readLspObject(item)?.method === 'workspace/didChangeWatchedFiles'))
                        watchedFilesRegistered = true;
                    const acceptsExternalChanges = platform === 'linux' && watchedFilesRegistered;
                    if (capabilities.acceptsExternalChanges !== acceptsExternalChanges) {
                        capabilities = { ...capabilities, acceptsExternalChanges };
                        changed();
                    }
                    return null;
                });
                client.onRequest('client/unregisterCapability', () => {
                    watchedFilesRegistered = false;
                    if (capabilities.acceptsExternalChanges) { capabilities = { ...capabilities, acceptsExternalChanges: false }; changed(); }
                    return null;
                });
                const folders = [{ uri: pathToFileURL(options.rootPath, { windows: platform === 'win32' }).href, name: options.rootPath }];
                client.onRequest('workspace/workspaceFolders', () => folders);
                client.onRequest('workspace/configuration', request => {
                    const params = readLspObject(request.params);
                    return Array.isArray(params?.items) ? params.items.map(item => {
                        const section = readLspObject(item)?.section;
                        if (typeof section !== 'string')
                            return null;
                        let value: unknown = options.definition.settings;
                        for (const segment of section.split('.'))
                            value = readLspObject(value)?.[segment];
                        return value === undefined ? null : value as JsonValue;
                    }) : [];
                });
                client.onRequest('window/workDoneProgress/create', request => { const token = readLspObject(request.params)?.token; if (typeof token === 'string' || typeof token === 'number')
                    progressTokens.add(token); return null; });
                client.onRequest('workspace/diagnostic/refresh', () => { if (nativeGeneration === generation && !stopping) void refresh().catch(error => logger.debug('[LSP] Diagnostics refresh failed', { serverId: options.definition.id, error })); return null; });
                client.onRequest('workspace/applyEdit', async request => {
                    const authority = mutation;
                    if (!authority || authority.signal?.aborted || nativeGeneration !== generation || stopping) return { applied: false };
                    try { return { applied: await authority.applyEdit(readLspObject(request.params)?.edit) }; }
                    catch { return { applied: false }; }
                });
                client.onRequest('window/showMessageRequest', () => null);
                client.onNotification(message => {
                    if (nativeGeneration !== generation || stopping) return;
                    const params = readLspObject(message.params);
                    if (message.method === '$/progress') {
                        const token = params?.token, value = readLspObject(params?.value);
                        if ((typeof token === 'string' || typeof token === 'number') && progressTokens.has(token)) {
                            const wasLoading = loadingTokens.size > 0;
                            const paths: string[] = [];
                            if (value?.kind === 'begin')
                                loadingTokens.add(token);
                            if (value?.kind === 'end') {
                                loadingTokens.delete(token);
                                if (loadingTokens.size === 0) {
                                    for (const [path, entry] of diagnostics) {
                                        if (entry.state !== 'checking') continue;
                                        if (capabilities.diagnostics === 'pull') pullSoon(path);
                                        else if (capabilities.diagnostics === 'push' && entry.generation === generation && documents.get(path)?.version === entry.version) {
                                            if (setDiagnostics(path, { ...entry, state: 'ready' }) && diagnosticsEnabled) paths.push(path);
                                        }
                                    }
                                }
                            }
                            if (wasLoading !== (loadingTokens.size > 0) || paths.length) changed(paths);
                            return;
                        }
                    }
                    if (message.method === 'textDocument/publishDiagnostics' && typeof params?.uri === 'string') {
                        try {
                            const location = workspaceUriToPath(uriContext, params.uri);
                            const document = documents.get(location.path);
                            if (location.outsideWorkspace || !document || (params.version !== undefined && params.version !== document.version))
                                return;
                            const items = normalizeLspDiagnostics(options.definition.id, location.path, params.diagnostics);
                            publishDiagnostics(location.path, { state: loadingTokens.size ? 'checking' : 'ready', version: document.version, generation, items,
                                nativeItems: params.diagnostics as JsonValue[] });
                            return;
                        }
                        catch (error) {
                            logger.debug('[LSP] Invalid pushed diagnostics', { serverId: options.definition.id, error });
                            return;
                        }
                    }
                    logger.debug('[LSP] Server notification', { serverId: options.definition.id, method: message.method });
                });
                const initialized = readLspObject(await client.request('initialize', {
                    processId: process.pid, rootUri: folders[0].uri, workspaceFolders: folders,
                    ...(initializationOptions === undefined ? {} : { initializationOptions }),
                    capabilities: {
                        general: { positionEncodings: ['utf-16'] },
                        textDocument: {
                            synchronization: { dynamicRegistration: false, didSave: false }, hover: { contentFormat: ['markdown', 'plaintext'] },
                            definition: { linkSupport: false }, references: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                            publishDiagnostics: { versionSupport: true, dataSupport: true }, diagnostic: {}, rename: { prepareSupport: true },
                            codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] } }, disabledSupport: true, dataSupport: true, resolveSupport: { properties: ['edit', 'command'] } },
                            completion: { contextSupport: true, completionItem: { snippetSupport: true, insertReplaceSupport: true,
                                documentationFormat: ['markdown', 'plaintext'], resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] } },
                                completionList: { itemDefaults: ['commitCharacters', 'editRange', 'insertTextFormat', 'insertTextMode', 'data'] } },
                            signatureHelp: { contextSupport: true, signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true } },
                            formatting: {}, rangeFormatting: {}, typeDefinition: { linkSupport: false }, implementation: { linkSupport: false },
                            documentHighlight: {}, selectionRange: {}, inlayHint: {}, callHierarchy: {},
                            semanticTokens: { requests: { range: true, full: { delta: true } },
                                tokenTypes: ['namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable',
                                    'property', 'enumMember', 'event', 'function', 'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator'],
                                tokenModifiers: ['declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary'],
                                formats: ['relative'], overlappingTokenSupport: false, multilineTokenSupport: false, augmentsSyntaxTokens: true },
                        },
                        window: { workDoneProgress: true },
                        workspace: {
                            workspaceFolders: true, applyEdit: true, workspaceEdit: { documentChanges: true, resourceOperations: ['rename'], failureHandling: 'abort' },
                            fileOperations: { willRename: true, didRename: true }, executeCommand: { dynamicRegistration: false }, diagnostics: { refreshSupport: true },
                            symbol: {},
                            ...(options.definition.settings === undefined ? {} : { configuration: true }),
                            ...(platform === 'linux' ? { didChangeWatchedFiles: { dynamicRegistration: true } } : {}),
                        },
                    },
                }, { signal: lifetime!.signal }));
                const native = readLspObject(initialized?.capabilities);
                if (!native)
                    throw new Error('Language server initialize capabilities are missing');
                const sync = readLspObject(native.textDocumentSync);
                syncKind = typeof native.textDocumentSync === 'number' ? native.textDocumentSync : typeof sync?.change === 'number' ? sync.change : 0;
                const rename = readLspObject(native.renameProvider), codeAction = readLspObject(native.codeActionProvider);
                const fileOperations = readLspObject(readLspObject(native.workspace)?.fileOperations);
                const commandOptions = readLspObject(native.executeCommandProvider);
                executeCommands = Array.isArray(commandOptions?.commands) ? commandOptions.commands.filter((item): item is string => typeof item === 'string') : [];
                codeActionResolve = codeAction?.resolveProvider === true;
                const completion = readLspObject(native.completionProvider), signature = readLspObject(native.signatureHelpProvider);
                const semantic = readLspObject(native.semanticTokensProvider), legend = readLspObject(semantic?.legend);
                const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
                semanticLegend = legend && Array.isArray(legend.tokenTypes) && legend.tokenTypes.every(item => typeof item === 'string')
                    && Array.isArray(legend.tokenModifiers) && legend.tokenModifiers.every(item => typeof item === 'string')
                    ? { tokenTypes: strings(legend.tokenTypes), tokenModifiers: strings(legend.tokenModifiers) } : undefined;
                const actionKinds = Array.isArray(codeAction?.codeActionKinds) ? codeAction.codeActionKinds : undefined;
                capabilities = { hover: !!native.hoverProvider, definition: !!native.definitionProvider, references: !!native.referencesProvider, documentSymbol: !!native.documentSymbolProvider, diagnostics: native.diagnosticProvider ? 'pull' : 'push', acceptsExternalChanges: platform === 'linux' && watchedFilesRegistered,
                    rename: !!native.renameProvider, prepareRename: rename?.prepareProvider === true, fileRename: !!fileOperations?.willRename, codeAction: !!native.codeActionProvider,
                    completion: !!native.completionProvider, completionResolve: completion?.resolveProvider === true, signatureHelp: !!native.signatureHelpProvider,
                    completionTriggerCharacters: strings(completion?.triggerCharacters), signatureTriggerCharacters: strings(signature?.triggerCharacters), signatureRetriggerCharacters: strings(signature?.retriggerCharacters),
                    formatting: !!native.documentFormattingProvider, rangeFormatting: !!native.documentRangeFormattingProvider,
                    organizeImports: !!native.codeActionProvider && (!actionKinds || actionKinds.some(kind => typeof kind === 'string'
                        && (kind === '' || kind === 'source.organizeImports' || kind.startsWith('source.organizeImports.') || 'source.organizeImports'.startsWith(`${kind}.`)))),
                    typeDefinition: !!native.typeDefinitionProvider, implementation: !!native.implementationProvider, documentHighlight: !!native.documentHighlightProvider,
                    selectionRange: !!native.selectionRangeProvider, inlayHint: !!native.inlayHintProvider,
                    semanticTokensRange: !!semanticLegend && !!semantic?.range, semanticTokensDelta: !!semanticLegend && readLspObject(semantic?.full)?.delta === true,
                    callHierarchy: !!native.callHierarchyProvider, workspaceSymbol: !!native.workspaceSymbolProvider,
                    workspaceDiagnostics: readLspObject(native.diagnosticProvider)?.workspaceDiagnostics === true };
                await client.notify('initialized', {});
                if (options.definition.settings !== undefined) {
                    await client.notify('workspace/didChangeConfiguration', { settings: options.definition.settings });
                }
                await enqueue(async () => { for (const document of documents.values())
                    await notifyOpen(document); });
                state = 'ready';
                changed();
            }
            catch (error) {
                const detail = readLspObject(error);
                if (nativeGeneration === generation && !stopping) {
                    state = 'unavailable';
                    reason = detail?.reason === 'server_missing' ? 'server_missing' : 'start_failed';
                    stderrPreview = typeof detail?.stderrPreview === 'string' ? detail.stderrPreview : undefined;
                    clearDiagnostics();
                }
                await protocol?.dispose().catch(cleanupError => logger.debug('[LSP] Failed-start cleanup failed', { serverId: options.definition.id, error: cleanupError }));
                protocol = undefined;
                processRoot = undefined;
                throw new LanguageServerSessionError('session_unavailable', { cause: error });
            }
            finally {
                starting = undefined;
            }
        })();
        return await starting;
    }
    async function stop(): Promise<void> {
        stopping = true;
        semanticBaselines.clear();
        completionItems.clear(); hierarchyItems.clear();
        for (const path of documents.keys())
            pulls.cancel(path);
        const opened = protocol;
        if (starting) {
            lifetime?.abort();
            await starting.catch(() => undefined);
        }
        if (opened)
            await disposePluginProtocolClientGracefullyForHost(opened, async (signal) => {
                if (state === 'ready') {
                    for (const path of documents.keys())
                        await opened.client.notify('textDocument/didClose', { textDocument: { uri: uri(path) } });
                    await opened.client.request('shutdown', undefined, { signal });
                    await opened.client.notify('exit');
                }
            });
        lifetime?.abort();
        protocol = undefined;
        processRoot = undefined;
        state = 'stopped';
        loadingTokens.clear();
        progressTokens.clear();
        watchedFilesRegistered = false;
        stopping = false;
        clearDiagnostics();
    }
    const session: ServerSession = {
        readProcessRoots: () => processRoot ? [{ ...processRoot, ...(stopping ? { state: 'stopping' as const } : {}) }] : [],
        definition: options.definition, rootPath: options.rootPath, workspaceRoot: options.workspaceRoot,
        get diagnostics() { return diagnosticsEnabled ? diagnostics : hiddenDiagnostics; },
        status: () => ({ serverId: options.definition.id, label: options.definition.title, state, loading: loadingTokens.size > 0, generation, capabilities, ...(reason ? { reason } : {}), ...(stderrPreview ? { stderrPreview } : {}),
            ...(reason === 'server_missing' && options.definition.executable.kind === 'managedDependency' ? { installable: { pluginId: typeof options.definition.executable.id === 'string' ? options.definition.pluginId : options.definition.executable.id.pluginId, dependencyId: typeof options.definition.executable.id === 'string' ? options.definition.executable.id : options.definition.executable.id.localId } } : {}),
        }),
        capabilities: () => capabilities,
        document: path => documents.get(path), paths: () => [...documents.keys()],
        start,
        open: document => enqueue(async () => {
            const previous = documents.get(document.path);
            const accepted = { ...document, version: normalizeLanguageServerDocumentVersion(previous, document) };
            const changed = !previous || accepted.version !== previous.version;
            if (changed) forgetItems(document.path);
            documents.set(document.path, { ...accepted, references: (previous?.references ?? 0) + 1 });
            if (state === 'ready' && changed) {
                if (previous) await notifySnapshot(accepted);
                else await notifyOpen(accepted);
                pullSoon(document.path);
            }
            return accepted;
        }),
        snapshot: document => enqueue(async () => {
            const previous = documents.get(document.path);
            if (!previous) throw new LanguageServerSessionError('document_out_of_sync');
            const accepted = { ...document, version: normalizeLanguageServerDocumentVersion(previous, document) };
            const changed = accepted.version !== previous.version;
            if (changed) forgetItems(document.path);
            documents.set(document.path, { ...accepted, references: previous.references });
            if (state === 'ready' && changed) {
                await notifySnapshot(accepted);
                pullSoon(document.path);
            }
            return accepted;
        }),
        change: input => enqueue(async () => {
            const previous = documents.get(input.path);
            if (!previous || previous.version !== input.baseVersion) throw new LanguageServerSessionError('document_out_of_sync');
            const next = { ...previous, text: applyDocumentTextEdit(previous.text, input.edit), version: input.version, unsaved: input.unsaved };
            const document = { ...next, version: normalizeLanguageServerDocumentVersion(previous, next) };
            const changed = document.version !== previous.version;
            if (changed) forgetItems(input.path);
            documents.set(input.path, document);
            if (state === 'ready' && syncKind !== 0 && changed) {
                await protocol!.client.notify('textDocument/didChange', { textDocument: { uri: uri(input.path), version: document.version }, contentChanges: syncKind === 1 ? [{ text: document.text }] : [{ range: { start: { line: input.edit.startLine, character: input.edit.startCharacter }, end: { line: input.edit.endLine, character: input.edit.endCharacter } }, text: input.edit.text }] });
                pullSoon(input.path);
            }
            return document;
        }),
        async close(path) { await enqueue(async () => { const previous = documents.get(path); if (!previous)
            return; if (previous.references > 1) {
            documents.set(path, { ...previous, references: previous.references - 1 });
            return;
        } documents.delete(path); semanticBaselines.delete(path); forgetItems(path); pulls.cancel(path); diagnostics.delete(path); if (state === 'ready')
            await protocol!.client.notify('textDocument/didClose', { textDocument: { uri: uri(path) } }); changed([path]); }); if (documents.size === 0)
            await stop(); },
        external: (paths, workspaceRoot) => enqueue(async () => { if (state === 'ready' && capabilities.acceptsExternalChanges)
            await protocol!.client.notify('workspace/didChangeWatchedFiles', { changes: paths.map(path => ({ uri: workspacePathToUri({ rootPath: workspaceRoot ?? options.workspaceRoot, platform }, path), type: 2 })) }); }),
        async query(input) {
            if (input.signal?.aborted)
                throw new LanguageServerSessionError('cancelled');
            if (input.kind === 'diagnostics' && input.scope !== 'project' && !diagnosticsEnabled) {
                diagnosticsEnabled = true;
                if (diagnostics.size) changed([...diagnostics.keys()]);
            }
            await start();
            await operations;
            const document = documents.get(input.path), opened = protocol;
            if (!document || !opened || state !== 'ready')
                throw new LanguageServerSessionError('session_unavailable');
            const requestGeneration = generation, version = document.version, wasLoading = loadingTokens.size > 0;
            const supported = input.kind === 'documentSymbols' ? capabilities.documentSymbol
                : input.kind === 'semanticTokens' ? input.range ? capabilities.semanticTokensRange || capabilities.semanticTokensDelta : !!input.previousResultId && capabilities.semanticTokensDelta
                : input.kind === 'diagnostics' ? input.scope === 'project' ? capabilities.workspaceDiagnostics : capabilities.diagnostics !== 'none'
                : input.kind === 'willRenameFiles' ? capabilities.fileRename : input.kind === 'codeActions' ? capabilities.codeAction : capabilities[input.kind];
            if (!supported)
                throw new LanguageServerSessionError('unsupported');
            try {
                let value: unknown;
                let semanticBaseline: SemanticTokenBaseline | undefined;
                let diagnosticsLoading = false;
                const request = (method: string, params: JsonValue) => opened.client.request(method, params, { signal: input.signal });
                const textDocument = { uri: uri(input.path) };
                if (input.kind === 'completionResolve') {
                    const capturedItems = completionItems.get(input.path);
                    const captured = input.itemId ? capturedItems?.get(input.itemId) : undefined;
                    if (!captured) throw new LanguageServerSessionError('stale_query');
                    const resolved = readLspObject(await request('completionItem/resolve', captured));
                    if (completionItems.get(input.path) !== capturedItems) throw new LanguageServerSessionError('stale_query');
                    if (!resolved) throw new LanguageServerSessionError('request_failed');
                    value = { ...readLspObject(captured), ...resolved, itemId: input.itemId };
                }
                else if (input.kind === 'callHierarchy') {
                    const direction = input.hierarchy?.direction ?? 'prepare';
                    const captured = hierarchyItems.get(input.path) ?? new Map<string, JsonValue>();
                    hierarchyItems.set(input.path, captured);
                    const retain = (raw: unknown) => {
                        const item = readLspObject(raw);
                        if (!item) throw new LanguageServerSessionError('request_failed');
                        const itemId = randomUUID();
                        // JSON-RPC owns the JSON boundary; native item data never crosses the public wire.
                        captured.set(itemId, item as JsonValue);
                        return { ...item, itemId };
                    };
                    if (direction === 'prepare') {
                        if (!input.position) throw new LanguageServerSessionError('request_failed');
                        const items = await request('textDocument/prepareCallHierarchy', { textDocument, position: input.position });
                        value = Array.isArray(items) ? items.map(retain) : [];
                    } else {
                        const native = input.hierarchy?.itemId ? captured.get(input.hierarchy.itemId) : undefined;
                        if (input.hierarchy?.itemId && !native) throw new LanguageServerSessionError('stale_query');
                        if (!native && !input.position) throw new LanguageServerSessionError('request_failed');
                        const prepared = native ? [native] : await request('textDocument/prepareCallHierarchy', { textDocument, position: input.position! });
                        const key = direction === 'incoming' ? 'from' : 'to';
                        value = (await Promise.all((Array.isArray(prepared) ? prepared : []).map(async item => {
                            const calls = await request(`callHierarchy/${direction === 'incoming' ? 'incomingCalls' : 'outgoingCalls'}`, { item });
                            return Array.isArray(calls) ? calls.map(raw => {
                                const call = readLspObject(raw);
                                if (!call) throw new LanguageServerSessionError('request_failed');
                                return { ...call, [key]: retain(call[key]) };
                            }) : [];
                        }))).flat();
                    }
                }
                else if (input.kind === 'completion') {
                    if (!input.position) throw new LanguageServerSessionError('request_failed');
                    const captured = new Map<string, JsonValue>();
                    completionItems.set(input.path, captured);
                    const raw = await request('textDocument/completion', { textDocument, position: input.position,
                        ...(input.completionContext ? { context: input.completionContext } : {}) });
                    if (completionItems.get(input.path) !== captured) throw new LanguageServerSessionError('stale_query');
                    const list = readLspObject(raw), defaults = readLspObject(list?.itemDefaults);
                    const items = Array.isArray(raw) ? raw : Array.isArray(list?.items) ? list.items : [];
                    value = { isIncomplete: list?.isIncomplete === true, items: items.map(rawItem => {
                        const object = readLspObject(rawItem);
                        if (!object) throw new LanguageServerSessionError('request_failed');
                        const item = { ...object };
                        for (const key of ['commitCharacters', 'insertTextFormat', 'insertTextMode', 'data']) {
                            if (item[key] === undefined && defaults?.[key] !== undefined) item[key] = defaults[key];
                        }
                        if (item.textEdit === undefined && defaults?.editRange !== undefined) {
                            const editRange = readLspObject(defaults.editRange);
                            const newText = item.textEditText ?? item.insertText ?? item.label;
                            item.textEdit = editRange?.insert && editRange.replace ? { insert: editRange.insert, replace: editRange.replace, newText }
                                : { range: defaults.editRange, newText };
                        }
                        const itemId = randomUUID();
                        // Keep the expanded native completion, including opaque resolve data.
                        captured.set(itemId, item as JsonValue);
                        return { ...item, itemId };
                    }) };
                }
                else if (input.kind === 'semanticTokens') {
                    if (input.range && !capabilities.semanticTokensRange) {
                        const previous = semanticBaselines.get(input.path);
                        const previousResultId = previous?.resultId;
                        const raw = await request(previousResultId === undefined ? 'textDocument/semanticTokens/full' : 'textDocument/semanticTokens/full/delta',
                            { textDocument, ...(previousResultId === undefined ? {} : { previousResultId }) });
                        semanticBaseline = readSemanticTokenBaseline(options.definition.id, semanticLegend!, raw, previous);
                        value = { data: selectSemanticTokenRange(semanticBaseline.data, input.range), legend: semanticLegend,
                            ...(semanticBaseline.resultId === undefined ? {} : { resultId: semanticBaseline.resultId }) };
                    } else {
                        const raw = await request(input.range ? 'textDocument/semanticTokens/range' : 'textDocument/semanticTokens/full/delta',
                            { textDocument, ...(input.range ? { range: input.range } : { previousResultId: input.previousResultId! }) });
                        value = { ...(readLspObject(raw) ?? { data: [] }), legend: semanticLegend };
                    }
                }
                else if (input.kind === 'workspaceSymbol') {
                    value = await request('workspace/symbol', { query: input.query ?? '' });
                }
                else if (input.kind === 'diagnostics' && input.scope === 'project') {
                    value = await request('workspace/diagnostic', { previousResultIds: [] });
                }
                else if (input.kind === 'signatureHelp' || input.kind === 'formatting' || input.kind === 'rangeFormatting'
                    || input.kind === 'inlayHint' || input.kind === 'selectionRange') {
                    if ((input.kind === 'inlayHint' || input.kind === 'rangeFormatting') && !input.range)
                        throw new LanguageServerSessionError('request_failed');
                    if ((input.kind === 'formatting' || input.kind === 'rangeFormatting') && !input.formattingOptions)
                        throw new LanguageServerSessionError('request_failed');
                    if ((input.kind === 'signatureHelp' || input.kind === 'selectionRange') && !input.position)
                        throw new LanguageServerSessionError('request_failed');
                    value = await request(`textDocument/${input.kind}`, { textDocument,
                        ...(input.range ? { range: input.range } : {}),
                        ...(input.kind === 'selectionRange' ? { positions: [input.position!] } : input.position ? { position: input.position } : {}),
                        ...(input.signatureContext && input.kind === 'signatureHelp' ? { context: input.signatureContext } : {}),
                        ...(input.formattingOptions ? { options: input.formattingOptions } : {}) });
                }
                else if (input.kind === 'diagnostics') {
                    if (capabilities.diagnostics === 'pull') {
                        const paths = [...documents.keys()];
                        const cancel = () => { for (const path of paths) pulls.cancel(path); };
                        input.signal?.addEventListener('abort', cancel, { once: true });
                        try {
                            if (input.signal?.aborted) throw new LanguageServerSessionError('cancelled');
                            await refresh(input.signal);
                            if (input.signal?.aborted) throw new LanguageServerSessionError('cancelled');
                        } finally {
                            input.signal?.removeEventListener('abort', cancel);
                        }
                    }
                    const entry = diagnostics.get(input.path);
                    if (capabilities.diagnostics === 'push' && (!entry || entry.generation !== generation || entry.version !== version || entry.state === 'unavailable')) {
                        // No push is not an authoritative empty report. Keep only
                        // observed reports in the store while the caller waits.
                        value = [];
                        diagnosticsLoading = true;
                    } else {
                        if (!entry || entry.state === 'unavailable') throw new LanguageServerSessionError('request_failed');
                        value = entry.items;
                        diagnosticsLoading = entry.state === 'checking';
                    }
                }
                else {
                    let codeActionContext: { diagnostics: JsonValue[]; only: string[] } | undefined;
                    if (input.kind === 'organizeImports') {
                        codeActionContext = { diagnostics: [], only: ['source.organizeImports'] };
                    }
                    else if (input.kind === 'codeActions') {
                        if (capabilities.diagnostics === 'pull') {
                            const pulled = await session.query({ path: input.path, kind: 'diagnostics', signal: input.signal });
                            diagnosticsLoading = pulled.loading;
                        }
                        const entry = diagnostics.get(input.path);
                        const range = input.range ?? { start: input.position!, end: input.position! };
                        const compare = (a: LanguageIntelligencePosition, b: LanguageIntelligencePosition) => a.line - b.line || a.character - b.character;
                        const current = entry?.version === version && entry.generation === requestGeneration && entry.state === 'ready' ? entry : undefined;
                        codeActionContext = { only: [''], diagnostics: (current?.nativeItems ?? []).filter((_raw, index) => {
                            const itemRange = current?.items[index]?.range;
                            if (!itemRange) return false;
                            const { start, end } = itemRange;
                            return compare(range.start, range.end) === 0
                                ? compare(start, range.start) <= 0 && compare(end, range.start) >= 0
                                : compare(start, range.end) < 0 && compare(end, range.start) > 0;
                        }) };
                    }
                    const method = input.kind === 'documentSymbols' ? 'documentSymbol' : input.kind === 'codeActions' || input.kind === 'organizeImports' ? 'codeAction' : input.kind;
                    value = await opened.client.request(input.kind === 'willRenameFiles' ? 'workspace/willRenameFiles' : `textDocument/${method}`,
                        input.kind === 'willRenameFiles' ? { files: [{ oldUri: uri(input.path), newUri: uri(input.newPath!) }] }
                            : { textDocument: { uri: uri(input.path) }, ...(input.position ? { position: input.position } : {}),
                                ...(input.kind === 'references' ? { context: { includeDeclaration: input.includeDeclaration ?? true } } : {}),
                                ...(input.kind === 'rename' ? { newName: input.newName } : {}),
                                ...(codeActionContext ? { range: input.range ?? { start: input.position ?? { line: 0, character: 0 }, end: input.position ?? { line: 0, character: 0 } }, context: codeActionContext } : {}) }, { signal: input.signal });
                    if (input.kind === 'organizeImports' && Array.isArray(value)) {
                        value = value.filter(action => {
                            const kind = readLspObject(action)?.kind;
                            return typeof kind === 'string' && (kind === 'source.organizeImports' || kind.startsWith('source.organizeImports.'));
                        });
                    }
                    if ((input.kind === 'codeActions' || input.kind === 'organizeImports') && codeActionResolve && Array.isArray(value)) {
                        value = await Promise.all(value.map(async action => {
                            const object = readLspObject(action);
                            return object && object.edit === undefined && typeof object.command !== 'string' && object.disabled === undefined
                                ? opened.client.request('codeAction/resolve', action as JsonValue, { signal: input.signal }) : action;
                        }));
                    }
                    if (input.kind === 'organizeImports' && Array.isArray(value)) {
                        const actionable = value.filter(action => readLspObject(action)?.disabled === undefined);
                        const edits = actionable.filter(action => readLspObject(action)?.edit !== undefined);
                        if (actionable.length && !edits.length) throw new LanguageServerSessionError('unsupported');
                        value = edits;
                    }
                }
                if (input.signal?.aborted) throw new LanguageServerSessionError('cancelled');
                if (requestGeneration !== generation || documents.get(input.path)?.version !== version || documents.get(input.path)?.text !== document.text)
                    throw new LanguageServerSessionError('stale_query');
                if (semanticBaseline) semanticBaselines.set(input.path, semanticBaseline);
                return { value, loading: diagnosticsLoading || wasLoading || loadingTokens.size > 0, generation: requestGeneration, version };
            }
            catch (error) {
                if (disposed || stopping) throw new LanguageServerSessionError('session_unavailable', { cause: error });
                if (requestGeneration !== generation) throw new LanguageServerSessionError('stale_query', { cause: error });
                throw failure(error);
            }
        },
        async executeCommand(command, applyEdit, signal) {
            await start();
            await operations;
            if (signal?.aborted) throw new LanguageServerSessionError('cancelled');
            if (!protocol || state !== 'ready') throw new LanguageServerSessionError('session_unavailable');
            if (mutation) throw new LanguageServerSessionError('request_failed');
            if (!executeCommands.includes(command.command)) throw new LanguageServerSessionError('unsupported');
            const writes: Promise<boolean>[] = [];
            const authority = { signal, applyEdit(edit: unknown) { const result = applyEdit(edit); writes.push(result); return result; } };
            mutation = authority;
            let commandFailure: LanguageServerSessionError | undefined;
            try {
                await protocol.client.request('workspace/executeCommand', command, { signal });
            } catch (error) { commandFailure = failure(error); }
            finally {
                if (mutation === authority) mutation = undefined;
            }
            const applied = await Promise.allSettled(writes);
            if (signal?.aborted) throw new LanguageServerSessionError('cancelled');
            if (commandFailure) throw commandFailure;
            if (applied.some(result => result.status === 'rejected' || !result.value)) throw new LanguageServerSessionError('request_failed');
        },
        async didRenameFiles(files) {
            if (state === 'ready' && protocol) await protocol.client.notify('workspace/didRenameFiles', {
                files: files.map(file => ({ oldUri: uri(file.path), newUri: uri(file.renameTo) })),
            });
        },
        async restart() { await stop(); if (disposed)
            return; state = 'idle'; reason = undefined; generation = randomUUID(); if (documents.size)
            await start().catch(() => undefined); },
        async dispose() { disposed = true; await stop(); pulls.dispose(); documents.clear(); },
    };
    return session;
}
