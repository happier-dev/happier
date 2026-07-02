import { describe, expect, it } from 'vitest';

import { coerceClaudeToolResultText, extractAgentIdFromTaskResultText, extractOutputFilePathFromTaskResultText } from './taskResult.js';

describe('extractAgentIdFromTaskResultText', () => {
    it('extracts agent_id values that include @ for agent teams', () => {
        const res = extractAgentIdFromTaskResultText(
            'Spawned successfully.\nagent_id: alpha@happier-ui-sidechain\nteam_name: happier-ui-sidechain\n',
        );

        expect(res.agentId).toBe('alpha@happier-ui-sidechain');
    });

    it('extracts agentId values without @ for hashed ids', () => {
        const res = extractAgentIdFromTaskResultText('done\nagentId: a6ca4a6\n');
        expect(res.agentId).toBe('a6ca4a6');
    });

    it('extracts output_file paths and augments structured tool_use_result fields', () => {
        expect(extractOutputFilePathFromTaskResultText('done\noutput_file="/tmp/out.jsonl"\n')).toBe('/tmp/out.jsonl');

        expect(coerceClaudeToolResultText({
            content: [{ type: 'text', text: 'Spawned successfully.' }],
            tool_use_result: {
                agent_id: 'alpha@team',
                task_id: 'task-1',
                team_name: 'team',
            },
        })).toBe([
            'Spawned successfully.',
            'agent_id: alpha@team',
            'task_id: task-1',
            'team_name: team',
        ].join('\n'));
    });
});
