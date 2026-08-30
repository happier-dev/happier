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

    it('records the applied baseline when an active session selection really changes', () => {
        const next = computeNextSessionMcpSelectionMetadata({
            path: '/repo',
            host: 'qa-host',
            mcpSelectionV1: {
                v: 1,
                managedServersEnabled: true,
                forceIncludeServerIds: [],
                forceExcludeServerIds: [],
            },
        }, {
            v: 1,
            managedServersEnabled: true,
            forceIncludeServerIds: ['managed-1'],
            forceExcludeServerIds: [],
        }, { sessionActive: true });

        expect(next.mcpSelectionRestartRequiredV1).toEqual({
            v: 1,
            appliedSelection: {
                v: 1,
                managedServersEnabled: true,
                forceIncludeServerIds: [],
                forceExcludeServerIds: [],
            },
        });
    });

    it('clears the marker when an active session is reverted to its applied selection', () => {
        const next = computeNextSessionMcpSelectionMetadata({
            path: '/repo',
            host: 'qa-host',
            mcpSelectionV1: {
                v: 1,
                managedServersEnabled: true,
                forceIncludeServerIds: ['managed-1'],
                forceExcludeServerIds: [],
            },
            mcpSelectionRestartRequiredV1: {
                v: 1,
                appliedSelection: {
                    v: 1,
                    managedServersEnabled: true,
                    forceIncludeServerIds: [],
                    forceExcludeServerIds: [],
                },
            },
        }, {
            v: 1,
            managedServersEnabled: true,
            forceIncludeServerIds: [],
            forceExcludeServerIds: [],
        }, { sessionActive: true });

        expect(next.mcpSelectionRestartRequiredV1).toBeUndefined();
    });

    it('does not create a marker for ordering-only active changes', () => {
        const next = computeNextSessionMcpSelectionMetadata({
            path: '/repo',
            host: 'qa-host',
            mcpSelectionV1: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['managed-1', 'managed-2'],
                forceExcludeServerIds: [],
            },
        }, {
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['managed-2', 'managed-1'],
            forceExcludeServerIds: [],
        }, { sessionActive: true });

        expect(next.mcpSelectionRestartRequiredV1).toBeUndefined();
    });

    it('clears a stale marker when editing an inactive session', () => {
        const next = computeNextSessionMcpSelectionMetadata({
            path: '/repo',
            host: 'qa-host',
            mcpSelectionRestartRequiredV1: {
                v: 1,
                appliedSelection: {
                    v: 1,
                    managedServersEnabled: false,
                    forceIncludeServerIds: [],
                    forceExcludeServerIds: [],
                },
            },
        }, {
            v: 1,
            managedServersEnabled: true,
            forceIncludeServerIds: ['managed-1'],
            forceExcludeServerIds: [],
        }, { sessionActive: false });

        expect(next.mcpSelectionRestartRequiredV1).toBeUndefined();
    });
});
