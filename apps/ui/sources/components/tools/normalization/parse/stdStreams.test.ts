import { describe, expect, it } from 'vitest';

import { extractStdStreams } from './stdStreams';

describe('extractStdStreams', () => {
    it('unwraps ACP-style content arrays (Pi) into stdout', () => {
        expect(extractStdStreams({
            content: [{ type: 'text', text: 'line one\nline two' }],
            details: { exit_code: 0 },
            isError: false,
        })).toEqual({ stdout: 'line one\nline two' });
    });

    it('joins multiple text blocks in a content array', () => {
        expect(extractStdStreams({
            content: [
                { type: 'text', text: 'out\n' },
                { type: 'image', data: 'aGk=', mimeType: 'image/png' },
                { type: 'text', text: 'more' },
            ],
        })).toEqual({ stdout: 'out\nmore' });
    });

    it('returns null for a content array with no text blocks', () => {
        expect(extractStdStreams({
            content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
        })).toBeNull();
    });

    it('prefers explicit stdout over the content array when both exist', () => {
        expect(extractStdStreams({
            stdout: 'explicit',
            content: [{ type: 'text', text: 'from content' }],
        })).toEqual({ stdout: 'explicit' });
    });

    it('still accepts plain stream envelopes and raw strings', () => {
        expect(extractStdStreams('raw string')).toEqual({ stdout: 'raw string' });
        expect(extractStdStreams({ stdout: 'a', stderr: 'b' })).toEqual({ stdout: 'a', stderr: 'b' });
        expect(extractStdStreams({ aggregated_output: 'c' })).toEqual({ stdout: 'c' });
    });
});
