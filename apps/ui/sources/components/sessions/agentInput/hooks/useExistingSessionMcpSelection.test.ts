import { describe, expect, it } from 'vitest';

import {
    resolveExistingSessionMcpSelectionRollback,
    shouldShowExistingSessionMcpChip,
} from './useExistingSessionMcpSelection';

describe('shouldShowExistingSessionMcpChip', () => {
    it('allows MCP selection for writable active and inactive sessions', () => {
        expect(shouldShowExistingSessionMcpChip({ isReadOnly: false, sessionActive: false })).toBe(true);
        expect(shouldShowExistingSessionMcpChip({ isReadOnly: true, sessionActive: false })).toBe(false);
        expect(shouldShowExistingSessionMcpChip({ isReadOnly: false, sessionActive: true })).toBe(true);
    });

    it('rolls the latest failed write back to server-confirmed selection only', () => {
        const persistedSelection = {
            v: 1 as const,
            managedServersEnabled: true,
            forceIncludeServerIds: ['persisted'],
            forceExcludeServerIds: [],
        };
        expect(resolveExistingSessionMcpSelectionRollback({
            failedSelectionKey: 'latest',
            pendingSelectionKey: 'latest',
            persistedSelection,
        })).toEqual(persistedSelection);
        expect(resolveExistingSessionMcpSelectionRollback({
            failedSelectionKey: 'older',
            pendingSelectionKey: 'latest',
            persistedSelection,
        })).toBeNull();
    });
});
