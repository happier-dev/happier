import { describe, expect, it } from 'vitest';

import { resolveNewSessionCapabilityServerId } from '@/components/sessions/new/modules/resolveNewSessionCapabilityServerId';

describe('resolveNewSessionCapabilityServerId', () => {
    it('prefers resolved target server when available', () => {
        expect(resolveNewSessionCapabilityServerId({
            targetServerId: 'server-b',
            activeServerId: 'server-a',
        })).toBe('server-b');
    });

    it('falls back to active server when target server is empty', () => {
        expect(resolveNewSessionCapabilityServerId({
            targetServerId: '  ',
            activeServerId: 'server-a',
        })).toBe('server-a');
    });
});
