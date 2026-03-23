import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { withToolTraceFile } from './toolTraceFile';

const TOOL_TRACE_ENV_KEYS = [
    'HAPPIER_STACK_TOOL_TRACE',
    'HAPPIER_STACK_TOOL_TRACE_FILE',
    'HAPPIER_STACK_TOOL_TRACE_DIR',
    'HAPPIER_E2E_ACP_TRACE_MARKERS',
] as const;

afterEach(() => {
    for (const key of TOOL_TRACE_ENV_KEYS) {
        delete process.env[key];
    }
});

describe('withToolTraceFile', () => {
    it('patches and restores tool-trace env including extra ACP trace-marker keys', async () => {
        process.env.HAPPIER_STACK_TOOL_TRACE = 'baseline-trace';
        process.env.HAPPIER_STACK_TOOL_TRACE_FILE = '/tmp/baseline-trace.jsonl';
        process.env.HAPPIER_STACK_TOOL_TRACE_DIR = '/tmp/baseline-trace-dir';
        process.env.HAPPIER_E2E_ACP_TRACE_MARKERS = 'baseline-markers';

        let traceFile = '';
        let traceDir = '';

        await withToolTraceFile(
            'happy-tool-trace-helper-',
            async (filePath) => {
                traceFile = filePath;
                traceDir = dirname(filePath);

                expect(process.env.HAPPIER_STACK_TOOL_TRACE).toBe('1');
                expect(process.env.HAPPIER_STACK_TOOL_TRACE_FILE).toBe(filePath);
                expect(process.env.HAPPIER_STACK_TOOL_TRACE_DIR).toBeUndefined();
                expect(process.env.HAPPIER_E2E_ACP_TRACE_MARKERS).toBe('1');
            },
            { env: { HAPPIER_E2E_ACP_TRACE_MARKERS: '1' } },
        );

        expect(process.env.HAPPIER_STACK_TOOL_TRACE).toBe('baseline-trace');
        expect(process.env.HAPPIER_STACK_TOOL_TRACE_FILE).toBe('/tmp/baseline-trace.jsonl');
        expect(process.env.HAPPIER_STACK_TOOL_TRACE_DIR).toBe('/tmp/baseline-trace-dir');
        expect(process.env.HAPPIER_E2E_ACP_TRACE_MARKERS).toBe('baseline-markers');
        expect(existsSync(traceFile)).toBe(false);
        expect(existsSync(traceDir)).toBe(false);
    });
});
