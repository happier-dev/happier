import { expect, it } from 'vitest';

import { classifySessionTupleApplyCurrentness, reconcileSessionTupleProjection, shouldPreserveSessionRequestProjection } from '@/sync/domains/session/sessionTupleApplyCurrentness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { hasAuthoritativeSessionRouteData } from '@/sync/domains/session/hasAuthoritativeSessionRouteData';
import {
    SESSION_LIST_DOCUMENT_ADMISSION, admitOpenedSessionListAgentState,
    admitOpenedSessionListDisplayMetadata, resolveSessionListDocumentAdmissionScopes,
} from '@/sync/domains/session/sessionDocumentAdmission';

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

it.each([
    { metadataVersion: 39, agentStateVersion: 27, retainedMetadata: 39, retainedState: 28 },
    { metadataVersion: 37, agentStateVersion: 29, retainedMetadata: 38, retainedState: 29 },
])('retains opened-document custody independently for mixed revisions $metadataVersion/$agentStateVersion', revisions => {
    const scope = resolveSessionListDocumentAdmissionScopes('server-a', { token: 'fixture-token' }, undefined).owner;
    const opened = (metadataVersion: number, agentStateVersion: number) => {
        const session = createSessionFixture({ metadataLayoutVersion: 0, metadataVersion, agentStateVersion });
        return { ...session, [SESSION_LIST_DOCUMENT_ADMISSION]: admitOpenedSessionListAgentState(
            admitOpenedSessionListDisplayMetadata({ scope, encryptionMode: 'plain', metadataLayoutVersion: 0,
                dataEncryptionKey: null, metadataAudience: 'owner',
                observedMetadataVersion: metadataVersion, observedMetadataLayoutVersion: 0,
                observedAgentStateVersion: agentStateVersion }, session), agentStateVersion) };
    };
    const previous = opened(38, 28);
    const incoming = opened(revisions.metadataVersion, revisions.agentStateVersion);
    expect(hasAuthoritativeSessionRouteData(previous)).toBe(true);
    expect(hasAuthoritativeSessionRouteData(incoming)).toBe(true);
    const merged = reconcileSessionTupleProjection(previous, incoming);
    expect(merged).toMatchObject({ metadataVersion: revisions.retainedMetadata, agentStateVersion: revisions.retainedState });
    expect(hasAuthoritativeSessionRouteData(merged)).toBe(true);

    // An opened document from another custody cannot supply the missing witness.
    const otherScope = { ...incoming, [SESSION_LIST_DOCUMENT_ADMISSION]: {
        ...incoming[SESSION_LIST_DOCUMENT_ADMISSION], scope: 'another-account',
    } };
    expect(reconcileSessionTupleProjection(previous, otherScope)[SESSION_LIST_DOCUMENT_ADMISSION]).toBe(otherScope[SESSION_LIST_DOCUMENT_ADMISSION]);
    expect(hasAuthoritativeSessionRouteData(reconcileSessionTupleProjection(previous, otherScope))).toBe(false);
});
