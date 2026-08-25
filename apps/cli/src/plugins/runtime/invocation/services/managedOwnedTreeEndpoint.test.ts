import { describe, expect, it } from 'vitest';

import {
    selectManagedOwnedTreeEndpoint,
    type ManagedInventoryCandidate,
} from './managedOwnedTreeEndpoint';

function candidate(overrides: Partial<ManagedInventoryCandidate> = {}): ManagedInventoryCandidate {
    return {
        id: 'machine-a:tcp:127.0.0.1:5173',
        port: 5173,
        confidence: 'high',
        processOwnershipConfidence: 'medium',
        provenance: { process: { pid: 123, redacted: true, command: 'npm run dev' } },
        ...overrides,
    };
}

describe('selectManagedOwnedTreeEndpoint', () => {
    it('ignores a listener owned by an unrelated process', () => {
        expect(selectManagedOwnedTreeEndpoint({
            entries: [candidate({
                provenance: { process: { pid: 999, redacted: true, command: 'npm run dev' } },
            })],
            managedPid: 123,
            minimumConfidence: 'medium',
        })).toBeNull();
    });

    it('selects a listener whose process is the managed process itself', () => {
        const entry = candidate();
        expect(selectManagedOwnedTreeEndpoint({
            entries: [entry],
            managedPid: 123,
            minimumConfidence: 'medium',
        })).toBe(entry);
    });

    it('selects a listener owned by a direct child of the managed process', () => {
        const entry = candidate({
            provenance: { process: { pid: 400, ppid: 300, redacted: true, command: 'vite' } },
        });
        expect(selectManagedOwnedTreeEndpoint({
            entries: [entry],
            managedPid: 300,
            minimumConfidence: 'medium',
        })).toBe(entry);
    });

    it('selects a listener reachable through deeper process lineage', () => {
        const entry = candidate({
            provenance: {
                process: { pid: 500, ppid: 400, lineagePids: [500, 400, 300, 1], redacted: true, command: 'vite' },
            },
        });
        expect(selectManagedOwnedTreeEndpoint({
            entries: [entry],
            managedPid: 300,
            minimumConfidence: 'medium',
        })).toBe(entry);
    });

    it('treats an exact pid match as high confidence even when the scanner graded it low', () => {
        const entry = candidate({ processOwnershipConfidence: 'low' });
        expect(selectManagedOwnedTreeEndpoint({
            entries: [entry],
            managedPid: 123,
            minimumConfidence: 'high',
        })).toBe(entry);
    });

    it('rejects a lineage match that does not clear the minimum ownership confidence', () => {
        expect(selectManagedOwnedTreeEndpoint({
            entries: [candidate({
                processOwnershipConfidence: 'low',
                provenance: { process: { pid: 400, ppid: 300, redacted: true, command: 'vite' } },
            })],
            managedPid: 300,
            minimumConfidence: 'medium',
        })).toBeNull();
    });

    it('refuses to guess when two owned listeners both qualify', () => {
        expect(selectManagedOwnedTreeEndpoint({
            entries: [
                candidate({ id: 'a', port: 5173, provenance: { process: { pid: 400, ppid: 300, redacted: true, command: 'vite' } } }),
                candidate({ id: 'b', port: 5174, provenance: { process: { pid: 401, ppid: 300, redacted: true, command: 'vite' } } }),
            ],
            managedPid: 300,
            minimumConfidence: 'medium',
        })).toBeNull();
    });

    it('ignores a listener with no process provenance at all', () => {
        expect(selectManagedOwnedTreeEndpoint({
            entries: [candidate({ provenance: undefined })],
            managedPid: 123,
            minimumConfidence: 'low',
        })).toBeNull();
    });
});
