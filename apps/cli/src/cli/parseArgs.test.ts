import { describe, expect, it } from 'vitest';

import { parseCliArgs } from './parseArgs';

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
});
