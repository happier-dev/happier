import { describe, expect, it } from 'vitest';

import { providerTraceProtocolMatches } from './providerTraceProtocolMatcher';

describe('providerTraceProtocolMatches', () => {
    it('matches exact protocol for generic providers', () => {
        expect(
            providerTraceProtocolMatches({
                providerId: 'opencode',
                providerProtocol: 'acp',
                eventProtocol: 'acp',
            }),
        ).toBe(true);
        expect(
            providerTraceProtocolMatches({
                providerId: 'opencode',
                providerProtocol: 'acp',
                eventProtocol: 'codex',
            }),
        ).toBe(false);
    });

    it('treats codex and acp trace protocols as equivalent for codex provider', () => {
        expect(
            providerTraceProtocolMatches({
                providerId: 'codex',
                providerProtocol: 'acp',
                eventProtocol: 'acp',
            }),
        ).toBe(true);
        expect(
            providerTraceProtocolMatches({
                providerId: 'codex',
                providerProtocol: 'acp',
                eventProtocol: 'codex',
            }),
        ).toBe(true);
    });
});
