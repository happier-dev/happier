import { describe, expect, it } from 'vitest';

import { describeAcpLoadSessionSupport } from './acpRuntimeResume';

describe('describeAcpLoadSessionSupport', () => {
    it('includes rawMessage when ACP capabilities were not included in the probe', () => {
        const support = describeAcpLoadSessionSupport('codex', {
            'cli.codex': { ok: true, checkedAt: 1, data: { available: true } },
        });

        expect(support.kind).toBe('unknown');
        expect(support.rawMessage).toContain('includeAcpCapabilities');
    });
});

