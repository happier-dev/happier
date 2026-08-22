import { describe, expect, it } from 'vitest';

import { extractStdStreams } from './stdStreams';

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
});
