import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionAccessFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { clearFocusedSessionId, resetSessionSurfaceVisibilityForTests, setFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import { readSessionMruOrder, rememberSessionVisit, sessionMruState } from '@/sync/domains/session/navigation/recentSessions';
import { buildServerScopedSessionKey } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { clearPersistenceStorage, getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { chooseCaptureDefaultTarget, rememberCaptureSessionPick, resolveCaptureDefaultSelection, resolveCaptureDefaultTarget } from './resolveCaptureDefaultTarget';

const originalState = storage.getState();
const address = (serverId: string, sessionId: string) => ({ serverId, sessionId });
const row = (id: string, options: { hidden?: boolean; canSubmit?: boolean } = {}) => createSessionListRenderableSessionFixture({
    id, access: createSessionAccessFixture(options.canSubmit === false ? 'view' : 'owner'),
    metadata: options.hidden ? { path: '/project', hiddenSystemSession: true } : { name: id, path: '/project' },
});

beforeEach(() => {
    clearPersistenceStorage();
    resetSessionSurfaceVisibilityForTests();
    sessionMruState.set('order', []);
    storage.setState({ sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {} });
});
afterEach(() => {
    vi.restoreAllMocks();
    resetSessionSurfaceVisibilityForTests();
    sessionMruState.set('order', []);
    storage.setState(originalState, true);
});

describe('resolveCaptureDefaultTarget', () => {
    it('restores the last Capture pick from device storage without changing navigation order', () => {
        storage.setState({ sessionListRowsByServerId: { home: { a: row('a'), b: row('b') } },
            ordinarySessionListMembershipByServerId: { home: ['a', 'b'] } });
        rememberSessionVisit(buildServerScopedSessionKey('b', 'home'));
        getPersistenceStorage().set('ui-state:session-navigation-mru-v1:last-capture-pick', JSON.stringify({
            sessionKey: buildServerScopedSessionKey('a', 'home'), timestamp: Date.now() + 1,
        }));
        expect(resolveCaptureDefaultTarget()).toEqual(address('home', 'a'));
        expect(readSessionMruOrder()).toEqual([buildServerScopedSessionKey('b', 'home')]);
    });

    it('uses the latest pick across Capture windows until a different Session is focused', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1000);
        storage.setState({ sessionListRowsByServerId: { home: { a: row('a'), b: row('b'), c: row('c') } },
            ordinarySessionListMembershipByServerId: { home: ['a', 'b', 'c'] } });
        setFocusedSessionId('b', 'home');
        rememberCaptureSessionPick(address('home', 'a'));
        const firstWindow = resolveCaptureDefaultSelection();
        expect(firstWindow).toEqual({ address: address('home', 'a'), defaultReason: 'lastCapturePick' });
        setFocusedSessionId(' b ', 'home');
        clearFocusedSessionId('b', 'home');
        setFocusedSessionId('b', 'home');
        expect(resolveCaptureDefaultSelection()).toEqual(firstWindow);
        rememberCaptureSessionPick(address('home', 'c'));
        expect(resolveCaptureDefaultSelection()).toEqual({ address: address('home', 'c'), defaultReason: 'lastCapturePick' });
        setFocusedSessionId('a', 'home');
        expect(resolveCaptureDefaultSelection()).toEqual({ address: address('home', 'a'), defaultReason: 'focusedSession' });
        expect(firstWindow).toEqual({ address: address('home', 'a'), defaultReason: 'lastCapturePick' });
    });

    it('ignores an ineligible last pick and distinguishes focused versus last-used defaults', () => {
        storage.setState({ sessionListRowsByServerId: { home: { a: row('a'), b: row('b', { canSubmit: false }) } },
            ordinarySessionListMembershipByServerId: { home: ['a', 'b'] } });
        rememberSessionVisit(buildServerScopedSessionKey('a', 'home'));
        rememberCaptureSessionPick(address('home', 'b'));
        expect(resolveCaptureDefaultSelection()).toEqual({ address: address('home', 'a'), defaultReason: 'lastUsed' });
        setFocusedSessionId('a', 'home');
        rememberCaptureSessionPick(address('home', 'missing'));
        expect(resolveCaptureDefaultSelection()).toEqual({ address: address('home', 'a'), defaultReason: 'focusedSession' });
    });

    it('keeps focused-else-last-used behavior without a Capture pick after focus clears', () => {
        storage.setState({ sessionListRowsByServerId: { home: { a: row('a'), b: row('b') } },
            ordinarySessionListMembershipByServerId: { home: ['a', 'b'] } });
        setFocusedSessionId('a', 'home');
        clearFocusedSessionId('a', 'home');
        rememberSessionVisit(buildServerScopedSessionKey('b', 'home'));
        expect(resolveCaptureDefaultSelection()).toEqual({ address: address('home', 'b'), defaultReason: 'lastUsed' });
    });
    it('keeps the already-admitted requesting or attach target ahead of focus without requiring a list row', () => {
        const explicit = address('request-home', 'request-session');
        setFocusedSessionId('focused-session', 'focused-home');
        expect(resolveCaptureDefaultTarget({ targetSession: explicit })).toBe(explicit);
    });

    it('uses the exact focused eligible Session before the most recent visit', () => {
        storage.setState({ sessionListRowsByServerId: { 'home-a': { same: row('same') }, 'home-b': { same: row('same') } },
            ordinarySessionListMembershipByServerId: { 'home-a': ['same'], 'home-b': ['same'] } });
        setFocusedSessionId('same', 'home-a');
        rememberSessionVisit(buildServerScopedSessionKey('same', 'home-b'));
        expect(resolveCaptureDefaultTarget()).toEqual(address('home-a', 'same'));
    });

    it('skips hidden and submit-ineligible focus/MRU entries and uses the first eligible admitted row across Homes', () => {
        storage.setState({ sessionListRowsByServerId: {
            'home-a': { hidden: row('hidden', { hidden: true }), viewer: row('viewer', { canSubmit: false }),
                retained: row('retained') }, 'home-b': { destination: row('destination') },
        }, ordinarySessionListMembershipByServerId: { 'home-a': ['hidden', 'viewer'], 'home-b': ['destination'] } });
        rememberSessionVisit(buildServerScopedSessionKey('destination', 'home-b'));
        rememberSessionVisit(buildServerScopedSessionKey('retained', 'home-a'));
        rememberSessionVisit(buildServerScopedSessionKey('hidden', 'home-a'));
        setFocusedSessionId('viewer', 'home-a');
        expect(resolveCaptureDefaultTarget()).toEqual(address('home-b', 'destination'));
    });

    it('delegates legacy MRU matching to navigation and returns no target for missing or ineligible rows', () => {
        const home = 'home:with:separator';
        storage.setState({ sessionListRowsByServerId: { [home]: { ready: row('ready') } },
            ordinarySessionListMembershipByServerId: { [home]: ['ready'] } });
        sessionMruState.set('order', [`${home}:ready`]);
        expect(resolveCaptureDefaultTarget()).toEqual(address(home, 'ready'));
        storage.setState({ sessionListRowsByServerId: { [home]: { ready: row('ready', { canSubmit: false }) } } });
        expect(resolveCaptureDefaultTarget()).toBeNull();
        storage.setState({ sessionListRowsByServerId: {} });
        expect(resolveCaptureDefaultTarget()).toBeNull();
    });

    it('keeps explicit agent/composer scope even when the snapshot has only a same-id Session on another Home', () => {
        const explicit = address('request-home', 'same');
        const candidates = [{ ...row('same'), serverId: 'other-home' }];
        expect(chooseCaptureDefaultTarget({ candidates, explicitSession: explicit,
            focusedSession: address('other-home', 'same'), mruOrder: [] })).toBe(explicit);
        expect(chooseCaptureDefaultTarget({ candidates, focusedSession: null, mruOrder: [] })).toBeNull();
    });
});
