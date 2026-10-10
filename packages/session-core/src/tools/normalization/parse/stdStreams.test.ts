import { describe, expect, it } from 'vitest';

import { extractStdStreams } from "./stdStreams.js";

describe('extractStdStreams', () => {
    it('normalizes camelCase command execution output envelopes', () => {
        expect(extractStdStreams({
            aggregatedOutput: '/workspace\n',
            exitCode: 0,
        })).toEqual({
            stdout: '/workspace\n',
            exitCode: 0,
        });
    });

    it('unwraps ACP text content as stdout while preserving explicit stream precedence', () => {
        expect(extractStdStreams({
            content: [
                { type: 'text', text: 'line one\n' },
                { type: 'image', data: 'aGk=', mimeType: 'image/png' },
                { type: 'text', text: 'line two' },
            ],
            details: { exit_code: 0 },
        })).toEqual({ stdout: 'line one\nline two' });

        expect(extractStdStreams({
            stdout: 'explicit',
            content: [{ type: 'text', text: 'content fallback' }],
        })).toEqual({ stdout: 'explicit' });
    });

    it('does not manufacture stdout from non-text ACP content', () => {
        expect(extractStdStreams({
            content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
        })).toBeNull();
    });

    it('reads persisted native string content while keeping canonical stdout authoritative', () => {
        // Native Claude shape observed at seq 12 of cmv22orej0085tm3p0v0vi230;
        // the current 0.2 producer also preserves this shape without stdout.
        const content = '/workspace/round4/package.json\n';
        const result = { content, tool_use_result: { stdout: content, stderr: '' } };
        expect(extractStdStreams(result)).toEqual({ stdout: content });
        expect(extractStdStreams({ ...result, stdout: '' })).toEqual({ stdout: '' });
    });
});
