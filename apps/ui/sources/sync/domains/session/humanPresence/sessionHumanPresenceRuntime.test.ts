import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { attachSessionHumanPresenceSocket, registerSessionDiscussionHumanPresence, reportSessionDiscussionTypingEdit, reportSessionTypingEdit, stopSessionDiscussionTyping, stopSessionTyping, type SessionHumanPresenceSocketTransport } from './sessionHumanPresenceRuntime';
import { upsertServerProfile, setServerProfileIdentityForUrl, removeServerProfile } from '@/sync/domains/server/serverProfiles';
import { AppState } from 'react-native';
import { sessionHumanPresenceStore } from './sessionHumanPresenceStore';
import { markSessionSurfaceVisible, markSessionSurfaceHidden } from '../sessionSurfaceVisibility';

type TestTransport = SessionHumanPresenceSocketTransport & {
    connected: boolean;
    snapshot(payload: unknown): void;
    change(connected: boolean): void;
};
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
            };
        },
        snapshot(payload: unknown) { snapshot?.(payload); },
        change(connected: boolean) { socket.connected = connected; status?.(); },
    };
    return { socket, sent };
}
const cleanup: Array<() => void | Promise<void>> = [];
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
        const target = { serverId: 'a', sessionId: 's', discussionId: 'd' };
        cleanup.push(registerSessionDiscussionHumanPresence(target));
        const {socket,sent} = transport();
        cleanup.push(attachSessionHumanPresenceSocket({serverId:'a',accountId:'self',transport:socket}));
        await settle();
        expect(sent[0]?.[1]).toEqual({
            v: 1,
            sessionIds: [],
            locations: [{ sessionId: 's', discussionId: 'd' }],
        });
        reportSessionDiscussionTypingEdit(target, true);
        expect(sent.at(-1)?.[1]).toEqual({v:1,sessionId:'s',discussionId:'d',typing:true});
        socket.snapshot({v:1,sessionId:'s',discussionId:'d',observedAt:2,viewers:[]});
        expect(sessionHumanPresenceStore.read(target).status).toBe('live');
        expect(sessionHumanPresenceStore.read({serverId:'a',sessionId:'s'}).status).toBe('unavailable');
        stopSessionDiscussionTyping(target);
        expect(sent.at(-1)?.[1]).toEqual({v:1,sessionId:'s',discussionId:'d',typing:false});
    });
    it('keeps identical Session and discussion ids qualified by Home', async () => {
        cleanup.push(registerSessionDiscussionHumanPresence({serverId:'a',sessionId:'same',discussionId:'same-d'}));
        cleanup.push(registerSessionDiscussionHumanPresence({serverId:'b',sessionId:'same',discussionId:'same-d'}));
        const a = transport(); const b = transport();
        cleanup.push(attachSessionHumanPresenceSocket({serverId:'a',accountId:'self',transport:a.socket}));
        cleanup.push(attachSessionHumanPresenceSocket({serverId:'b',accountId:'self',transport:b.socket}));
        await settle();
        const declaration = {
            v: 1,
            sessionIds: [],
            locations: [{sessionId:'same',discussionId:'same-d'}],
        };
        expect(a.sent[0]?.[1]).toEqual(declaration);
        expect(b.sent[0]?.[1]).toEqual(declaration);
        reportSessionDiscussionTypingEdit({serverId:'a',sessionId:'same',discussionId:'same-d'}, true);
        expect(a.sent.at(-1)?.[1]).toEqual({v:1,sessionId:'same',discussionId:'same-d',typing:true});
        expect(b.sent).toHaveLength(1);
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
