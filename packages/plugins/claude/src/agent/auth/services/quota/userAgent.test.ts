import { describe, expect, it } from 'vitest';

import { resolveClaudeCodeUsageUserAgent } from './userAgent.js';

describe('resolveClaudeCodeUsageUserAgent', () => {
    it('uses provider-owned Claude Code user agents and ignores generic quota user agents', () => {
        expect(resolveClaudeCodeUsageUserAgent({
            configuredUserAgent: 'generic-happier-agent',
        })).toMatch(/^claude-code\//);
        expect(resolveClaudeCodeUsageUserAgent({
            configuredUserAgent: 'claude-code/1.2.3',
        })).toBe('claude-code/1.2.3');
    });

    it('supports a Claude-specific environment override', () => {
        expect(resolveClaudeCodeUsageUserAgent({
            env: {
                HAPPIER_CONNECTED_SERVICES_CLAUDE_CODE_USER_AGENT: 'claude-code/9.8.7',
            },
            configuredUserAgent: 'generic-happier-agent',
        })).toBe('claude-code/9.8.7');
    });
});
