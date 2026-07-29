import { describe, expect, it } from 'vitest';

import { normalizeCliArgv, parseCliArgs } from './parseArgs';

describe('parseCliArgs', () => {
    it('strips a leading packaged runtime entrypoint before parsing command args', () => {
        expect(
            parseCliArgs([
                '/Users/test/.happier/stacks/review-runs/runtime/builds/abc123/cli/package-dist/index.mjs',
                'daemon',
                'start-sync',
            ]),
        ).toEqual({
            args: ['daemon', 'start-sync'],
            terminalRuntime: null,
        });
    });

    it('strips a leading relative source entrypoint used by the dev script', () => {
        expect(normalizeCliArgv(['src/index.ts', 'agents', 'status', '--json'])).toEqual([
            'agents',
            'status',
            '--json',
        ]);
        expect(normalizeCliArgv(['apps/cli/src/index.ts', 'agents', 'status'])).toEqual([
            'agents',
            'status',
        ]);
    });
});
