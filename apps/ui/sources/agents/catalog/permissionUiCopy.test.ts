import { describe, expect, it } from 'vitest';

import { getAgentBehavior } from './catalog';
import { getPermissionFooterCopy } from './permissionUiCopy';

const NEUTRAL_CLAUDE_COPY = {
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
    it('gives an Agent that declares no protocol the neutral default', () => {
        expect(getPermissionFooterCopy(undefined)).toEqual(NEUTRAL_CLAUDE_COPY);
        expect(getPermissionFooterCopy(null)).toEqual(NEUTRAL_CLAUDE_COPY);
    });

    it('selects the decision-protocol copy from the declared protocol alone', () => {
        expect(getPermissionFooterCopy('codexDecision')).toEqual(CODEX_DECISION_COPY);
        expect(getPermissionFooterCopy('claude')).toEqual(NEUTRAL_CLAUDE_COPY);
    });

    it('reads the same protocol a bundled Agent publishes through its UI behavior', () => {
        // The behavior projection — not a bundled-only core lookup — is the one
        // owner the footer consults, so a bundled and an installed Agent reach
        // this copy the same way.
        expect(getPermissionFooterCopy(getAgentBehavior('codex').permissions?.promptProtocol))
            .toEqual(CODEX_DECISION_COPY);
        expect(getPermissionFooterCopy(getAgentBehavior('claude').permissions?.promptProtocol))
            .toEqual(NEUTRAL_CLAUDE_COPY);
    });
});
