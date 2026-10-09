import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('ActionOperationRuntime app ownership', () => {
    it('mounts exactly once in the authenticated app runtime, outside Inbox and modal surfaces', () => {
        const runtimeMounts = readFileSync(fileURLToPath(new NodeURL(
            '../../../components/appShell/runtime/AuthenticatedAppRuntimeMounts.tsx',
            import.meta.url,
        )), 'utf8');
        const mountCount = runtimeMounts.match(/<ActionOperationRuntime\b/g)?.length ?? 0;

        expect(runtimeMounts).toContain("from '@/sync/domains/actionOperations/actionOperationRuntime'");
        expect(mountCount).toBe(1);
        expect(runtimeMounts).toContain('props.isAuthenticated ? <ActionOperationRuntime /> : null');
    });
});
