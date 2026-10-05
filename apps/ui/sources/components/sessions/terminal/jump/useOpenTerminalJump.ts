import * as React from 'react';

import { useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useOptionalUniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';

/**
 * Open the command palette in its Terminals scope for one session (terminal lab B4, ⌘J). Every
 * entry point (the strip ⋯ menu, the keyboard command, the phone Terminal page) goes through this
 * one opener, so the Jump always addresses the pane scope of the destination it was opened from.
 * Null when the palette runtime is not mounted (a surface hosted outside the app shell).
 */
export function useOpenTerminalJump(): ((input: Readonly<{ sessionId: string; serverId: string | null; scopeId?: string }>) => void) | null {
    const runtime = useOptionalUniversalSearchRuntime();
    const instanceKey = useDestinationInstanceKey();
    return React.useMemo(() => {
        if (!runtime) return null;
        return (input) => {
            const scopeId = input.scopeId ?? createSessionPaneScopeId(input.sessionId, input.serverId, instanceKey);
            runtime.open(undefined, undefined, { terminals: { scopeId } });
        };
    }, [instanceKey, runtime]);
}
