import { describe, expect, it } from 'vitest';

import { resolveSessionPermissionBehavior } from '@/sync/ops/sessionPermissionAnswers';
import { getPermissionFooterCopy } from './permissionUiCopy';

const UNAVAILABLE_PROTOCOL_COPY = {
    protocol: 'unavailable',
    denyKey: 'common.no',
};

const CLAUDE_COPY = {
    protocol: 'claude',
    yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
    yesForToolKey: 'claude.permissions.yesForTool',
    stopKey: 'claude.permissions.stop',
};

const CODEX_DECISION_COPY = {
    protocol: 'codexDecision',
    yesAlwaysAllowCommandKey: 'codex.permissions.yesAlwaysAllowCommand',
    yesForSessionKey: 'codex.permissions.yesForSession',
    stopKey: 'codex.permissions.stop',
};

describe('getPermissionFooterCopy', () => {
    it('fails closed when an Agent declares no known prompt protocol', () => {
        expect(getPermissionFooterCopy(undefined)).toEqual(UNAVAILABLE_PROTOCOL_COPY);
        expect(getPermissionFooterCopy(null)).toEqual(UNAVAILABLE_PROTOCOL_COPY);
    });

    it('selects the decision-protocol copy from the declared protocol alone', () => {
        expect(getPermissionFooterCopy('codexDecision')).toEqual(CODEX_DECISION_COPY);
        expect(getPermissionFooterCopy('claude')).toEqual(CLAUDE_COPY);
    });

    it('reads the frozen predecessor protocol used by legacy permission presenters', () => {
        const behavior = (agentId: string) => resolveSessionPermissionBehavior({
            agentId, metadata: { flavor: agentId }, accountScope: null,
        });
        expect(getPermissionFooterCopy(behavior('codex')?.promptProtocol))
            .toEqual(CODEX_DECISION_COPY);
        expect(getPermissionFooterCopy(behavior('claude')?.promptProtocol))
            .toEqual(CLAUDE_COPY);
    });
});
