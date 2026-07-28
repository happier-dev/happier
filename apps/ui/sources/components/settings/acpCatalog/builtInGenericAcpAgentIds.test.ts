import { describe, expect, it } from 'vitest';

import { getBuiltInGenericAcpAgentIds } from './builtInGenericAcpAgentIds';

describe('getBuiltInGenericAcpAgentIds', () => {
    it('derives the generic ACP settings list without first-class or user-defined providers', () => {
        expect(getBuiltInGenericAcpAgentIds()).toEqual(['kiro']);
        expect(getBuiltInGenericAcpAgentIds()).not.toContain('grok');
        expect(getBuiltInGenericAcpAgentIds()).not.toContain('customAcp');
    });
});
