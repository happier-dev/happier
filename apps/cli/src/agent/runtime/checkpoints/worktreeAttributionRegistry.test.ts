import { describe, expect, it } from 'vitest';

import { createWorktreeAttributionRegistry } from './worktreeAttributionRegistry';

describe('createWorktreeAttributionRegistry', () => {
    it('reports shared worktree attribution when active sessions overlap on the same repo root', () => {
        const registry = createWorktreeAttributionRegistry();
        const first = registry.begin({ repoRoot: '/repo', intervalId: 'session-1:message-1' });

        expect(registry.resolveAttributionScope(first)).toBe('unknown');

        const second = registry.begin({ repoRoot: '/repo', intervalId: 'session-2:message-2' });

        expect(registry.resolveAttributionScope(first)).toBe('shared_worktree');
        expect(registry.resolveAttributionScope(second)).toBe('shared_worktree');

        registry.end(second);

        expect(registry.resolveAttributionScope(first)).toBe('unknown');
    });
});
