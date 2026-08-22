import { describe, expect, it } from 'vitest';

import {
    CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
    findMissingClaudeCodeCredentialScopes,
    parseClaudeCodeCredentialScopes,
} from './scopes.js';

describe('claudeCodeCredentialScopes', () => {
    it('declares the complete Claude Code OAuth scope string', () => {
        expect(CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE).toBe(
            'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
        );
    });

    it('parses scopes from strings and arrays without duplicates', () => {
        expect(parseClaudeCodeCredentialScopes(' user:profile  user:profile user:inference ')).toEqual([
            'user:profile',
            'user:inference',
        ]);
    });

    it('requires Claude Code session scope for native auth', () => {
        expect(findMissingClaudeCodeCredentialScopes('user:inference user:profile')).toEqual([
            'user:sessions:claude_code',
        ]);
    });
});
