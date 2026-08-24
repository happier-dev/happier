import * as React from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
    garbageCollectAgentInputLocalUiState,
} from '@/sync/domains/input/draftValues/agentInputLocalUiStateStore';
import {
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

const AGENT_INPUT_DRAFT_GC_FOREGROUND_INTERVAL_MS = 60 * 60 * 1000;

const lastGarbageCollectionAtByScopeKey = new Map<string, number>();

function composerDraftGarbageCollectionScopeKey(scope: ServerAccountScope | null): string {
    return scope ? `scope:${serverAccountScopeKeySuffix(scope)}` : 'scope:local';
}

function runAgentInputComposerDraftGarbageCollection(
    scope: ServerAccountScope | null,
    options: Readonly<{
        now: number;
        reason: 'scopeActivated' | 'foreground';
        force?: boolean;
    }>,
): void {
    const scopeKey = composerDraftGarbageCollectionScopeKey(scope);
    const previousRunAt = lastGarbageCollectionAtByScopeKey.get(scopeKey);
    if (
        options.force !== true
        && typeof previousRunAt === 'number'
        && options.now - previousRunAt < AGENT_INPUT_DRAFT_GC_FOREGROUND_INTERVAL_MS
    ) {
        return;
    }

    garbageCollectAgentInputLocalUiState(scope, {
        now: options.now,
        reason: options.reason,
    });
    lastGarbageCollectionAtByScopeKey.set(scopeKey, options.now);
}

export function useAgentInputComposerDraftGarbageCollection(scope: ServerAccountScope | null): void {
    const latestScopeRef = React.useRef(scope);
    latestScopeRef.current = scope;

    React.useEffect(() => {
        runAgentInputComposerDraftGarbageCollection(scope, {
            now: Date.now(),
            reason: 'scopeActivated',
            force: true,
        });
    }, [scope]);

    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
            if (nextState !== 'active') return;
            runAgentInputComposerDraftGarbageCollection(latestScopeRef.current, {
                now: Date.now(),
                reason: 'foreground',
            });
        });

        return () => {
            subscription.remove();
        };
    }, []);

    React.useEffect(() => {
        if (typeof document === 'undefined') return undefined;

        const handleVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            runAgentInputComposerDraftGarbageCollection(latestScopeRef.current, {
                now: Date.now(),
                reason: 'foreground',
            });
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);
}
