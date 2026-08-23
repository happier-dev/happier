import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('ActionOperationRuntime app ownership', () => {
    it('mounts exactly once in the root shell, outside detachable Activity and modal surfaces', () => {
        const rootLayout = readFileSync(resolve(process.cwd(), 'sources/app/_layout.tsx'), 'utf8');
        const mountCount = rootLayout.match(/<ActionOperationRuntime\b/g)?.length ?? 0;

        expect(rootLayout).toContain("from '@/sync/domains/actionOperations/actionOperationRuntime'");
        expect(mountCount).toBe(1);
        expect(rootLayout.indexOf('<ActionOperationRuntime')).toBeGreaterThan(rootLayout.indexOf('function RootAppShell'));
    });
});
