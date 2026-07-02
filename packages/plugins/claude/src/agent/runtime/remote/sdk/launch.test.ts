import { describe, expect, it } from 'vitest';

import {
    applyClaudeAgentSdkAdvancedOptions,
    resolveClaudeAgentSdkExtraArgs,
    resolveClaudeCodeExperimentalEnvOverlay,
} from './launch.js';

describe('Claude remote SDK launch helpers', () => {
    it('builds Claude Agent SDK extra args for checkpointing and debug modes', () => {
        expect(resolveClaudeAgentSdkExtraArgs({
            enableFileCheckpointing: true,
            debugEnabled: true,
            verboseEnabled: true,
            debugCategories: ['api', 'hooks'],
        })).toEqual({
            'replay-user-messages': null,
            debug: 'api,hooks',
            verbose: null,
        });
    });

    it('allowlists advanced Claude Agent SDK options without copying arbitrary values', () => {
        const queryOptions: Record<string, unknown> = {};
        const stderr = () => undefined;

        applyClaudeAgentSdkAdvancedOptions({
            queryOptions,
            advancedOptions: {
                debug: true,
                debugFile: '/tmp/claude-debug.log',
                stderr,
                notAllowed: 'drop',
            },
        });

        expect(queryOptions).toEqual({
            debug: true,
            debugFile: '/tmp/claude-debug.log',
            stderr,
        });
    });

    it('builds the Claude experimental teams env overlay only when enabled', () => {
        expect(resolveClaudeCodeExperimentalEnvOverlay({
            claudeCodeExperimentalAgentTeamsEnabled: false,
        })).toEqual({});
        expect(resolveClaudeCodeExperimentalEnvOverlay({
            claudeCodeExperimentalAgentTeamsEnabled: true,
        })).toEqual({
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        });
    });
});
