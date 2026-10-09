import { describe, expect, it } from 'vitest';
import { createProjectAccountRowCipherV1 } from './projectAccountRowCipherV1.js';

describe('Project Account row cipher admission', () => {
    it('refuses unavailable E2EE material before an empty census can be treated as absence', () => {
        expect(() => createProjectAccountRowCipherV1({ mode: 'e2ee', material: null,
            randomBytes: () => { throw new Error('No encryption may be attempted'); } }))
            .toThrow();
    });
    it('opens a Plain row without Account keys or randomness', () => {
        const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null,
            randomBytes: () => { throw new Error('Plain rows are keyless'); } });
        const key = { kind: 'project-organization' as const, serverId: 'home', projectKey: 'project' };
        expect(cipher.open(key, cipher.seal({ key, value: { pinned: true } })))
            .toEqual({ key, value: { pinned: true } });
    });
});
