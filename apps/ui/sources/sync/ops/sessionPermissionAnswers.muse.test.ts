import { describe, expect, it } from 'vitest';

import {
    resolveSessionPermissionAnswerPolicy,
    resolveSessionPermissionAnswers,
    resolveSessionPermissionBehavior,
} from './sessionPermissionAnswers';

describe('frozen permission answer policy', () => {
    it('refuses an offerless Muse occurrence while retaining released predecessor answers', () => {
        const answersFor = (agentId: string) => {
            const permissionBehavior = resolveSessionPermissionBehavior({ agentId, metadata: null, accountScope: null });
            const policy = resolveSessionPermissionAnswerPolicy({ permissionBehavior, suggestions: undefined });
            return resolveSessionPermissionAnswers({ toolName: 'Bash', protocol: policy.protocol });
        };

        expect(answersFor('muse')).toEqual(['deny']);
        expect(answersFor('claude')).toEqual(['allowOnce', 'allowForSession', 'deny']);
        expect(answersFor('codex')).toEqual(['allowOnce', 'allowForSession', 'deny']);
    });
});
