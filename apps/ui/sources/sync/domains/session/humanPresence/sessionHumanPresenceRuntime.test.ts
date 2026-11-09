import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { attachSessionHumanPresenceSocket, registerDiscussionHumanPresence, registerSessionPendingMessageEdit, reportDiscussionTypingEdit, reportSessionTypingEdit, stopDiscussionTyping, stopSessionTyping, type SessionHumanPresenceSocketTransport } from './sessionHumanPresenceRuntime';
import { SessionHumanPresenceVisibleReplaceV1Schema, SessionHumanPresenceTypingSetV1Schema } from '@happier-dev/protocol/sessions';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { HomeCredentialMutationEvent } from '@/auth/storage/tokenStorage';
import { upsertServerProfile, setServerProfileIdentityForUrl, removeServerProfile } from '@/sync/domains/server/serverProfiles';
import { AppState } from 'react-native';
import { sessionHumanPresenceStore } from './sessionHumanPresenceStore';
import { markSessionSurfaceVisible, markSessionSurfaceHidden } from '../sessionSurfaceVisibility';

type TestTransport = SessionHumanPresenceSocketTransport & {
    connected: boolean;
    snapshot(payload: unknown): void;
    change(connected: boolean): void;
};
const credentials = vi.hoisted(() => ({
    accounts: new Map<string, string>(),
    listeners: new Set<(event: HomeCredentialMutationEvent) => void>(),
}));
// Secure credential lookup/mutation is the boundary; binding currentness and retirement stay real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: async (url) => {
            const accountId = credentials.accounts.get(new URL(url).origin);
            return accountId ? { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64')}.signature`, secret: 'test-secret' } : null;
        },
    }, subscribeHomeCredentialMutations: (listener) => {
        credentials.listeners.add(listener);
        return () => { credentials.listeners.delete(listener); };
    } });
});
function transport() {
    let status: (() => void) | undefined;
    let snapshot: ((payload: unknown) => void) | undefined;
    const sent: Array<[string, unknown]> = [];
    const socket: TestTransport = {
        connected: true,
        isConnected: () => socket.connected,
        subscribeStatus: (listener: () => void) => { status = listener; return () => {}; },
        subscribeSnapshot: (listener: (payload: unknown) => void) => { snapshot = listener; return () => { snapshot = undefined; }; },
        send: (event: string, payload: unknown) => { sent.push([event, payload]); },
        sendWithAck: async (event: string, payload: unknown) => {
            sent.push([event, payload]);
            return {
                v: 1,
                ok: true,
                admittedSessionIds: (payload as {sessionIds: string[]}).sessionIds,
                ...('locations' in (payload as object)
                    ? { admittedLocations: (payload as { locations: unknown[] }).locations }
                    : {}),
                ...('pendingMessageEdits' in (payload as object)
                    ? { admittedPendingMessageEdits: (payload as { pendingMessageEdits: unknown[] }).pendingMessageEdits }
                    : {}),
            };
        },
        snapshot(payload: unknown) { snapshot?.(payload); },
        change(connected: boolean) { socket.connected = connected; status?.(); },
    };
    return { socket, sent };
}
const cleanup: Array<() => void | Promise<void>> = [];
async function scopeHomes(names: readonly string[]) {
    const profiles = await Promise.all(names.map(async name => {
        const profile = await upsertServerProfile({ serverUrl: `https://${name}.discussion-presence.test`, source: 'manual' });
        credentials.accounts.set(new URL(profile.serverUrl).origin, 'self');
        cleanup.push(async () => { credentials.accounts.delete(new URL(profile.serverUrl).origin); await removeServerProfile(profile.id); });
        return { name, profile };
    }));
    const hook = await renderHook(() => useServerCredentialAccountScopeBindings(profiles.map(({ profile }) => profile.id)));
    cleanup.push(() => hook.unmount());
    await vi.waitFor(() => expect(profiles.every(({ profile }) => hook.getCurrent().get(profile.id)?.isCurrent())).toBe(true));
    return new Map(profiles.map(({ name, profile }) => [name, {
        serverId: profile.id, serverUrl: profile.serverUrl,
        getLifetime: () => hook.getCurrent().get(profile.id)!,
    }]));
}
const hostListeners = new Set<() => void>();
const hostChanged = () => { for (const listener of hostListeners) listener(); };
beforeAll(() => {
    vi.spyOn(AppState, 'addEventListener').mockImplementation((...args: unknown[]) => {
        // The OS broadcasts state changes to every registered observer.
        const listener = args[1] as () => void;
        if (args[0] === 'change') hostListeners.add(listener);
        return { remove() { hostListeners.delete(listener); } };
    });
});
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); Object.defineProperty(AppState, 'currentState', {value:'active', configurable:true}); hostChanged?.(); vi.useRealTimers(); });
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
describe('human presence runtime', () => {
    it('keeps an admitted edit on the socket lifetime while hidden, redeclares on reconnect and releases without renewal', async () => {
        const home = (await scopeHomes(['pending-edit'])).get('pending-edit')!;
        const target = { serverId: home.serverId, sessionId: 's' };
        const boundary = transport();
        cleanup.push(attachSessionHumanPresenceSocket({ serverId: home.serverId, accountId: 'self', transport: boundary.socket }));
        await settle();
        const release = await registerSessionPendingMessageEdit(target, 'edit-1', home.getLifetime());
        cleanup.push(release);
        await settle();
        expect(boundary.sent.at(-1)?.[1]).toEqual({ v: 1, sessionIds: [], pendingMessageEdits: [{ sessionId: 's', holdId: 'edit-1' }] });
        Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true });
        hostChanged();
        await settle();
        vi.useFakeTimers();
        const settledCount = boundary.sent.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(boundary.sent).toHaveLength(settledCount);
        boundary.socket.change(false);
        boundary.socket.change(true);
        await settle();
        expect(boundary.sent.at(-1)?.[1]).toEqual({ v: 1, sessionIds: [], pendingMessageEdits: [{ sessionId: 's', holdId: 'edit-1' }] });
        release();
        await settle();
        expect(boundary.sent.at(-1)?.[1]).toEqual({ v: 1, sessionIds: [] });
    });

    it('does not admit an edit when the Home acknowledges visibility but not the requested edit', async () => {
        const home = (await scopeHomes(['pending-refusal'])).get('pending-refusal')!;
        const boundary = transport();
        cleanup.push(attachSessionHumanPresenceSocket({ serverId: home.serverId, accountId: 'self', transport: {
            ...boundary.socket,
            sendWithAck: async () => ({ v: 1, ok: true, admittedSessionIds: [] }),
        } }));
        await settle();
        await expect(registerSessionPendingMessageEdit({ serverId: home.serverId, sessionId: 's' }, 'edit-1', home.getLifetime())).rejects.toThrow();
    });
    it('settles an unacknowledged edit when its socket disconnects instead of waiting on the retired acknowledgement', async () => {
        const home = (await scopeHomes(['pending-disconnect'])).get('pending-disconnect')!;
        const boundary = transport();
        let acknowledge: ((value: unknown) => void) | undefined;
        cleanup.push(attachSessionHumanPresenceSocket({ serverId: home.serverId, accountId: 'self', transport: {
            ...boundary.socket,
            sendWithAck: async (_event, payload) => 'pendingMessageEdits' in (payload as object)
                ? new Promise(resolve => { acknowledge = resolve; })
                : { v: 1, ok: true, admittedSessionIds: [] },
        } }));
        await settle();
        let result: 'pending' | 'admitted' | 'unavailable' = 'pending';
        const admission = registerSessionPendingMessageEdit({ serverId: home.serverId, sessionId: 's' }, 'edit-1', home.getLifetime())
            .then(release => { release(); result = 'admitted'; }, () => { result = 'unavailable'; });
        await settle();
        expect(acknowledge).toBeTypeOf('function');
        boundary.socket.change(false);
        await settle();
        expect(result).toBe('unavailable');
        acknowledge?.({ v: 1, ok: true, admittedSessionIds: [], admittedPendingMessageEdits: [{ sessionId: 's', holdId: 'edit-1' }] });
        await admission;
    });
    it('declares qualified surfaces on each Home and redeclares on reconnect', async () => {
        markSessionSurfaceVisible('same', 'a'); markSessionSurfaceVisible('same', 'b');
        cleanup.push(() => { markSessionSurfaceHidden('same', 'a'); markSessionSurfaceHidden('same', 'b'); });
        const a = transport(); const b = transport();
        cleanup.push(attachSessionHumanPresenceSocket({ serverId: 'a', accountId: 'self', transport: a.socket }));
        cleanup.push(attachSessionHumanPresenceSocket({ serverId: 'b', accountId: 'self', transport: b.socket }));
        await settle();
        expect(a.sent[0]?.[1]).toEqual({ v: 1, sessionIds: ['same'] });
        expect(b.sent[0]?.[1]).toEqual({ v: 1, sessionIds: ['same'] });
        a.socket.change(false); a.socket.change(true); await settle();
        expect(a.sent).toHaveLength(2);
    });
    it('publishes only boolean actual-edit activity, throttles renewals and stops idle drafts', async () => {
        vi.useFakeTimers();
        markSessionSurfaceVisible('s', 'a'); cleanup.push(() => markSessionSurfaceHidden('s', 'a'));
        const {socket,sent} = transport();
        cleanup.push(attachSessionHumanPresenceSocket({serverId:'a',accountId:'self',transport:socket}));
        await settle();
        reportSessionTypingEdit({serverId:'a',sessionId:'s'}, true);
        reportSessionTypingEdit({serverId:'a',sessionId:'s'}, true);
        expect(sent.slice(1)).toEqual([['session-human-presence:typing-set',{v:1,sessionId:'s',typing:true}]]);
        await vi.advanceTimersByTimeAsync(4000);
        expect(sent.at(-1)?.[1]).toEqual({v:1,sessionId:'s',typing:false});
        stopSessionTyping({serverId:'a',sessionId:'s'});
    });
    it('declares, publishes typing, and clears one exact discussion without leaking to Session presence', async () => {
        const home = (await scopeHomes(['a'])).get('a')!;
        const target = { serverId: home.serverId, discussionId: 'd' };
        const lifetime = home.getLifetime();
        cleanup.push(registerDiscussionHumanPresence(target, lifetime));
        const {socket,sent} = transport();
        cleanup.push(attachSessionHumanPresenceSocket({serverId:home.serverId,accountId:'self',transport:socket}));
        await settle();
        expect(sent[0]?.[1]).toEqual({
            v: 1,
            sessionIds: [],
            locations: [{ discussionId: 'd' }],
        });
        expect(SessionHumanPresenceVisibleReplaceV1Schema.safeParse(sent[0]?.[1]).success).toBe(true);
        reportDiscussionTypingEdit(target, true, lifetime);
        expect(sent.at(-1)?.[1]).toEqual({v:1,discussionId:'d',typing:true});
        expect(SessionHumanPresenceTypingSetV1Schema.safeParse(sent.at(-1)?.[1]).success).toBe(true);
        socket.snapshot({v:1,discussionId:'d',observedAt:2,viewers:[]});
        expect(sessionHumanPresenceStore.read(target).status).toBe('live');
        expect(sessionHumanPresenceStore.read({serverId:home.serverId,sessionId:'s'}).status).toBe('unavailable');
        stopDiscussionTyping(target, lifetime);
        expect(sent.at(-1)?.[1]).toEqual({v:1,discussionId:'d',typing:false});
    });
    it('keeps identical Session and discussion ids qualified by Home', async () => {
        const scopes = await scopeHomes(['a', 'b']);
        const homeA = scopes.get('a')!; const homeB = scopes.get('b')!;
        const targetA = { serverId: homeA.serverId, discussionId: 'same-d' };
        const targetB = { serverId: homeB.serverId, discussionId: 'same-d' };
        cleanup.push(registerDiscussionHumanPresence(targetA, homeA.getLifetime()));
        cleanup.push(registerDiscussionHumanPresence(targetB, homeB.getLifetime()));
        markSessionSurfaceVisible('same-d', homeA.serverId); markSessionSurfaceVisible('same-d', homeB.serverId);
        cleanup.push(() => { markSessionSurfaceHidden('same-d', homeA.serverId); markSessionSurfaceHidden('same-d', homeB.serverId); });
        const a = transport(); const b = transport();
        cleanup.push(attachSessionHumanPresenceSocket({serverId:homeA.serverId,accountId:'self',transport:a.socket}));
        cleanup.push(attachSessionHumanPresenceSocket({serverId:homeB.serverId,accountId:'self',transport:b.socket}));
        await settle();
        const declaration = {
            v: 1,
            sessionIds: ['same-d'],
            locations: [{discussionId:'same-d'}],
        };
        expect(a.sent[0]?.[1]).toEqual(declaration);
        expect(b.sent[0]?.[1]).toEqual(declaration);
        reportDiscussionTypingEdit(targetA, true, homeA.getLifetime());
        expect(a.sent.at(-1)?.[1]).toEqual({v:1,discussionId:'same-d',typing:true});
        expect(b.sent).toHaveLength(1);
    });
    it('retires a Discussion declaration with its Account binding and rejects stale typing on its replacement', async () => {
        const home = (await scopeHomes(['account-change'])).get('account-change')!;
        const target = { serverId: home.serverId, discussionId: 'd' };
        const previousLifetime = home.getLifetime();
        cleanup.push(registerDiscussionHumanPresence(target, previousLifetime));
        const previous = transport();
        cleanup.push(attachSessionHumanPresenceSocket({ serverId: home.serverId, accountId: 'self', transport: previous.socket }));
        await settle();
        reportDiscussionTypingEdit(target, true, previousLifetime);
        credentials.accounts.set(new URL(home.serverUrl).origin, 'replacement');
        await act(async () => {
            for (const listener of credentials.listeners) listener({ kind: 'credentials_set', serverId: home.serverId, serverUrl: home.serverUrl });
        });
        await settle();
        expect(previousLifetime.isCurrent()).toBe(false);
        expect(previous.sent.slice(-2)).toEqual([
            ['session-human-presence:typing-set', { v: 1, discussionId: 'd', typing: false }],
            ['session-human-presence:visible-replace', { v: 1, sessionIds: [] }],
        ]);
        await vi.waitFor(() => expect(home.getLifetime().accountId).toBe('replacement'));
        const next = transport();
        cleanup.push(attachSessionHumanPresenceSocket({ serverId: home.serverId, accountId: 'replacement', transport: next.socket }));
        await settle();
        expect(next.sent).toEqual([['session-human-presence:visible-replace', { v: 1, sessionIds: [] }]]);
        reportDiscussionTypingEdit(target, true, previousLifetime);
        expect(next.sent).toHaveLength(1);
        const nextLifetime = home.getLifetime();
        cleanup.push(registerDiscussionHumanPresence(target, nextLifetime));
        await settle();
        reportDiscussionTypingEdit(target, true, nextLifetime);
        expect(next.sent.at(-1)?.[1]).toEqual({ v: 1, discussionId: 'd', typing: true });
        const events = next.sent.length;
        stopDiscussionTyping(target, previousLifetime);
        expect(next.sent).toHaveLength(events);
        stopDiscussionTyping(target, nextLifetime);
        expect(next.sent.at(-1)?.[1]).toEqual({ v: 1, discussionId: 'd', typing: false });
    });

    it('does not reinterpret a refused declaration and restores Session-only presence on actual visibility change', async () => {
        const home = (await scopeHomes(['refused-declaration'])).get('refused-declaration')!;
        const target = { serverId: home.serverId, discussionId: 'd' };
        const lifetime = home.getLifetime();
        markSessionSurfaceVisible('s', home.serverId);
        cleanup.push(() => markSessionSurfaceHidden('s', home.serverId));
        const unregister = registerDiscussionHumanPresence(target, lifetime);
        cleanup.push(unregister);
        const { socket, sent } = transport();
        let requests = 0;
        const sendWithAck: SessionHumanPresenceSocketTransport['sendWithAck'] = async (event, payload) => {
            sent.push([event, payload]);
            if (++requests === 1) return { v: 1, ok: false, errorCode: 'INVALID_REQUEST' };
            if (requests === 2) return { v: 1, ok: true, admittedSessionIds: ['s'] };
            // Keep a regression's unintended third request pending so it fails the assertion without spinning.
            return await new Promise(() => {});
        };
        cleanup.push(attachSessionHumanPresenceSocket({ serverId: home.serverId, accountId: 'self', transport: { ...socket, sendWithAck } }));
        await settle();
        expect(sent).toEqual([
            ['session-human-presence:visible-replace', { v: 1, sessionIds: ['s'], locations: [{ discussionId: 'd' }] }],
        ]);
        unregister();
        await settle();
        expect(sent).toEqual([
            ['session-human-presence:visible-replace', { v: 1, sessionIds: ['s'], locations: [{ discussionId: 'd' }] }],
            ['session-human-presence:visible-replace', { v: 1, sessionIds: ['s'] }],
        ]);
        reportDiscussionTypingEdit(target, true, lifetime);
        reportSessionTypingEdit({ serverId: home.serverId, sessionId: 's' }, true);
        expect(sent.at(-1)?.[1]).toEqual({ v: 1, sessionId: 's', typing: true });
        expect(sessionHumanPresenceStore.read(target).status).toBe('unavailable');
    });
    it('stops on host background and only restores viewing on foreground', async () => {
        markSessionSurfaceVisible('s', 'a'); cleanup.push(() => markSessionSurfaceHidden('s', 'a'));
        const {socket,sent} = transport();
        cleanup.push(attachSessionHumanPresenceSocket({serverId:'a',accountId:'self',transport:socket}));
        await settle();
        reportSessionTypingEdit({serverId:'a',sessionId:'s'}, true);
        Object.defineProperty(AppState, 'currentState', {value:'background', configurable:true}); hostChanged?.();
        await settle();
        expect(sent.slice(-2)).toEqual([
            ['session-human-presence:typing-set',{v:1,sessionId:'s',typing:false}],
            ['session-human-presence:visible-replace',{v:1,sessionIds:[]}],
        ]);
        Object.defineProperty(AppState, 'currentState', {value:'active', configurable:true}); hostChanged?.();
        await settle();
        expect(sent.at(-1)?.[1]).toEqual({v:1,sessionIds:['s']});
    });
    it('stops probing after inconclusive acknowledgement failure until reconnect', async () => {
        markSessionSurfaceVisible('s', 'a'); cleanup.push(() => markSessionSurfaceHidden('s', 'a'));
        const {socket,sent} = transport();
        const request = vi.fn(async () => { throw new Error('operation has timed out'); });
        cleanup.push(attachSessionHumanPresenceSocket({serverId:'a',accountId:'self',transport:{...socket,sendWithAck:request}}));
        await settle();
        expect(sessionHumanPresenceStore.read({serverId:'a',sessionId:'s'}).status).toBe('unavailable');
        markSessionSurfaceVisible('other', 'a'); cleanup.push(() => markSessionSurfaceHidden('other', 'a'));
        reportSessionTypingEdit({serverId:'a',sessionId:'s'}, true);
        await settle();
        expect(request).toHaveBeenCalledTimes(1);
        expect(sent).toEqual([]);

        // The server may have applied the declaration even when its acknowledgement
        // was lost. Backgrounding must therefore send one best-effort empty
        // replacement without treating it as another support probe.
        Object.defineProperty(AppState, 'currentState', {value:'background', configurable:true});
        hostChanged?.();
        await settle();
        expect(request).toHaveBeenCalledTimes(1);
        expect(sent).toEqual([['session-human-presence:visible-replace',{v:1,sessionIds:[]}]]);

        socket.change(false); socket.change(true); await settle();
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('best-effort clears the last visible surface after an inconclusive acknowledgement', async () => {
        markSessionSurfaceVisible('s', 'a');
        let surfaceVisible = true;
        cleanup.push(() => {
            if (surfaceVisible) markSessionSurfaceHidden('s', 'a');
        });
        const {socket,sent} = transport();
        const request = vi.fn(async () => { throw new Error('operation has timed out'); });
        cleanup.push(attachSessionHumanPresenceSocket({
            serverId: 'a',
            accountId: 'self',
            transport: {...socket,sendWithAck:request},
        }));
        await settle();

        markSessionSurfaceHidden('s', 'a');
        surfaceVisible = false;
        await settle();

        expect(request).toHaveBeenCalledTimes(1);
        expect(sent).toEqual([['session-human-presence:visible-replace',{v:1,sessionIds:[]}]]);
    });

    it('ignores an old acknowledgement and snapshots after socket replacement', async () => {
        markSessionSurfaceVisible('s', 'a'); cleanup.push(() => markSessionSurfaceHidden('s', 'a'));
        const old = transport(); const next = transport();
        let acknowledge: ((value: unknown) => void) | undefined;
        cleanup.push(attachSessionHumanPresenceSocket({serverId:'a',accountId:'self',transport:{...old.socket,sendWithAck:() => new Promise(resolve => { acknowledge = resolve; })}}));
        cleanup.push(attachSessionHumanPresenceSocket({serverId:'a',accountId:'self',transport:next.socket}));
        await settle();
        acknowledge?.({v:1,ok:false,errorCode:'UNSUPPORTED_VERSION'});
        old.socket.snapshot({v:1,sessionId:'s',observedAt:1,viewers:[]});
        await settle();
        expect(sessionHumanPresenceStore.read({serverId:'a',sessionId:'s'}).status).toBe('connecting');
        next.socket.snapshot({v:1,sessionId:'s',observedAt:2,viewers:[]});
        expect(sessionHumanPresenceStore.read({serverId:'a',sessionId:'s'}).status).toBe('live');
    });

    it('does not accept a snapshot as negotiation before the operation acknowledges support', async () => {
        markSessionSurfaceVisible('s', 'a'); cleanup.push(() => markSessionSurfaceHidden('s', 'a'));
        const {socket} = transport();
        let acknowledge: ((value: unknown) => void) | undefined;
        cleanup.push(attachSessionHumanPresenceSocket({serverId:'a',accountId:'self',transport:{...socket,sendWithAck:() => new Promise(resolve => { acknowledge = resolve; })}}));
        socket.snapshot({v:1,sessionId:'s',observedAt:1,viewers:[]});
        expect(sessionHumanPresenceStore.read({serverId:'a',sessionId:'s'}).status).toBe('connecting');
        acknowledge?.({v:1,ok:true,admittedSessionIds:['s']}); await settle();
        socket.snapshot({v:1,sessionId:'s',observedAt:2,viewers:[]});
        expect(sessionHumanPresenceStore.read({serverId:'a',sessionId:'s'}).status).toBe('live');
    });

    it('separates a permanent unsupported answer from temporary unavailability', async () => {
        markSessionSurfaceVisible('s', 'a'); cleanup.push(() => markSessionSurfaceHidden('s', 'a'));
        const {socket,sent} = transport();
        let result: unknown = {v:1,ok:false,errorCode:'UNAVAILABLE'};
        cleanup.push(attachSessionHumanPresenceSocket({serverId:'a',accountId:'self',transport:{...socket,sendWithAck: async (event, payload) => { sent.push([event,payload]); return result; }}}));
        await settle();
        expect(sessionHumanPresenceStore.read({serverId:'a',sessionId:'s'}).status).toBe('unavailable');
        // A rejected declaration is not retried on its own, and typing never rides an unadmitted set.
        reportSessionTypingEdit({serverId:'a',sessionId:'s'}, true);
        expect(sent).toHaveLength(1);
        // The Home answered in V1, so an actual visibility change must be declared again.
        result = {v:1,ok:true,admittedSessionIds:['s','t']};
        markSessionSurfaceVisible('t', 'a'); cleanup.push(() => markSessionSurfaceHidden('t', 'a'));
        await settle();
        expect(sent.at(-1)?.[1]).toEqual({v:1,sessionIds:['s','t']});
        socket.snapshot({v:1,sessionId:'s',observedAt:3,viewers:[]});
        expect(sessionHumanPresenceStore.read({serverId:'a',sessionId:'s'}).status).toBe('live');
    });

    it('stops permanently for an unsupported-version answer until reconnect', async () => {
        markSessionSurfaceVisible('s', 'a'); cleanup.push(() => markSessionSurfaceHidden('s', 'a'));
        const {socket,sent} = transport();
        cleanup.push(attachSessionHumanPresenceSocket({serverId:'a',accountId:'self',transport:{...socket,sendWithAck: async (event, payload) => { sent.push([event,payload]); return {v:1,ok:false,errorCode:'UNSUPPORTED_VERSION'}; }}}));
        await settle();
        expect(sessionHumanPresenceStore.read({serverId:'a',sessionId:'s'}).status).toBe('unsupported');
        markSessionSurfaceVisible('t', 'a'); cleanup.push(() => markSessionSurfaceHidden('t', 'a'));
        await settle();
        expect(sent).toHaveLength(1);
    });

    it('routes profile aliases and composer intent through the learned Home identity', async () => {
        const home = await upsertServerProfile({serverUrl:'https://presence-alias.example.test', source:'manual'});
        await setServerProfileIdentityForUrl(home.serverUrl, 'srv_presence_alias');
        cleanup.push(async () => await removeServerProfile(home.id));
        markSessionSurfaceVisible('s', home.id); cleanup.push(() => markSessionSurfaceHidden('s', home.id));
        const {socket,sent} = transport();
        cleanup.push(attachSessionHumanPresenceSocket({serverId:home.id,accountId:'self',transport:socket}));
        await settle();
        expect(sent[0]?.[1]).toEqual({v:1,sessionIds:['s']});
        reportSessionTypingEdit({serverId:home.id,sessionId:'s'}, true);
        expect(sent.at(-1)?.[1]).toEqual({v:1,sessionId:'s',typing:true});
        stopSessionTyping({serverId:'srv_presence_alias',sessionId:'s'});
        expect(sent.at(-1)?.[1]).toEqual({v:1,sessionId:'s',typing:false});
    });

});
