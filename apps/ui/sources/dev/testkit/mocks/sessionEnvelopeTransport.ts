import { vi } from 'vitest';

/** Session/Team envelope HTTP is an external boundary; unrelated surfaces must never call it. */
export const sessionEnvelopeTransportMock = {
    createSessionDataKeyEnvelopeClient: vi.fn(),
    readSessionDataKeyEnvelopeCollectionPage: vi.fn(),
    prepareSessionDataKeyEnvelopesForScope: vi.fn(),
    prepareSessionDataKeyEnvelopesDetached: vi.fn(),
    createMembershipSessionDataKeyEnvelopeClient: vi.fn(),
    prepareMembershipHistoryEnvelopesForScope: vi.fn(),
    membershipHistoryPreparationScopeKey: vi.fn(),
    prepareMembershipHistoryEnvelopesDetached: vi.fn(),
};
