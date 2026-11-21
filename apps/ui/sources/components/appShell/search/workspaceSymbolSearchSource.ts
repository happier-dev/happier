import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { mergeAbortSignals } from '@happier-dev/plugin-sdk/async';
import type { LanguageIntelligenceQueryResult } from '@happier-dev/protocol/machines/languageIntelligence';
import { loadDocumentOutlineBaseline } from '@/sync/domains/workspaces/languageIntelligence/loadDocumentOutlineBaseline';
import { selectDocumentOutline, type DocumentOutlineServerAnswer } from '@/sync/domains/workspaces/languageIntelligence/documentOutline';
import { buildUniversalSearchWorkspaceScopeKey, type UniversalSearchResult, type UniversalSearchTarget } from './universalSearchResult';
import { buildUniversalSearchSymbolResults } from './workspaceSymbolSearchResults';
import { boundedReplyHints } from './searchBoundedReplyHints';

export type WorkspaceSymbolSearchInput = Readonly<{
    target: Extract<UniversalSearchTarget, { kind: 'workspaceFile' }>;
    resolverKey: string;
    getText(): string;
    flushPendingChange(): void | Promise<void>;
    /** Reads an already activated controller only; this must never open a server session. */
    getServerOutline?(signal: AbortSignal): Promise<DocumentOutlineServerAnswer | null>;
    /** Explicit Symbols searches ask the same controller as code.symbols.workspace. */
    getWorkspaceSymbols?(query: string, signal: AbortSignal): Promise<LanguageIntelligenceQueryResult | null>;
    loadingHint?: string;
    /** Makes the narrower, local fallback explicit when the project service cannot answer. */
    baselineHint?: string;
    isCurrent(): boolean;
    accountLifetime: ServerAccountScopeLifetime;
    language: string;
    isDark: boolean;
    colors?: Record<string, unknown> | null;
    unavailableHint: string;
}>;

export type WorkspaceSymbolSearchSource = Readonly<{
    status: 'ready';
    resolverKey: string;
    resolve(query: string, signal: AbortSignal): Promise<Readonly<{ results: readonly UniversalSearchResult[]; emptyHint?: string; resultHint?: string }>>;
}>;

export function createWorkspaceSymbolSearchSource(input: WorkspaceSymbolSearchInput): WorkspaceSymbolSearchSource {
    let pending: AbortController | null = null;
    return {
        status: 'ready',
        resolverKey: buildUniversalSearchWorkspaceScopeKey(input.target.accountId, input.target.scope,
            [input.target.path, input.resolverKey]),
        resolve: async (query, callerSignal) => {
            pending?.abort();
            const operation = new AbortController();
            pending = operation;
            const cancellation = mergeAbortSignals([operation.signal, callerSignal]);
            const signal = cancellation.signal;
            const assertCurrent = () => {
                if (signal.aborted || !input.isCurrent() || !input.accountLifetime.isCurrent()
                    || input.accountLifetime.scope.accountId !== input.target.accountId
                    || input.accountLifetime.scope.serverId !== input.target.scope.serverId
                    || (input.target.serverId !== null && input.target.serverId !== input.target.scope.serverId)) {
                    const error = new Error('Active file symbol source retired');
                    error.name = 'AbortError';
                    throw error;
                }
            };
            try {
                assertCurrent();
                await input.flushPendingChange();
                assertCurrent();
                if (input.getWorkspaceSymbols) {
                    const answer = await input.getWorkspaceSymbols(query, signal);
                    assertCurrent();
                    if (answer?.status === 'ok' && answer.kind === 'workspaceSymbol') {
                        const results = answer.symbols.filter(symbol => !symbol.outsideWorkspace).flatMap(symbol => {
                            const outline = selectDocumentOutline({ baseline: { status: 'ok', symbols: [] }, server: {
                                capable: true, state: 'ready', loading: false, symbols: [{
                                    serverId: symbol.serverId, name: symbol.name, kind: symbol.kind,
                                    range: symbol.range, selectionRange: symbol.range,
                                }],
                            } });
                            return outline.status === 'ok' ? buildUniversalSearchSymbolResults(outline.symbols.map(entry => ({
                                ...entry, ...(symbol.containerName ? { container: symbol.containerName } : {}),
                            })), { ...input.target, path: symbol.path }) : [];
                        });
                        return { results, ...boundedReplyHints({ rowCount: results.length, incomplete: answer.hasMore }) };
                    }
                    if (answer?.status === 'loading') return { results: [], emptyHint: input.loadingHint ?? input.unavailableHint };
                    // An unavailable/older/offline Machine does not remove the local document baseline.
                    if (answer && answer.status !== 'unavailable'
                        && !(answer.status === 'error' && answer.errorCode === 'unsupported')) {
                        return { results: [], emptyHint: input.unavailableHint };
                    }
                }
                const text = input.getText();
                const [baseline, server] = await Promise.all([
                    loadDocumentOutlineBaseline({
                        lines: text.split(/\r\n|\r|\n/u), language: input.language, isDark: input.isDark, colors: input.colors,
                    }),
                    input.getServerOutline?.(signal).catch(() => null) ?? null,
                ]);
                assertCurrent();
                if (input.getText() !== text) {
                    const error = new Error('Active file changed during symbol search');
                    error.name = 'AbortError';
                    throw error;
                }
                const outline = selectDocumentOutline({ baseline, server });
                if (outline.status === 'unavailable') return { results: [], emptyHint: input.unavailableHint };
                const needle = query.trim().toLocaleLowerCase();
                return {
                    results: buildUniversalSearchSymbolResults(
                        outline.symbols.filter(symbol => symbol.name.toLocaleLowerCase().includes(needle)), input.target,
                    ),
                    ...(input.getWorkspaceSymbols && input.baselineHint ? { resultHint: input.baselineHint } : {}),
                };
            } finally {
                cancellation.dispose();
                if (pending === operation) pending = null;
            }
        },
    };
}
