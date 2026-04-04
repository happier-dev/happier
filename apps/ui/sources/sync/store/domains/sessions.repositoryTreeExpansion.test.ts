import { describe, expect, it } from 'vitest';

import * as repositoryTreeExpansion from './sessions.repositoryTreeExpansion';

describe('sessions.repositoryTreeExpansion', () => {
    it('exports createInitialSessionRepositoryTreeExpansionState', () => {
        const createInitial = (repositoryTreeExpansion as any).createInitialSessionRepositoryTreeExpansionState as unknown;
        expect(typeof createInitial).toBe('function');
    });
});
