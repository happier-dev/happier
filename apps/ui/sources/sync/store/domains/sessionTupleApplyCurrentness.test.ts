import { expect, it } from 'vitest';

import { classifySessionTupleApplyCurrentness, shouldPreserveSessionRequestProjection } from '@/sync/domains/session/sessionTupleApplyCurrentness';

it('admits a layout-less Agent-state-only publication against retained layout 1', () => {
    expect(classifySessionTupleApplyCurrentness(
        { metadataLayoutVersion: 1, metadataVersion: 7, agentStateVersion: 4 },
        { metadataVersion: 7, agentStateVersion: 5 },
    )).toEqual({ metadataCurrent: true, agentStateCurrent: true, fullyCurrent: true });
});

it('still rejects an older Agent state when the publication asserts no layout', () => {
    expect(classifySessionTupleApplyCurrentness(
        { metadataLayoutVersion: 1, metadataVersion: 7, agentStateVersion: 4 },
        { metadataVersion: 7, agentStateVersion: 3 },
    )).toEqual({ metadataCurrent: true, agentStateCurrent: false, fullyCurrent: false });
});

it('preserves the newer request observation on the same layout-less tuple', () => {
    expect(shouldPreserveSessionRequestProjection(
        { metadataLayoutVersion: 1, agentStateVersion: 4, pendingRequestObservedAt: 20 },
        { agentStateVersion: 4, pendingRequestObservedAt: 10 },
    )).toBe(true);
});

it('rejects prior-layout Agent state even when its version exceeds the contracted tuple', () => {
    expect(classifySessionTupleApplyCurrentness(
        { metadataLayoutVersion: 1, metadataVersion: 1, agentStateVersion: 1 },
        { metadataLayoutVersion: 0, metadataVersion: 9, agentStateVersion: 8 },
    )).toEqual({ metadataCurrent: false, agentStateCurrent: false, fullyCurrent: false });
});

it('admits an authoritative layout-1 privacy contraction without an access projection on the socket frame', () => {
    const previous = {
        metadataLayoutVersion: 0, metadataVersion: 9, agentStateVersion: 8,
        access: undefined, accessLevel: undefined,
    };
    const incoming = {
        metadataLayoutVersion: 1, metadataVersion: 1, agentStateVersion: 1,
        access: undefined, accessLevel: undefined,
    };
    expect(classifySessionTupleApplyCurrentness(previous, incoming)).toEqual({
        metadataCurrent: true, agentStateCurrent: true, fullyCurrent: true,
    });
});
