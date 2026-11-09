import { describe, expect, it } from 'vitest';
import { listHappierProcessRoots } from '../roots/listHappierProcessRoots';
import { resolveProcessOwnerRequester } from './resolveProcessOwnerRequester';
import type { HappierProcessRoot, ProcessOwnerRef } from './types';

const target = { serverId: 'server', machineId: 'machine', installationId: 'install' };
const attribution = { ...target, accountId: 'guest' };
const context = { target, custodianAccountId: 'custodian',
    requesterIdentities: new Map([['guest', { accountId: 'guest', displayName: 'Guest Name' }]]) };
const root = (owner: ProcessOwnerRef, stamp = attribution, live = true): HappierProcessRoot => ({
    owner, pid: 20, start: { startTimeMs: 200 }, ownerCreatedAtMs: 200, live,
    requesterWorkAttributionV1: stamp,
});

describe('resolveProcessOwnerRequester', () => {
    it('projects guest attribution from canonical tracked and retained ended roots without a runtime registry', () => {
        const owner = { kind: 'session', sessionId: 's1' } as const;
        const input = { snapshot: { status: 'ok' as const, logicalCpus: 4, capturedAtMs: 1000,
            rows: [{ pid: 20, ppid: 1, start: { startTimeMs: 200 }, principal: { kind: 'uid' as const, value: '1000' },
                name: 'node', memory: null, cpuTimeUs: null }] }, platform: 'darwin' as const, selfPid: 10,
            daemonScopeKey: '123456789abc' };
        const live = listHappierProcessRoots({ ...input, trackedSessions: [{ pid: 20, happySessionId: 's1',
            processStartTimeMs: 200, requesterWorkAttributionV1: attribution }] });
        expect(resolveProcessOwnerRequester(owner, live, context)).toEqual({ accountId: 'guest', displayName: 'Guest Name' });
        const ended = listHappierProcessRoots({ ...input, snapshot: { ...input.snapshot, rows: [] },
            endedRoots: live.map(root => ({ ...root, live: false })) });
        expect(resolveProcessOwnerRequester(owner, ended, context)).toEqual({ accountId: 'guest', displayName: 'Guest Name' });
    });
    it('uses the actual associated session for unstamped terminal, service and run roots, not the custodian', () => {
        for (const owner of [{ kind: 'terminal', terminalId: 't' }, { kind: 'service', serviceId: 'svc' },
            { kind: 'run', runId: 'run' }] as const) {
            const associated = { ...root({ ...owner, sessionId: 's1' }), requesterWorkAttributionV1: undefined };
            expect(resolveProcessOwnerRequester(owner, [associated, root({ kind: 'session', sessionId: 's1' })], context))
                .toEqual({ accountId: 'guest', displayName: 'Guest Name' });
            expect(resolveProcessOwnerRequester(owner, [associated], context)).toBeNull();
        }
    });
    it('fails closed for legacy work, foreign target stamps and conflicting guest accounts; never invents a display name', () => {
        const owner = { kind: 'session', sessionId: 's1' } as const;
        expect(resolveProcessOwnerRequester(owner, [{ ...root(owner), requesterWorkAttributionV1: undefined }], context)).toBeNull();
        for (const field of ['serverId', 'machineId', 'installationId'] as const) {
            expect(resolveProcessOwnerRequester(owner, [root(owner, { ...attribution, [field]: 'foreign' })], context)).toBeNull();
        }
        expect(resolveProcessOwnerRequester(owner, [root(owner), root(owner, { ...attribution, accountId: 'other' })], context)).toBeNull();
        expect(resolveProcessOwnerRequester(owner, [root(owner)], { target, custodianAccountId: 'custodian' }))
            .toEqual({ accountId: 'guest' });
    });
    it('prefers the current lifecycle over ended facts and attributes only actual daemon/helper roots to the custodian', () => {
        const owner = { kind: 'session', sessionId: 's1' } as const;
        expect(resolveProcessOwnerRequester(owner, [root(owner), root(owner, { ...attribution, accountId: 'old' }, false)], context))
            .toEqual({ accountId: 'guest', displayName: 'Guest Name' });
        for (const owner of [{ kind: 'happier' }, { kind: 'browser_sidecar' }, { kind: 'workspace_sync' }] as const) {
            expect(resolveProcessOwnerRequester(owner, [{ ...root(owner), requesterWorkAttributionV1: undefined }], context))
                .toEqual({ accountId: 'custodian' });
            expect(resolveProcessOwnerRequester(owner, [], context)).toBeNull();
        }
    });
});
