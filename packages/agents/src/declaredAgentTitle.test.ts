import { describe, expect, it } from 'vitest';

import { readDeclaredAgentTitle } from './declaredAgentTitle.js';

describe('declared Agent titles', () => {
    it('resolves authored scalar values while retaining readable legacy and absent titles', () => {
        expect(readDeclaredAgentTitle({ key: 'agent.title', fallback: '{name} agent', params: { name: 'Review' } }))
            .toBe('Review agent');
        expect(readDeclaredAgentTitle({ key: 'agent.title', fallback: 'Review agent' })).toBe('Review agent');
        expect(readDeclaredAgentTitle('  Review agent  ')).toBe('Review agent');
        expect(readDeclaredAgentTitle({ fallback: '   ' })).toBeNull();
        expect(readDeclaredAgentTitle(undefined)).toBeNull();
    });
});
