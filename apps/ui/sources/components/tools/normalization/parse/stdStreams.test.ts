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
});
