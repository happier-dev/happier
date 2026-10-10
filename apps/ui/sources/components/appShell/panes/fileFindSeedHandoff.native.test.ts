import { describe, expect, it } from 'vitest';
import { createFileFindSeedHandoff } from './fileFindSeedHandoff';
import { makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol/sessions/external/historicalImportIdentity';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

describe('native History launch input at the chat handoff owner', () => {
    it('normalizes native identity once and retains the incumbent one-shot Account retirement contract', () => {
        const handoff = createFileFindSeedHandoff();
        let current = true;
        const listeners = new Set<() => void>();
        // Credential lifetime is the environment boundary; the handoff and native identity owner are real.
        const authority: ServerAccountScopeLifetime = { scope: { serverId: 'home', accountId: 'account' },
            isCurrent: () => current, onRetire: cancel => { listeners.add(cancel); return { dispose: () => { listeners.delete(cancel); } }; } };
        const destination = { sessionId: 'linked', serverId: 'home', accountId: 'account' };
        const seed = { query: 'needle', target: { kind: 'native-message' as const,
            agentId: 'claude', remoteSessionId: 'native', sourceItemId: 'item' } };
        handoff.stageChat(destination, seed, authority);
        expect(handoff.takeChatCurrent(destination)?.seed).toEqual({ query: 'needle', options: { matchCase: false, regex: false },
            target: { kind: 'route-message-id', routeMessageId: makeExternalSessionHistoricalImportLocalId({
                agentId: 'claude', remoteSessionId: 'native', directItemId: 'item' }) } });
        expect(handoff.takeChatCurrent(destination)).toBeNull();
        handoff.stageChat(destination, seed, authority);
        current = false;
        for (const cancel of [...listeners]) cancel();
        current = true;
        expect(handoff.takeChatCurrent(destination)).toBeNull();
        const cancel = handoff.stageChat(destination, seed, authority);
        cancel();
        expect(handoff.takeChatCurrent(destination)).toBeNull();
        handoff.stageChat({ ...destination, accountId: 'another-account' }, seed, authority);
        expect(handoff.takeChatCurrent(destination)).toBeNull();
        handoff.dispose();
    });
});
