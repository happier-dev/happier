import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kvStore = vi.hoisted(() => new Map<string, string>());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/auth/storage/tokenStorage')
    >();
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getCredentialsForServerUrl: getCredentialsForServerUrlMock,
        },
    };
});

import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import {
    adoptHomeProfile,
    resolveServerProfileScopeIdForIdentifier,
    setActiveServerId,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/sync/http/client';

import { setSessionResponsibleAccount, listSessionResponsibilityCandidates } from './apiSessionResponsibility';
import { listSessionDiscussionMentionCandidates } from './sessionDiscussionActions';

/**
 * Assignment confirmation is required by default on the app
 * (teams-lane-04/11-responsible-assignment.md §7.1). Tests of the direct
 * transport outcome therefore use the user's canonical Actions waiver.
 */
const ASSIGNMENT_CONFIRMATION_WAIVED_SETTINGS = settingsParse({
    ...settingsDefaults,
    actionsSettingsV1: {
        v: 1,
        actions: {},
        approvalWaivedSurfaces: { 'session.responsibility.set': ['ui'] },
    },
});

function tokenForSub(sub: string): string {
    return `e30.${globalThis.btoa(JSON.stringify({ sub }))}.signature`;
}

describe('responsibility exact Account authority', () => {
    beforeEach(() => {
        kvStore.clear();
        runtimeFetchMock.mockReset();
        getCredentialsForServerUrlMock.mockReset();
        setRuntimeFetch(runtimeFetchMock);
    });

    afterEach(() => resetRuntimeFetch());

    it('rejects switched Account credentials before reading candidates or mutating a same-ID Session', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://responsibility.example', name: 'Home' });
        await setActiveServerId(home.id, { scope: 'device' });
        getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('other-account') });
        storage.getState().applySettingsForScope({ serverId: home.id, accountId: 'other-account' }, settingsDefaults, 1);
        runtimeFetchMock.mockImplementation(async () => new Response(
            JSON.stringify({ mode: 'plain', updatedAt: 1 }),
            { status: 200 },
        ));
        const scope = { serverId: home.id, accountId: 'original-account' };
        await expect(setSessionResponsibleAccount(scope, { sessionId: 'same-id', responsibleAccountId: null }))
            .rejects.toMatchObject({ failure: 'unknown' });
        await expect(listSessionResponsibilityCandidates(scope, { sessionId: 'same-id' }))
            .rejects.toMatchObject({ failure: 'unknown' });
        expect(runtimeFetchMock.mock.calls.some(([input]) =>
            String(input).includes('/v2/sessions/responsibility/'))).toBe(false);
    });

    it('gives the Lane 05 editor one exact-Home mention candidate seam with mention purpose', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://responsibility.example', name: 'Home' });
        await setActiveServerId(home.id, { scope: 'device' });
        getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account-1') });
        storage.getState().applySettingsForScope({ serverId: home.id, accountId: 'account-1' }, settingsDefaults, 1);
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            if (String(input).includes('/v1/account/encryption')) {
                return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
            }
            return new Response(JSON.stringify({
                candidates: [{
                    accountId: 'account-2',
                    profile: { firstName: 'Bob', lastName: null, username: 'bob', avatarUrl: null },
                }],
                nextCursor: null,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });

        const result = await listSessionDiscussionMentionCandidates({
            scope: { serverId: home.id, accountId: 'account-1' },
            session: { serverId: home.id, sessionId: 'session-1' },
            availability: 'available',
            query: 'bo',
        });

        expect(result.candidates[0]?.accountId).toBe('account-2');
        const candidateRequest = runtimeFetchMock.mock.calls.find(([input]) =>
            String(input).includes('/v2/sessions/responsibility/candidates'));
        const requestInit = candidateRequest?.[1] as RequestInit | undefined;
        expect(JSON.parse(String(requestInit?.body))).toMatchObject({
            sessionId: 'session-1',
            purpose: 'mention',
            query: 'bo',
        });
    });

    it('serves mention candidates for a Session addressed by its profile id on an identity-bearing Home', async () => {
        // A Home that publishes a portable identity is scoped by that identity,
        // while a Session route may still carry the device-local profile id.
        const home = await adoptHomeProfile({
            descriptor: {
                serverUrl: 'https://responsibility-identity.example',
                homeServerIdentityId: 'srv_responsibility-home',
                displayName: 'Home',
            },
            source: 'manual',
            suggestedName: 'Home',
        });
        await setActiveServerId(home.id, { scope: 'device' });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(home.id), accountId: 'account-1' };
        expect(scope.serverId).not.toBe(home.id);
        getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account-1') });
        storage.getState().applySettingsForScope(scope, settingsDefaults, 1);
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            if (String(input).includes('/v1/account/encryption')) {
                return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
            }
            return new Response(JSON.stringify({
                candidates: [{
                    accountId: 'account-2',
                    profile: { firstName: 'Bob', lastName: null, username: 'bob', avatarUrl: null },
                }],
                nextCursor: null,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });

        const result = await listSessionDiscussionMentionCandidates({
            scope,
            session: { serverId: home.id, sessionId: 'session-1' },
            availability: 'available',
            query: 'bo',
        });
        expect(result.candidates[0]?.accountId).toBe('account-2');

        // A different Home is still refused before any candidate request.
        runtimeFetchMock.mockClear();
        await expect(listSessionDiscussionMentionCandidates({
            scope,
            session: { serverId: 'another-home', sessionId: 'session-1' },
            availability: 'available',
        })).rejects.toThrow('Discussion mention candidates require the exact Session Home');
        expect(runtimeFetchMock.mock.calls.some(([input]) =>
            String(input).includes('/v2/sessions/responsibility/'))).toBe(false);
    });

    it('distinguishes the canonical feature-gate 404 from a typed missing Session', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://responsibility.example', name: 'Home' });
        await setActiveServerId(home.id, { scope: 'device' });
        getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account-1') });
        storage.getState().applySettingsForScope({ serverId: home.id, accountId: 'account-1' }, settingsDefaults, 1);
        const scope = { serverId: home.id, accountId: 'account-1' };
        let error = 'not_found';
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            if (String(input).endsWith('/v1/auth/ping')) {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (String(input).includes('/v1/account/encryption')) {
                return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
            }
            return new Response(
                JSON.stringify({ error }),
                { status: 404, headers: { 'Content-Type': 'application/json' } },
            );
        });

        await expect(listSessionResponsibilityCandidates(scope, { sessionId: 'session-1' }, {
            availability: 'available',
        })).rejects.toMatchObject({ failure: 'unsupported' });

        error = 'session_access_session_not_found';
        await expect(listSessionResponsibilityCandidates(scope, { sessionId: 'session-1' }, {
            availability: 'available',
        })).rejects.toMatchObject({ failure: 'not-found' });
    });

    it('maps only the typed responsibility conflict to assignee-unavailable', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://responsibility.example', name: 'Home' });
        await setActiveServerId(home.id, { scope: 'device' });
        getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account-1') });
        storage.getState().applySettingsForScope({ serverId: home.id, accountId: 'account-1' }, ASSIGNMENT_CONFIRMATION_WAIVED_SETTINGS, 1);
        const scope = { serverId: home.id, accountId: 'account-1' };
        let error: string | undefined = 'session_responsibility_assignee_unavailable';
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            if (String(input).endsWith('/v1/auth/ping')) {
                return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (String(input).includes('/v1/account/encryption')) {
                return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
            }
            return new Response(JSON.stringify(error === undefined ? {} : { error }), {
                status: 409,
                headers: { 'Content-Type': 'application/json' },
            });
        });

        await expect(setSessionResponsibleAccount(scope, {
            sessionId: 'session-1',
            responsibleAccountId: 'account-2',
        }, { availability: 'available' })).rejects.toMatchObject({ failure: 'assignee-unavailable' });

        error = 'some_other_conflict';
        await expect(setSessionResponsibleAccount(scope, {
            sessionId: 'session-1',
            responsibleAccountId: 'account-2',
        }, { availability: 'available' })).rejects.toMatchObject({ failure: 'unknown' });

        error = undefined;
        await expect(setSessionResponsibleAccount(scope, {
            sessionId: 'session-1',
            responsibleAccountId: 'account-2',
        }, { availability: 'available' })).rejects.toMatchObject({ failure: 'unknown' });
    });

    it('preserves canonical Team authentication failures for mutation and candidate requests', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://responsibility.example', name: 'Home' });
        await setActiveServerId(home.id, { scope: 'device' });
        getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account-1') });
        storage.getState().applySettingsForScope({ serverId: home.id, accountId: 'account-1' }, ASSIGNMENT_CONFIRMATION_WAIVED_SETTINGS, 1);
        const scope = { serverId: home.id, accountId: 'account-1' };
        let status = 403;
        let error = 'session_access_authentication_required';
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            if (String(input).endsWith('/v1/auth/ping')) {
                return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (String(input).includes('/v1/account/encryption')) {
                return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
            }
            return new Response(JSON.stringify({ error }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            });
        });

        await expect(setSessionResponsibleAccount(scope, {
            sessionId: 'session-1',
            responsibleAccountId: 'account-2',
        }, { availability: 'available' })).rejects.toMatchObject({
            failure: 'session_access_authentication_required',
        });

        status = 503;
        error = 'session_access_authentication_unavailable';
        await expect(listSessionResponsibilityCandidates(scope, { sessionId: 'session-1' }, {
            availability: 'available',
        })).rejects.toMatchObject({
            failure: 'session_access_authentication_unavailable',
        });
    });

    it('routes an assignment to approval by default, as a typed pending outcome, never a committed assignment', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://responsibility.example', name: 'Home' });
        await setActiveServerId(home.id, { scope: 'device' });
        getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account-1') });
        // No explicit require: the canonical Actions default alone creates the approval.
        storage.getState().applySettingsForScope({ serverId: home.id, accountId: 'account-1' }, settingsDefaults, 1);
        const scope = { serverId: home.id, accountId: 'account-1' };
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/v1/auth/ping')) {
                return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (url.includes('/v1/account/encryption')) {
                return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
            }
            if (url.endsWith('/v1/features') || url.includes('/v1/features/')) {
                // A plain-Account Artifact write asks the canonical stored-content
                // compatibility owner first, so the probe answers as a current Home.
                return new Response(JSON.stringify({
                    features: {},
                    capabilities: {
                        accountStoredContentCompatibility: {
                            v: 1,
                            minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                            declarationTransport: 'http-header-and-socket-auth-v1',
                        },
                    },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            const artifactResponse = artifacts.handle(new URL(url).pathname, init);
            if (artifactResponse) return await artifactResponse;
            return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });

        // The deferred Action has not committed anything: the caller must learn
        // that, keep the approval identity, and never parse the custody result
        // as an authoritative assignment.
        await expect(setSessionResponsibleAccount(scope, {
            sessionId: 'session-1',
            responsibleAccountId: 'account-2',
        }, { availability: 'available' })).rejects.toMatchObject({
            failure: 'approval-pending',
        });
        expect(runtimeFetchMock.mock.calls.some(([input]) =>
            String(input).includes('/v2/sessions/responsibility/'))).toBe(false);
    });
});
