import * as React from 'react';

import type { Command } from '@/components/appShell/commandPalette/types';
import type { TerminalJumpTarget } from '@/components/sessions/terminal/jump/terminalJumpTarget';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { WorkspaceSymbolSearchInput } from './workspaceSymbolSearchSource';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type UniversalSearchScopeSeed = Readonly<{
    accountId: string | null;
    serverId: string | null;
    sessionId: string | null;
    machineId: string | null;
    rootPath: string | null;
    workspace?: WorkspaceScopeBase['workspace'];
    machineScope?: 'all';
}>;

/** Canonicalize the one portable Home identity at Search ingress. */
export function canonicalizeUniversalSearchScopeSeed(
    scope: UniversalSearchScopeSeed,
): UniversalSearchScopeSeed {
    const serverId = resolveServerProfileScopeIdForIdentifier(scope.serverId) || null;
    return serverId === scope.serverId ? scope : { ...scope, serverId };
}

export function resolveUniversalSearchInvocationScope(input: Readonly<{
    requestedScope?: UniversalSearchScopeSeed;
    ambientScope: UniversalSearchScopeSeed;
}>): UniversalSearchScopeSeed {
    return canonicalizeUniversalSearchScopeSeed(input.requestedScope ?? input.ambientScope);
}

/** What Search opens on: everything (default), or one session's terminals (Jump, terminal lab B4). */
export type UniversalSearchSourceFocus = 'files' | 'fileContent' | 'symbols';

export type UniversalSearchOpenOptions = Readonly<{
    terminals?: TerminalJumpTarget;
    source?: UniversalSearchSourceFocus;
    /** Text in files opens with the Replace field shown (⌘⇧H). */
    replace?: boolean;
    /** Existing active document holder; private invocation memory, never a route parameter. */
    symbols?: WorkspaceSymbolSearchInput;
}>;

export type UniversalSearchRuntime = Readonly<{
    open(query?: string, scope?: UniversalSearchScopeSeed, options?: UniversalSearchOpenOptions): void;
    buildCommands(activeSessionId?: string | null, scope?: UniversalSearchScopeSeed, symbols?: WorkspaceSymbolSearchInput): readonly Command[];
    /** Retained only while the native Search route owns this invocation. */
    routeSymbols?: WorkspaceSymbolSearchInput;
    /** The native Search host releases the Session presenter when its exit finishes. */
    releaseSessionCommands?(): void;
}>;

const UniversalSearchRuntimeContext = React.createContext<UniversalSearchRuntime | null>(null);

export const UniversalSearchRuntimeProvider = UniversalSearchRuntimeContext.Provider;

/** For owners mounted where the runtime may be absent (the palette provider that mounts it). */
export function useOptionalUniversalSearchRuntime(): UniversalSearchRuntime | null {
    return React.useContext(UniversalSearchRuntimeContext);
}

export function useUniversalSearchRuntime(): UniversalSearchRuntime {
    const runtime = React.useContext(UniversalSearchRuntimeContext);
    if (!runtime) throw new Error('Universal Search runtime is not mounted');
    return runtime;
}
