import { describe, expect, it } from 'vitest';

import { AGENT_IDS as SHARED_AGENT_IDS } from '@happier-dev/agents';

import { AGENTS_UI } from './registryUi';

function sortedKeys(value: Record<string, unknown>): string[] {
    return Object.keys(value).sort();
}

describe('agents/registryUi', () => {
    it('covers the full canonical provider universe (no UI-only drift)', () => {
        expect(sortedKeys(AGENTS_UI)).toEqual([...SHARED_AGENT_IDS].sort());
    });
});
