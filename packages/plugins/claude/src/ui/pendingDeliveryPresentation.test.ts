import { describe, expect, it } from 'vitest';

import { resolveClaudePendingDeliveryLabelKey } from './pendingDeliveryPresentation.js';

describe('resolveClaudePendingDeliveryLabelKey', () => {
    it('uses the Claude-native label only for the exact row with observed provider custody', () => {
        expect(resolveClaudePendingDeliveryLabelKey({
            localId: 'pending-1',
            detail: undefined,
            custodyObservedLocalId: 'pending-1',
        })).toBe('session.pendingMessages.deliveryStatus.queuedInClaude');

        expect(resolveClaudePendingDeliveryLabelKey({
            localId: 'pending-2',
            detail: undefined,
            custodyObservedLocalId: 'pending-1',
        })).toBeNull();
    });

    it('uses the Claude-native label for an explicit custody detail and falls back for generic delivery', () => {
        expect(resolveClaudePendingDeliveryLabelKey({
            localId: null,
            detail: 'custody_observed',
            custodyObservedLocalId: undefined,
        })).toBe('session.pendingMessages.deliveryStatus.queuedInClaude');

        expect(resolveClaudePendingDeliveryLabelKey({
            localId: 'pending-1',
            detail: 'awaiting_acceptance',
            custodyObservedLocalId: undefined,
        })).toBeNull();
    });

    it('compares opaque local ids exactly without trimming', () => {
        expect(resolveClaudePendingDeliveryLabelKey({
            localId: ' pending-1 ',
            detail: undefined,
            custodyObservedLocalId: 'pending-1',
        })).toBeNull();
    });
});
