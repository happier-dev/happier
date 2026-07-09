import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('session open initial pin attempt ownership', () => {
    it('keeps web retry scheduling owned by the session-open latch effect path', async () => {
        const source = await readFile(resolve(
            __dirname,
            '../../ChatListInternal.tsx',
        ), 'utf8');
        const body = source.slice(
            source.indexOf('const executeSessionOpenInitialPinAttempt = React.useCallback'),
            source.indexOf('const scheduleSessionOpenWebInitialPinRetry = React.useCallback'),
        );

        expect(body).not.toContain('resolveSessionOpenWebInitialPinRetryPlan');
        expect(body).not.toContain('setTimeout');
    });
});
