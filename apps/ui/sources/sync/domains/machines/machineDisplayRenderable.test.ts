import { describe, expect, it } from 'vitest';

import type { MachineDisplayRenderable } from './machineDisplayRenderable';
import { resolveBestMachineDisplayRenderableForHost } from './machineDisplayRenderable';

function makeMachineDisplay(partial: Partial<MachineDisplayRenderable> & Pick<MachineDisplayRenderable, 'id'>): MachineDisplayRenderable {
    const updatedAt = partial.updatedAt ?? 0;
    const activeAt = partial.activeAt ?? updatedAt;
    return {
        id: partial.id,
        updatedAt,
        active: partial.active ?? false,
        activeAt,
        revokedAt: partial.revokedAt ?? null,
        metadataVersion: partial.metadataVersion ?? 0,
        metadata: partial.metadata ?? null,
    };
}

describe('resolveBestMachineDisplayRenderableForHost', () => {
    it('prefers higher metadataVersion over updatedAt when hosts match', () => {
        const host = 'example-host';
        const machines = {
            a: makeMachineDisplay({ id: 'a', updatedAt: 999, metadataVersion: 1, metadata: { host } }),
            b: makeMachineDisplay({ id: 'b', updatedAt: 1, metadataVersion: 2, metadata: { host } }),
        };

        const best = resolveBestMachineDisplayRenderableForHost(machines, host);
        expect(best?.id).toBe('b');
    });

    it('does not drift based on updatedAt when metadataVersion ties', () => {
        const host = 'example-host';
        const machines = {
            a: makeMachineDisplay({ id: 'a', updatedAt: 999, metadataVersion: 1, metadata: { host } }),
            b: makeMachineDisplay({ id: 'b', updatedAt: 1, metadataVersion: 1, metadata: { host } }),
        };

        const best = resolveBestMachineDisplayRenderableForHost(machines, host);
        expect(best?.id).toBe('b');
    });
});
