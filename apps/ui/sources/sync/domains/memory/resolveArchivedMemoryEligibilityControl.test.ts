import { describe, expect, it } from 'vitest';

import type { MemoryStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';

import { resolveArchivedMemoryEligibilityControl } from './resolveArchivedMemoryEligibilityControl';

function status(extra: Partial<MemoryStatusV1>): MemoryStatusV1 {
    return { v: 1, enabled: true, indexMode: 'hints', ...extra } as MemoryStatusV1;
}

describe('resolveArchivedMemoryEligibilityControl', () => {
    it('treats an absent effective advertisement as unsupported and never claims the desired value applies', () => {
        const control = resolveArchivedMemoryEligibilityControl({
            status: status({}),
            statusRequestState: 'resolved',
        });

        expect(control).toEqual({ state: 'unsupported', supported: false, value: false });
    });

    it('keeps an unresolved status distinct from an old daemon that omitted the support field', () => {
        expect(resolveArchivedMemoryEligibilityControl({
            status: null,
            statusRequestState: 'loading',
        })).toEqual({ state: 'loading', supported: false, value: false });

        expect(resolveArchivedMemoryEligibilityControl({
            status: status({ includeArchivedSessionsEffective: true }),
            statusRequestState: 'loading',
        })).toEqual({ state: 'loading', supported: false, value: true });

        expect(resolveArchivedMemoryEligibilityControl({
            status: null,
            statusRequestState: 'unreachable',
        })).toEqual({ state: 'unreachable', supported: false, value: false });
    });

    it('shows the effective value the daemon actually applies rather than the desired setting', () => {
        expect(resolveArchivedMemoryEligibilityControl({
            status: status({ includeArchivedSessionsEffective: false }),
            statusRequestState: 'resolved',
        })).toEqual({ state: 'supported', supported: true, value: false });

        expect(resolveArchivedMemoryEligibilityControl({
            status: status({ includeArchivedSessionsEffective: true }),
            statusRequestState: 'resolved',
        })).toEqual({ state: 'supported', supported: true, value: true });
    });
});
