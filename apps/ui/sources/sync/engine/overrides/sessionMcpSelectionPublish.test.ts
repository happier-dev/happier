import { describe, expect, it } from 'vitest';

import { computeNextSessionMcpSelectionMetadata } from './sessionMcpSelectionPublish';

describe('computeNextSessionMcpSelectionMetadata', () => {
    it('writes only the canonical mcpSelectionV1 metadata field', () => {
        const next = computeNextSessionMcpSelectionMetadata({
            path: '/repo',
            host: 'qa-host',
            mcpSelection: { forceIncludeServerIds: ['legacy'] },
        }, {
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['managed-1'],
            forceExcludeServerIds: ['managed-2'],
        });

        expect(next).toEqual({
            path: '/repo',
            host: 'qa-host',
            mcpSelectionV1: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['managed-1'],
                forceExcludeServerIds: ['managed-2'],
            },
        });
        expect('mcpSelection' in next).toBe(false);
    });
});
