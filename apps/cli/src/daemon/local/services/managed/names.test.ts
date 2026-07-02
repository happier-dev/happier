import { describe, expect, it } from 'vitest';

import { resolveLocalServiceRouteName } from './names';

describe('resolveLocalServiceRouteName', () => {
    it('normalizes DNS-safe names and keeps labels within DNS limits', () => {
        const name = resolveLocalServiceRouteName({
            ownerKey: 'Plugin/Acme Preview',
            serviceId: 'Web UI',
            workspaceKey: 'feature/A Really Long Branch Name That Should Be Hashed And Shortened',
        });

        expect(name.length).toBeLessThanOrEqual(63);
        expect(name).toMatch(/^plugin-acme-preview-web-ui-feature-a-/);
        expect(name).toMatch(/-[a-f0-9]{8}$/);
    });
});
