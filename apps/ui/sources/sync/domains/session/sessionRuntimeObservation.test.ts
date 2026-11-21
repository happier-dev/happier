import { afterEach, describe, expect, it } from 'vitest';
import { createSessionRuntimeObservationSource, readSessionRuntimeObservation, sessionRuntimeObservations } from './sessionRuntimeObservation';
import { projectUiSessionRuntimeAwareness } from './attention/runtimePresentation';
import { resolveSessionRuntimePublication } from '@/sync/store/domains/sessionRuntimePublication';

afterEach(() => sessionRuntimeObservations.clear());

describe('Session runtime observations', () => {
    it('records actual full publications independently of lifecycle facts merged from a compact list', () => {
        const first = { id: 'full-document-witness', serverId: 'home', active: true, thinking: false,
            activeAt: 100, updatedAt: 100, metadataVersion: 1 };
        const address = { serverId: first.serverId, sessionId: first.id };
        resolveSessionRuntimePublication(undefined, first, first);
        resolveSessionRuntimePublication(first, { ...first, updatedAt: 200 }, { ...first, updatedAt: 200 });
        expect(sessionRuntimeObservations.read(address)?.fullPublicationUpdatedAt).toBeUndefined();
        resolveSessionRuntimePublication(undefined, { ...first, updatedAt: 200 }, first, first.updatedAt);
        expect(sessionRuntimeObservations.read(address)?.fullPublicationUpdatedAt).toBe(100);
        const next = { ...first, metadataVersion: 2, updatedAt: 300 };
        resolveSessionRuntimePublication(first, next, next, next.updatedAt);
        expect(sessionRuntimeObservations.read(address)?.fullPublicationUpdatedAt).toBe(300);
        resolveSessionRuntimePublication(next, { ...next, updatedAt: 400 }, { ...first, updatedAt: 150 }, 150);
        expect(sessionRuntimeObservations.read(address)?.fullPublicationUpdatedAt).toBe(300);
    });

    it.each([true, false])('keeps unknown presence unknown on a receipt-only publication (active=%s)', active => {
        const previous = { id: 'receipt-without-presence', serverId: 'home', active, thinking: false,
            activeAt: 100, updatedAt: 100, presence: undefined, privatePayload: { retainedByContentOnly: true } };
        const next = { ...previous, updatedAt: 300 };
        expect(resolveSessionRuntimePublication(previous, next, next, next.updatedAt)).toBe(previous);
        expect(readSessionRuntimeObservation(previous).presence).toBeUndefined();
        const observation = sessionRuntimeObservations.read({ serverId: 'home', sessionId: previous.id });
        expect(observation?.fullPublicationUpdatedAt).toBe(300);
        expect(observation).not.toHaveProperty('privatePayload');
    });

    it('orders thinking resurrection at admission against its full-publication witness', () => {
        const source = createSessionRuntimeObservationSource();
        const address = { serverId: 'home', sessionId: 'thinking-witness' };
        source.observe(address, { active: true, activeAt: 100, thinking: false, presence: 'online' });
        source.recordFullPublication(address, 300);
        expect(source.observe(address, { active: true, activeAt: 200, thinking: true, presence: 'online' })).toBe(false);
        expect(source.read(address)).toMatchObject({ activeAt: 100, thinking: false, fullPublicationUpdatedAt: 300 });
        expect(source.observe(address, { active: true, activeAt: 301, thinking: true, presence: 'online' })).toBe(true);
        expect(source.observe(address, { active: false, activeAt: 302, thinking: false, presence: 302 })).toBe(true);
        source.recordFullPublication(address, 400);
        expect(source.observe(address, { active: true, activeAt: 302, thinking: true, presence: 'online' })).toBe(false);
        expect(source.observe(address, { active: true, activeAt: 401, thinking: true, presence: 'online' })).toBe(true);
        expect(source.observe({ ...address, serverId: 'different-home' }, { active: true, activeAt: 200, thinking: true })).toBe(true);
        expect(source.observe({ ...address, serverId: null }, { active: true, activeAt: 200, thinking: true })).toBe(true);
    });

    it('retains full-publication currentness independently of newer runtime evidence and clears both together', () => {
        const source = createSessionRuntimeObservationSource();
        const address = { serverId: 'home', sessionId: 'currentness' };
        source.observe(address, { active: true, activeAt: 300, presence: 'online' });
        expect(source.observe(address, { active: true, activeAt: 200 })).toBe(false);
        source.recordFullPublication(address, 200);
        source.recordFullPublication(address, 150);
        expect(source.read(address)).toMatchObject({ activeAt: 300, presence: 'online', fullPublicationUpdatedAt: 200 });
        source.observe(address, { active: false, activeAt: 400 });
        expect(source.read(address)).toMatchObject({ activeAt: 400, presence: 400, fullPublicationUpdatedAt: 200 });
        source.forget(address);
        expect(source.read(address)).toBeUndefined();
        source.observe(address, { active: true, activeAt: 500 });
        expect(source.read(address)?.fullPublicationUpdatedAt).toBeUndefined();
        source.clear();
        expect(source.read(address)).toBeUndefined();
    });

    it('keeps exact list-row coverage separate from runtime observations and exact to the Account', () => {
        const source = createSessionRuntimeObservationSource();
        const address = { serverId: 'home', sessionId: 'same-session' };
        const baseline = { active: true, activeAt: 100 };
        source.recordServerObservation(address, 5, baseline, 'account-a');
        source.recordServerObservation(address, 3, baseline, 'account-a', 'exact-list-row');
        const observed = source.read(address);
        expect(observed).toMatchObject({ serverObservationCursor: 5, exactListRowObservationCursor: 3 });
        source.recordServerObservation(address, 3, baseline, 'account-a', 'exact-list-row');
        expect(source.read(address)).toBe(observed);

        source.recordServerObservation(address, 5, baseline, 'account-b');
        expect(source.read(address)).toMatchObject({ serverObservationAccountId: 'account-b', serverObservationCursor: 5 });
        expect(source.read(address)?.exactListRowObservationCursor).toBeUndefined();
    });

    it.each([
        { rawActive: true, inputActive: false, rawThinking: true, inputThinking: false },
        { rawActive: false, inputActive: true, rawThinking: false, inputThinking: true },
        { rawActive: true, inputActive: true, rawThinking: false, inputThinking: true },
        { rawActive: true, inputActive: true, rawThinking: true, inputThinking: false },
    ])('keeps explicit stops at equal runtime timestamps: %j', (scenario) => {
        const address = { serverId: 'home', sessionId: 'tie' };
        sessionRuntimeObservations.observe(address, { active: scenario.rawActive, thinking: scenario.rawThinking,
            activeAt: 100, presence: scenario.rawActive ? 'online' : 100 });
        const projected = readSessionRuntimeObservation({ id: address.sessionId, serverId: address.serverId,
            active: scenario.inputActive, thinking: scenario.inputThinking, activeAt: 100, thinkingAt: 100,
            presence: scenario.inputActive ? 'online' : 100 });
        expect(projected.active).toBe(scenario.rawActive && scenario.inputActive);
        expect(projected.thinking).toBe(scenario.rawThinking && scenario.inputThinking);
        if (!projected.active) expect(projected.presence).toBe(100);
    });
    it('does not reuse an old offline witness as the presence of a newer durable attachment', () => {
        const address = { serverId: 'home', sessionId: 'reattached' };
        sessionRuntimeObservations.observe(address, { active: false, thinking: false, activeAt: 100, presence: 100 });
        sessionRuntimeObservations.observe(address, { active: true, activeAt: 200 });
        const input = { id: address.sessionId, serverId: address.serverId, active: true, activeAt: 200, presence: 'online' };
        expect(readSessionRuntimeObservation(input).presence).toBe('online');
        expect(readSessionRuntimeObservation({ ...input, activeAt: 150 }).presence).toBeUndefined();
        expect(readSessionRuntimeObservation({ ...input, activeAt: 150, presence: 100 }).presence).toBe(100);
    });
    it('keeps equal Session ids exact to their Home and leaves unqualified legacy rows conservative', () => {
        const a = { serverId: 'home-a', sessionId: 'same-id' };
        const b = { serverId: 'home-b', sessionId: 'same-id' };
        sessionRuntimeObservations.observe(a, { active: true, thinking: true, activeAt: 200_000, presence: 'online' });
        sessionRuntimeObservations.observe(b, { active: false, thinking: false, activeAt: 300_000, presence: 300_000 });
        const baseline = { id: 'same-id', active: true, activeAt: 1, thinking: true, thinkingAt: 1, presence: 'online' as const };
        expect(readSessionRuntimeObservation({ ...baseline, serverId: 'home-a' }).activeAt).toBe(200_000);
        expect(readSessionRuntimeObservation({ ...baseline, serverId: 'home-b' }).active).toBe(false);
        expect(readSessionRuntimeObservation(baseline)).toBe(baseline);
    });

    it('refreshes actual runtime evidence without promoting old content time or reviving a later stop', () => {
        const session = { id: 'finished', serverId: 'home', updatedAt: 1,
            active: true, activeAt: 1, presence: 'online', thinking: false, thinkingAt: 1 };
        sessionRuntimeObservations.observe({ serverId: 'home', sessionId: session.id }, {
            active: true, thinking: false, activeAt: 300_000, presence: 'online',
        });
        expect(readSessionRuntimeObservation(session).updatedAt).toBe(1);
        expect(projectUiSessionRuntimeAwareness({ ...session, nowMs: 419_999 }).freshness).toBe('live');
        expect(projectUiSessionRuntimeAwareness({ ...session, nowMs: 420_001 }).freshness).toBe('stale');
        sessionRuntimeObservations.observe({ serverId: 'home', sessionId: session.id }, {
            active: true, thinking: true, activeAt: 310_000, presence: 'online',
        });
        expect(readSessionRuntimeObservation({ ...session, thinkingAt: 320_000 }).thinking).toBe(false);
    });

    it('retires its records without clearing a different accumulator lifetime and rejects delayed resurrection', () => {
        const first = createSessionRuntimeObservationSource();
        const second = createSessionRuntimeObservationSource();
        const address = { serverId: 'home', sessionId: 'same-id' };
        first.observe(address, { active: true, thinking: true, activeAt: 100 });
        first.observe(address, { active: false, thinking: false, activeAt: 200 });
        expect(first.observe(address, { active: true, thinking: true, activeAt: 200 })).toBe(false);
        expect(first.observe(address, { active: true, thinking: true, activeAt: 150 })).toBe(false);
        second.observe(address, { active: true, activeAt: 300 });
        first.clear();
        expect(first.read(address)).toBeUndefined();
        expect(second.read(address)?.activeAt).toBe(300);
    });
});
