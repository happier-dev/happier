import { describe, expect, it } from 'vitest';

import { preserveSessionRuntimeLocalMetadata } from './preserveSessionRuntimeLocalMetadata';

/**
 * The one-flat-vendor-key invariant (`REQ-STATE-01`): at every committed state a
 * Session carries zero or one non-empty flat vendor resume key. A cross-Agent
 * transition clears the source key on purpose, so legacy-layout preservation
 * must not put it back — two live resume keys is the resume brick this program
 * already fixed once at the projector.
 */
describe('preserveSessionRuntimeLocalMetadata vendor resume keys', () => {
    it('does not resurrect the source Agent key the transition cleared', () => {
        const result = preserveSessionRuntimeLocalMetadata(
            { flavor: 'claude', claudeSessionId: 'claude-1', path: '/repo' },
            { flavor: 'codex', codexSessionId: 'codex-1' },
        );

        expect(result).not.toHaveProperty('claudeSessionId');
        expect(result).toMatchObject({ flavor: 'codex', codexSessionId: 'codex-1', path: '/repo' });
    });

    it('does not resurrect the source Agent key before the target reports its own', () => {
        // The committed target view names the Agent through `flavor` immediately;
        // its native id only arrives once the target runtime publishes one.
        const result = preserveSessionRuntimeLocalMetadata(
            { flavor: 'codex', codexSessionId: 'codex-1' },
            { flavor: 'claude' },
        );

        expect(result).not.toHaveProperty('codexSessionId');
        expect(result).toMatchObject({ flavor: 'claude' });
    });

    it('still preserves the running Agent key across a partial update of the same Session', () => {
        const result = preserveSessionRuntimeLocalMetadata(
            { flavor: 'claude', claudeSessionId: 'claude-1' },
            { flavor: 'claude', path: '/repo' },
        );

        expect(result).toMatchObject({
            flavor: 'claude',
            claudeSessionId: 'claude-1',
            path: '/repo',
        });
    });

    it('still preserves the key when the update names no Agent at all', () => {
        const result = preserveSessionRuntimeLocalMetadata(
            { claudeSessionId: 'claude-1' },
            { path: '/repo' },
        );

        expect(result).toMatchObject({ claudeSessionId: 'claude-1', path: '/repo' });
    });
});
