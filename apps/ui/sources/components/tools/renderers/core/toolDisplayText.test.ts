import { describe, expect, it } from 'vitest';
import { makeToolCall } from '@/dev/testkit';
import { projectToolFindText } from './toolDisplayText';

describe('projectToolFindText', () => {
    it('projects a turn recap rather than the hidden Diff header and code body', () => {
        const tool = makeToolCall({ name: 'Diff', state: 'completed', input: {
            _happier: {
                sessionChangeScope: 'turn', turnId: 'turn-4', sessionId: 'session-1', provider: 'claude',
                source: 'canonical_diff_tool', confidence: 'exact', turnStatus: 'completed',
                seqRange: { startSeqInclusive: 10, endSeqInclusive: 20 },
            },
            files: [{ file_path: 'src/needle.ts', change_kind: 'modified', unified_diff: '--- a/src/needle.ts\n+++ b/src/needle.ts\n@@ -1 +1 @@\n-hidden raw old\n+hidden raw new\n' }],
        } });
        const blocks = projectToolFindText(tool);
        expect(blocks.find((block) => block.id === 'tool-title')).toBeUndefined();
        expect(blocks.some((block) => block.id === 'tool-turn-changes-title')).toBe(true);
        expect(blocks.map((block) => block.text).join('\n')).toContain('needle.ts');
        expect(blocks.map((block) => block.text).join('\n')).not.toContain('hidden raw');
        const emptyRecap = makeToolCall({ name: 'Diff', input: { _happier: tool.input._happier, files: [] } });
        expect(projectToolFindText(emptyRecap).some((block) => block.id === 'tool-title')).toBe(true);
    });
    it('excludes a specialized body when a terminal permission error replaces it', () => {
        const tool = makeToolCall({
            name: 'Bash', state: 'error', input: { command: 'hidden command' }, result: 'hidden result',
            permission: { id: 'permission', status: 'denied' },
        });
        const blocks = projectToolFindText(tool);
        expect(blocks.find((block) => block.id === 'tool-error-override')?.text).toBeTruthy();
        expect(blocks.filter((block) => block.kind === 'toolBody').map((block) => block.id)).toEqual(['tool-error-override']);
        expect(blocks.map((block) => block.text).join('\n')).not.toContain('hidden result');
    });

    it('includes the exact JSON error appended by the common shell', () => {
        const result = { message: 'rendered failure', code: 'failure-code' };
        const tool = makeToolCall({ name: 'NewTool', state: 'error', input: {}, result });
        expect(projectToolFindText(tool).find((block) => block.id === 'tool-error-append')?.text).toBe(JSON.stringify(result, null, 2));
    });
});
