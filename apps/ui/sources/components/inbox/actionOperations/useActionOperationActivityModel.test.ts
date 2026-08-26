import { describe, expect, it } from 'vitest';

import { resolveActionOperationSessionNameById } from './useActionOperationActivityModel';

describe('resolveActionOperationSessionNameById', () => {
    it('uses a renderable title when the source session is not in the full-session cache', () => {
        const result = resolveActionOperationSessionNameById([], [{
            id: 'session-1',
            metadata: {
                path: '/workspace/remote-dev',
                host: 'workstation',
                summary: { text: 'Stabilize CI and Nightly Releases', updatedAt: 123 },
            },
        }]);

        expect(result.get('session-1')).toBe('Stabilize CI and Nightly Releases');
    });

    it('prefers an explicit renderable title over a full-session path fallback', () => {
        const result = resolveActionOperationSessionNameById(
            [{ id: 'session-1', metadata: { path: '/workspace/remote-dev', host: 'workstation' } }],
            [{
                id: 'session-1',
                metadata: {
                    path: '/workspace/remote-dev',
                    host: 'workstation',
                    summary: { text: 'Canonical session title', updatedAt: 123 },
                },
            }],
        );

        expect(result.get('session-1')).toBe('Canonical session title');
    });
});
