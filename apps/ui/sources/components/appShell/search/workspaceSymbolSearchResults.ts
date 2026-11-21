import type { DocumentOutlineEntry } from '@/sync/domains/workspaces/languageIntelligence/documentOutline';

import { buildUniversalSearchScopeKey, buildUniversalSearchWorkspaceScopeKey, UNIVERSAL_SEARCH_SOURCE_IDS, type UniversalSearchResult, type UniversalSearchTarget } from './universalSearchResult';

export function buildUniversalSearchSymbolResults(
    symbols: readonly DocumentOutlineEntry[],
    target: Extract<UniversalSearchTarget, { kind: 'workspaceFile' }>,
): UniversalSearchResult[] {
    const scopeKey = buildUniversalSearchWorkspaceScopeKey(target.accountId, target.scope, [target.path]);
    return symbols.map(symbol => ({
        id: buildUniversalSearchScopeKey([target.path, symbol.line, symbol.column, symbol.name]),
        scopeKey,
        sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.symbols,
        kind: 'workspaceSymbol',
        title: symbol.name,
        subtitle: `${target.path}:${symbol.line}`,
        searchText: symbol.name,
        symbol: { kind: symbol.kind, line: symbol.line, depth: symbol.depth,
            ...(symbol.container !== undefined ? { container: symbol.container } : {}) },
        target: {
            kind: 'workspaceSymbol',
            scope: target.scope,
            path: target.path,
            anchor: { kind: 'fileLine', startLine: symbol.line },
            workspaceRefId: target.workspaceRefId,
            sessionId: target.sessionId,
            serverId: target.scope.serverId,
            accountId: target.accountId,
        },
    }));
}
