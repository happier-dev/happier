import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', () => ({ t: (key: string) => key }));

import { describeTemporaryComputerLaunchBlock, describeTemporaryComputerUnavailability } from './temporaryComputerCopy';

describe('Temporary computer launch copy', () => {
    it('explains the publication rate limit instead of asking the person to repair their connection', () => {
        expect(describeTemporaryComputerUnavailability({
            status: 'unavailable', reason: 'unavailable', retry: () => undefined,
            publicationFailure: { reason: 'rate_limited', resetAtMs: 1793788116000 },
        })).toBe('newSession.temporaryComputer.unavailable.rateLimitedUntil');
    });
    it.each([
        ['authoring_connectedServices_unsupported', 'connectedServices.title', 'newSession.connectedServicesReasonNotPortable'],
    ] as const)('names the exact selected field for %s', (block, label, reason) => {
        expect(describeTemporaryComputerLaunchBlock(block)).toBe(`${label}: ${reason}`);
    });
});
