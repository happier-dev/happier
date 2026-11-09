import React from 'react';
import { expect } from 'vitest';
import 'fake-indexeddb/auto';
import {
    API_TOKEN_FULL_GRANT_V1} from '@happier-dev/protocol/auth/apiTokenGrant';
import {
    computeAccountEncryptionMigrateKeyFingerprintV1,
} from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { renderScreen } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';

/**
 * The real API-token settings controller on a real Home and Account scope, for controller and
 * screen tests alike. Persisted credential reads and HTTP are the only boundaries: the controller,
 * scope lifetime, Action admission, adapters and all crypto stay real. The fake Home echoes the
 * create request the way the server does, so a screen sees the row it would see live.
 */
export type ApiTokenSettingsControllerHarnessOptions = Readonly<{
    failure?: 'network' | 'mismatch' | 'unsupported' | 'malformed' | 'conflict' | 'account-disabled';
    /** Holds the create response after the Home has durably accepted it. */
    hold?: Promise<void>;
    /** Holds the encryption currentness read. */
    holdCurrentness?: Promise<void>;
    mode?: 'plain' | 'e2ee';
    readiness?: 'available' | 'unavailable';
    /** Token rows the Home already holds, as its list returns them. */
    rows?: readonly Record<string, unknown>[];
}>;

export type ApiTokenSettingsControllerHarnessRequest = Readonly<{ path: string; body: Record<string, unknown> }>;

const authScreens: Awaited<ReturnType<typeof renderScreen>>[] = [];
const accounts: Awaited<ReturnType<typeof createSecretSettingsTestHarness>>[] = [];
let nextHome = 0;

/** Unmounts every harness auth provider; call from `afterEach`. */
export async function disposeApiTokenSettingsControllerHarnesses(): Promise<void> {
    for (const screen of authScreens.splice(0).reverse()) await screen.unmount();
    for (const account of accounts.splice(0).reverse()) await account.dispose();
}

export async function createApiTokenSettingsControllerHarness(options: ApiTokenSettingsControllerHarnessOptions = {}) {
    installDisconnectedServerSocketBoundary();
    await loadSyncSingletonForTests();
    const account = await createSecretSettingsTestHarness({
        mode: options.mode ?? 'e2ee', sharedEnabled: false, serverIdentityId: `srv_token-ui-${++nextHome}`,
    });
    accounts.push(account);
    const { credentials, encryption } = account;
    // Complete the mounted client's real credential projection before observing
    // controller traffic or holding one of its optional currentness reads.
    const { InjectedAuthProvider, getCurrentAuth } = await import('@/auth/context/AuthContext');
    authScreens.push(await renderScreen(React.createElement(InjectedAuthProvider, {
        credentials, children: React.createElement(React.Fragment),
    })));
    expect(getCurrentAuth()?.credentialAuthorityKind).toBe('account');
    const requests: ApiTokenSettingsControllerHarnessRequest[] = [];
    const rows: Record<string, unknown>[] = [...(options.rows ?? [])];
    let currentnessAvailable = true;
    let listAvailable = true;
    let readiness = options.readiness ?? 'available';
    const requestAccount = account.request.getMockImplementation();
    if (!requestAccount) throw new Error('API token fixture requires its real Account HTTP boundary');
    account.request.mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        const tokenRequest = url.pathname.startsWith('/v1/auth/api-tokens/');
        if (!tokenRequest && url.pathname !== '/v1/account/encryption/currentness') return requestAccount(input, init);
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        requests.push({ path: url.pathname, body });
        let response: unknown = { ok: true };
        if (url.pathname === '/v1/account/encryption/currentness') {
            await options.holdCurrentness;
            if (!currentnessAvailable) throw new Error('Home unavailable');
            response = options.mode === 'plain' ? {
                mode: 'plain', version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
                recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
            } : {
                mode: 'e2ee', version: 1, updatedAt: 1, signingKeyFingerprint: 'signing',
                contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(encryption!.contentDataKey),
                recipientEnvelopeReadiness: readiness === 'unavailable'
                    ? { status: 'unavailable', reason: 'encryption_setup_required' }
                    : { status: 'available' },
            };
        }
        if (url.pathname === '/v1/auth/api-tokens/create') {
            if (options.failure === 'unsupported') return new Response('{}', { status: 404 });
            if (options.failure === 'conflict') {
                return new Response(JSON.stringify({ error: 'api_token_id_conflict' }), { status: 409 });
            }
            if (options.failure === 'account-disabled') {
                return new Response(JSON.stringify({ error: 'account-disabled' }), { status: 403 });
            }
            const encryptionArm = body.encryption as { access?: unknown } | undefined;
            const tokenId = options.failure === 'mismatch'
                ? '22222222-2222-4222-8222-222222222222'
                : String(body.tokenId);
            const row = {
                tokenId,
                label: body.label,
                displayPrefix: `hap_v1_${String(tokenId).slice(0, 8)}`,
                createdAt: '2026-09-06T00:00:00.000Z',
                expiresAt: body.expiresAt,
                lastUsedAt: null,
                hasEncryptionAccess: encryptionArm !== undefined,
                hasUnattendedTeamAccess: body.authorizeUnattendedTeamAccess === true,
                grant: body.grant ?? API_TOKEN_FULL_GRANT_V1,
                parentTokenId: null,
                activeChildCount: 0,
                // The Home stores and returns the embed configuration it was given.
                embedConfig: body.embedConfig ?? null,
            };
            rows.push(row);
            // The Home has durably accepted this exact selector before the
            // response is held. Dismissal now aborts the real request signal,
            // so the adapter must settle from its issued witness rather than a
            // late-success-only test double.
            await options.hold;
            if (init?.signal?.aborted) {
                const error = new Error('response aborted after commit');
                error.name = 'AbortError';
                throw error;
            }
            if (options.failure === 'network') throw new Error('response lost');
            response = { token: `hap_v1_${tokenId}_${'A'.repeat(43)}`, apiToken: row };
            if (options.failure === 'malformed') response = { token: 'malformed', apiToken: row };
        }
        if (url.pathname.endsWith('/list')) {
            if (!listAvailable) throw new Error('Home unavailable');
            response = { tokens: rows };
        }
        if (url.pathname.endsWith('/revoke')) {
            const tokenId = typeof body.tokenId === 'string' ? body.tokenId : '';
            const rowIndex = rows.findIndex((row) => row.tokenId === tokenId);
            if (rowIndex >= 0) rows.splice(rowIndex, 1);
            response = { revoked: rowIndex >= 0 };
        }
        return new Response(JSON.stringify(response), { status: 200 });
    });
    const { createApiTokenSettingsController } = await import('./apiTokenSettingsController');
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const controller = createApiTokenSettingsController({
        execute: createDefaultActionExecutor().execute,
        captureActiveAccountScopeLifetime: captureActiveServerAccountScopeLifetime,
        now: Date.now,
    });
    expect(captureActiveServerAccountScopeLifetime()?.isCurrent()).toBe(true);
    return {
        controller,
        requests,
        encryption,
        scope: account.scope,
        withdrawCurrentness: () => { currentnessAvailable = false; },
        /** Whether the Home answers the token list from the next read on. */
        setListAvailable: (next: boolean) => { listAvailable = next; },
        /** The Account's recipient-envelope readiness the Home reports from the next read on. */
        setReadiness: (next: 'available' | 'unavailable') => { readiness = next; },
    };
}
