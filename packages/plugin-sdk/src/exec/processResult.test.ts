import { expect, it } from 'vitest';
import type { PluginProcessResult } from '../services/io.js';
import { isSuccessfulProcessResult } from './index.public.js';

it('treats a requested termination as failure even when the process exits zero', () => {
    const result: PluginProcessResult = {
        termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        stdoutTruncated: false,
        stderrTruncated: false,
    };

    expect(isSuccessfulProcessResult(result)).toBe(true);
    expect(isSuccessfulProcessResult({
        ...result,
        termination: { ...result.termination, requestedBy: { kind: 'abort' } },
    })).toBe(false);
    expect(isSuccessfulProcessResult({
        ...result,
        termination: { ...result.termination, observed: { kind: 'exit', exitCode: 1 } },
    })).toBe(false);
});
