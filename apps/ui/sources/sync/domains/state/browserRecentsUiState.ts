import { z } from 'zod/mini';
import { BrowserViewTargetV1Schema, type BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { rememberBrowserRecentTarget, type BrowserRecentTarget } from '@/sync/domains/browser/targets/recents';
import { createPersistentUiState, UiStatePersistenceError, usePersistentUiStateValue } from './persistentUiState';

const schema = z.array(z.object({ target: BrowserViewTargetV1Schema, openedAt: z.number() }));
const EMPTY_RECENTS: readonly BrowserRecentTarget[] = [];

/** Device-local history, partitioned by Home/Account; never synchronized preferences. */
export const browserRecentsState = createPersistentUiState<readonly BrowserRecentTarget[]>(
    'browser-recents-v1', value => z.catch(schema, []).parse(value),
);

export function useBrowserRecentTargets(scope: ServerAccountScope | null): readonly BrowserRecentTarget[] {
    return usePersistentUiStateValue(browserRecentsState, scope ? serverAccountScopeKeySuffix(scope) : null) ?? EMPTY_RECENTS;
}

export function rememberOpenedBrowserTarget(scope: ServerAccountScope, target: BrowserViewTargetV1): void {
    const key = serverAccountScopeKeySuffix(scope);
    try {
        browserRecentsState.set(key, rememberBrowserRecentTarget(browserRecentsState.read(key) ?? EMPTY_RECENTS,
            { target, openedAt: Date.now() }));
    } catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[browser] Recent target could not be persisted.');
    }
}
