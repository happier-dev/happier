import { describe, expect, it } from 'vitest';

import { getPermissionFooterCopy } from './permissionUiCopy';

const NEUTRAL_CLAUDE_COPY = {
    protocol: 'claude',
    yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
    yesForToolKey: 'claude.permissions.yesForTool',
    stopKey: 'claude.permissions.stop',
};

describe('getPermissionFooterCopy', () => {
    it('gives an installed external Agent the neutral default a bundled Agent already gets', () => {
        expect(getPermissionFooterCopy('acme.agent')).toEqual(NEUTRAL_CLAUDE_COPY);
    });

    it('keeps the decision-protocol copy for a bundled Agent that declares it', () => {
        expect(getPermissionFooterCopy('codex')).toEqual({
            protocol: 'codexDecision',
            yesAlwaysAllowCommandKey: 'codex.permissions.yesAlwaysAllowCommand',
            yesForSessionKey: 'codex.permissions.yesForSession',
            stopKey: 'codex.permissions.stop',
        });
    });

    it('keeps the Claude protocol copy for the bundled Claude Agent', () => {
        expect(getPermissionFooterCopy('claude')).toEqual(NEUTRAL_CLAUDE_COPY);
    });
});
