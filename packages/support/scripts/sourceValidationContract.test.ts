import { describe, expect, it } from 'vitest';

import config from '../vitest.config.ts';

describe('support source validation', () => {
    it('uses the canonical workspace-source resolver for first-party imports', () => {
        const plugin = config.plugins?.find(
            (candidate) => candidate && typeof candidate === 'object'
                && 'name' in candidate
                && candidate.name === 'happier-support-workspace-package-sources',
        ) as { resolveId?: (id: string) => string | null } | undefined;

        expect(plugin?.resolveId?.('@happier-dev/protocol')).toContain('/packages/protocol/src/index.ts');
        expect(plugin?.resolveId?.('@happier-dev/cli-common/output')).toContain(
            '/packages/cli-common/src/output/index.ts',
        );
    });
});
