import { describe, expect, it } from 'vitest';
import { browserRecentsState, rememberOpenedBrowserTarget } from './browserRecentsUiState';
import { createPersistentUiState } from './persistentUiState';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';

describe('device-local Browser recents', () => {
    it('restores all targets after reload, deduplicates reopening, and isolates Home/Account history', () => {
        const scope = { serverId: 'recents-persistence-home', accountId: 'alice' };
        const key = serverAccountScopeKeySuffix(scope);
        browserRecentsState.remove(key);
        try {
            for (let i = 0; i < 13; i++) rememberOpenedBrowserTarget(scope,
                { kind: 'externalUrl', targetId: `docs-${i}`, url: `https://example.com/${i}` });
            const updated = { kind: 'externalUrl', targetId: 'docs-0', url: 'https://example.com/updated' } as const;
            rememberOpenedBrowserTarget(scope, updated);
            // A fresh reader consumes persisted bytes, rather than the first owner's memory.
            const restored = createPersistentUiState('browser-recents-v1', value => value);
            expect(restored.read(key)).toEqual(browserRecentsState.read(key));
            expect(browserRecentsState.read(key)).toHaveLength(13);
            expect(browserRecentsState.read(key)?.[0].target).toEqual(updated);
            expect(restored.read(serverAccountScopeKeySuffix({ ...scope, accountId: 'bob' }))).toBeUndefined();
            expect(restored.read(serverAccountScopeKeySuffix({ ...scope, serverId: 'another-home' }))).toBeUndefined();
        } finally { browserRecentsState.remove(key); }
    });
});
