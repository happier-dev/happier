import { describe, expect, it } from 'vitest';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import * as owner from './useSessionInfoAddToFacts';

const scope: ServerAccountScope = { serverId: 'home-a', accountId: 'account-a' };
const address: SessionAddress = { serverId: 'home-a', sessionId: 'same-id' };
const held = (count: number, overrides: Partial<owner.SessionInfoHeldSectionSummary> = {}): owner.SessionInfoHeldSectionSummary => ({
    scope, sessionId: address.sessionId, status: 'ready', coverage: 'complete', count, ...overrides,
});

describe('held Info Add-to facts', () => {
    it('folds only complete current empty sections, never missing or stale evidence', () => {
        const useFacts = owner.useSessionInfoAddToFacts;
        expect(useFacts({ scope, address, habits: held(0), people: held(0), anotherMachine: held(0) })).toEqual({
            habits: 'empty', people: 'empty', anotherMachine: 'empty',
        });
        for (const summary of [undefined, held(0, { status: 'loading' }), held(0, { status: 'stale' }),
            held(0, { status: 'denied' }), held(0, { status: 'error' }), held(0, { coverage: 'partial' })]) {
            expect(useFacts({ scope, address, habits: summary, people: summary, anotherMachine: summary })).toEqual({
                habits: 'unknown', people: 'unknown', anotherMachine: 'unknown',
            });
        }
    });

    it('keeps populated sections and rejects another Home or Account of the same Session', () => {
        expect(owner.useSessionInfoAddToFacts({ scope, address, habits: held(1), people: held(2), anotherMachine: held(1) })).toEqual({
            habits: 'present', people: 'present', anotherMachine: 'present',
        });
        expect(owner.useSessionInfoAddToFacts({ scope, address, habits: held(1, { coverage: 'partial' }) }).habits).toBe('present');
        expect(owner.useSessionInfoAddToFacts({ scope: null, address, habits: held(0) }).habits).toBe('unknown');
        expect(owner.useSessionInfoAddToFacts({ scope, address: { ...address, serverId: 'home-b' }, habits: held(0) }).habits).toBe('unknown');
        for (const summary of [held(0, { scope: { ...scope, serverId: 'home-b' } }),
            held(0, { scope: { ...scope, accountId: 'account-b' } }), held(0, { sessionId: 'other-session' })]) {
            expect(owner.useSessionInfoAddToFacts({ scope, address, habits: summary, people: summary, anotherMachine: summary })).toEqual({
                habits: 'unknown', people: 'unknown', anotherMachine: 'unknown',
            });
        }
    });

    it('does no inventory work or reads when unrelated held data arrives', () => {
        let inventoryReads = 0;
        const summary = held(0);
        Object.defineProperty(summary, 'rows', { get: () => { inventoryReads += 1; throw new Error('Details must stay closed'); } });
        for (let index = 0; index < 1_000; index += 1) {
            expect(owner.useSessionInfoAddToFacts({ scope, address, habits: summary, people: summary, anotherMachine: summary }).habits).toBe('empty');
        }
        expect(inventoryReads).toBe(0);
    });
});
