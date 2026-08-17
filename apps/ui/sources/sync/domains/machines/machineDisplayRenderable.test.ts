import { describe, expect, it } from 'vitest';

import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineDisplayRenderable } from './machineDisplayRenderable';
import {
    areMachineDisplayRenderablesEqual,
    buildMachineDisplayRenderableFromMachine,
    getMachineDisplaySubtitle,
} from './machineDisplayRenderable';

function makeMachineDisplay(partial: Partial<MachineDisplayRenderable> & Pick<MachineDisplayRenderable, 'id'>): MachineDisplayRenderable {
    const updatedAt = partial.updatedAt ?? 0;
    const activeAt = partial.activeAt ?? updatedAt;
    return {
        id: partial.id,
        updatedAt,
        active: partial.active ?? false,
        activeAt,
        revokedAt: partial.revokedAt ?? null,
        ...(partial.availability ? { availability: partial.availability } : {}),
        metadataVersion: partial.metadataVersion ?? 0,
        metadata: partial.metadata ?? null,
    };
}

describe('machine display renderables', () => {
    it('treats a changed locked availability as a changed display snapshot', () => {
        const available = makeMachineDisplay({
            id: 'machine-a',
            availability: { kind: 'available' },
        });
        const locked = makeMachineDisplay({
            id: 'machine-a',
            availability: { kind: 'locked', reason: 'decryption_failed' },
        });

        expect(areMachineDisplayRenderablesEqual(available, locked)).toBe(false);
    });

    it('uses display fields without resolving a machine by host identity', () => {
        const machine = makeMachineDisplay({
            id: 'machine-a',
            metadata: { displayName: null, host: 'example-host' },
        });

        expect(getMachineDisplaySubtitle(machine, 'machine-a')).toBe('example-host');
    });

    it('carries replacement metadata into display renderables', () => {
        const machine = {
            id: 'machine-old',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: false,
            activeAt: 1,
            metadataVersion: 3,
            metadata: null,
            daemonState: null,
            daemonStateVersion: 0,
            replacedByMachineId: 'machine-new',
            replacedAt: 4,
            replacementReason: 'manual_repair',
            replacementSource: 'manual',
            replacementActorUserId: 'user-1',
        } satisfies Machine & {
            replacedByMachineId: string;
            replacedAt: number;
            replacementReason: string;
            replacementSource: string;
            replacementActorUserId: string;
        };

        const renderable = buildMachineDisplayRenderableFromMachine(machine);

        expect(renderable).toMatchObject({
            replacedByMachineId: 'machine-new',
            replacedAt: 4,
            replacementReason: 'manual_repair',
            replacementSource: 'manual',
            replacementActorUserId: 'user-1',
        });
    });
});
