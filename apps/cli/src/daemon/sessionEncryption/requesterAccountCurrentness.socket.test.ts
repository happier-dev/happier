import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { projectAccountEncryptionIdentity } from '@happier-dev/sync-client';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createRequesterSessionFollowSourceReconciliation } from './requesterSessionFollowSourceReconciliation';
import { fetchInactiveSessionFollowObservations } from '@/session/transport/http/sessionFollowInactiveObservationsHttp';
import { admitRequesterAccountActionContext, prepareRequesterAccountActionContext } from "./requesterAccountActionProjection";
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { acquireRequesterAccountEncryptionCurrentness, readRequesterAccountEncryptionCurrentness,
    readObservedAccountEncryptionCurrentness, isRequesterAccountEncryptionCurrentnessObserved,
    type RequesterEnvironmentAccessObservation } from '@/api/client/accountEncryptionCurrentnessObservation';

import { buildDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { LinkedProviderSchema } from '@happier-dev/protocol/account/profile';
import { AccountEncryptionCurrentnessUnavailableError } from '@/api/client/accountEncryptionCurrentness';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createExternalActionAuthorizedRequestHeaders, projectExternalActionRequesterHttpAuthorization, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { prepareRequesterSessionBootstrap } from './requesterSessionCredentials';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { ConnectedServiceCredentialHttpClient, fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readHttpStatus } from '@/api/client/httpStatusError';
import { projectAutomationAccountCurrentnessWitnessV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { logger } from '@/ui/logger';
import { buildSessionFollowChangeHintV1, buildSessionFollowReceiverChangeEntityIdV1 } from '@happier-dev/protocol/sessions/follow/changes';
import { buildAccountIdentitiesChangeV1, buildConnectedServicesAccountChangeV1, buildProviderAccountUsageRefreshChangeV1, type ChangeEntry } from '@happier-dev/protocol/changes';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { createCliReviewCommentActionExecutorFromCredentials } from '@/agent/reviews/comments/executor';
import { ReviewCommentPrepareMutationRequestV1Schema } from '@happier-dev/protocol/reviews/comments/mutation';
import { splitReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/content';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { createProviderAccountUsagePersistenceScheduler } from '@/daemon/connectedServices/accountUsage/persistence';
import { buildProviderAccountUsageRecordId, openSealedProviderAccountUsageSnapshot,
    type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol/connect/accountUsage';
import { QualifiedProviderAccountUsageWriteV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { createAccountSessionFollowRuleCache } from '@/agent/runtime/session/follow/accountSessionFollowRuleCache';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { SessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { sealSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';

it('recovers K pending requester receivers once per Account instead of replaying N retained receiver hints', async () => {
    const channel = await createRequesterCurrentnessSocketHarness();
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`, encryption: null };
    const lifetime = new AbortController();
    const receiverIds = Array.from({ length: 50 }, (_, index) => `c${String(index + 1000).padStart(23, '0')}`);
    let base = 0;
    let pendingIds: string[] = [];
    let accountReads = 0;
    const observations: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
        if (url.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null } };
        if (new URL(url).pathname !== '/v2/changes') throw new Error(`Unexpected GET ${url}`);
        const after = Number(new URL(url).searchParams.get('after') ?? 0);
        const changes = receiverIds.map((id, index) => ({ cursor: base + index + 1, kind: 'account',
            entityId: buildSessionFollowReceiverChangeEntityIdV1(id), changedAt: 1 })).filter(change => change.cursor > after);
        return { status: 200, data: { changes, nextCursor: changes.at(-1)?.cursor ?? after } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === '/v2/follows/pending-receivers') {
            accountReads++;
            return { status: 200, data: { ok: true, v: 1, sessionIds: pendingIds } };
        }
        const match = path.match(/^\/v2\/sessions\/([^/]+)\/follows\/inactive-observations$/);
        if (!match) throw new Error(`Unexpected POST ${path}`);
        observations.push(match[1]);
        return { status: 200, data: { ok: false, v: 1, error: 'forbidden' } };
    });
    const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: credentials.token,
        serverBaseUrl: 'https://requester-follow-recovery.example' });
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials,
        serverHttpBaseUrl: 'https://requester-follow-recovery.example', signal: lifetime.signal,
        subscribeInvalidation: observation.subscribeSessionFollowRules });
    const recoveries = receiverIds.map(sessionId => {
        const recovery = createRequesterSessionFollowSourceReconciliation({ bootstrap: {
            getBoundSessionId: () => sessionId, subscribeSessionFollowSources: observation.subscribeSessionFollowSources,
        }, sessionFollowRuleCache: cache, receiverRecovery: { machineId: 'machine', installationId: 'installation' } });
        recovery.bind(async () => {
            await fetchInactiveSessionFollowObservations({ token: credentials.token, destinationSessionId: sessionId,
                machineId: 'machine', installationId: 'installation', reason: 'receiver-recovery', signal: lifetime.signal });
        }, lifetime.signal);
        return recovery;
    });
    try {
        await observation.read();
        await vi.waitFor(() => expect({ accountReads, observations }).toEqual({ accountReads: 1, observations: [] }));
        await channel.pushProfile('bob');
        expect(observations, 'zero pending receivers perform no observations').toEqual([]);
        pendingIds = [receiverIds[0]];
        base += receiverIds.length;
        await channel.disconnect();
        await channel.reconnect();
        await vi.waitFor(() => expect(accountReads).toBe(2));
        await vi.waitFor(() => expect(observations).toEqual(pendingIds));
        base += receiverIds.length;
        await channel.hintAccountChange(base + receiverIds.length);
        await vi.waitFor(() => expect(observations).toHaveLength(receiverIds.length + 1));
        expect(accountReads, 'live receiver demand does not repeat Account recovery').toBe(2);
    } finally {
        lifetime.abort(); recoveries.forEach(recovery => recovery.dispose()); cache.dispose();
        await observation.dispose(); await channel.close(); vi.restoreAllMocks();
    }
});
const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
    accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 },
    accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
    actionId: 'projects.inspect', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
    target: { kind: 'machine', machineId: 'machine' },
} });
afterEach(() => vi.restoreAllMocks());

describe('requester Account currentness over the installed socket wiring', () => {
    it('publishes Environment access changes from the demanded Account feed without receipt or unrelated churn', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        let changes: ChangeEntry[] = [];
        let feedReads = 0;
        let feedStatus = 200;
        let cursor = 0;
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (url.endsWith('/currentness')) return { status: 200, data: fact };
            if (new URL(url).pathname !== '/v2/changes') throw new Error(`Unexpected GET ${url}`);
            feedReads++;
            const after = Number(new URL(url).searchParams.get('after') ?? 0);
            return feedStatus === 410 ? { status: 410, data: { error: 'cursor-gone', currentCursor: cursor } }
                : { status: 200, data: { changes: changes.filter(change => change.cursor > after), nextCursor: cursor } };
        });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'environment-demand',
            serverBaseUrl: 'https://environment-demand.example' });
        const publications: RequesterEnvironmentAccessObservation[] = [];
        let release: (() => void) | undefined;
        try {
            await observation.read();
            await channel.hintAccountChange(0);
            expect(feedReads).toBe(0);
            release = observation.subscribeEnvironmentAccess(event => { publications.push(event); });
            await vi.waitFor(() => expect(feedReads).toBe(1));
            await channel.pushProfile('bob');
            publications.length = 0;
            // One durable read classifies a real burst. Neither native receipt progress,
            // Session traffic nor a settings/Machine-only change can grant or revoke access.
            changes = Array.from({ length: 30 }, (_, index): ChangeEntry => ({ cursor: index + 1,
                changedAt: 1, ...(index % 3 === 0 ? { kind: 'session', entityId: `session-${index}` }
                    : index % 3 === 1 ? { kind: 'machine', entityId: `machine-${index}` }
                    : { kind: 'account', entityId: 'self', hint: { settingsVersion: index + 1 } }) }));
            changes.push({ ...buildDeploymentAccountChangeV1({ environmentId: 'environment-a',
                deploymentId: 'receipt-a', revision: 1 }), cursor: 31, changedAt: 1 });
            cursor = 31;
            await channel.hintAccountChange(cursor);
            await vi.waitFor(() => expect(feedReads).toBe(2));
            await channel.pushProfile('bob');
            expect(publications).toEqual([]);
            const profile = UpdateContainerSchema.parse({ id: 'unchanged-profile', seq: cursor, createdAt: 2,
                body: { t: 'update-account', id: 'bob', linkedProviders: [LinkedProviderSchema.parse({
                    id: 'github', login: 'bob', displayName: 'Bob', avatarUrl: null, profileUrl: null, showOnProfile: true,
                })] } });
            for (let refresh = 0; refresh < 2; refresh++) {
                await Promise.all([...channel.server.sockets.sockets.values()].map(socket => new Promise<void>(resolve => {
                    socket.emit('update', profile);
                    socket.emit('fx56-delivered', resolve);
                })));
            }
            expect(publications).toEqual([]);
            expect(feedReads).toBe(2);
            changes = ['environment-a', 'environment-b', 'environment-a'].map((environmentId, index) => ({
                ...buildDeploymentAccountChangeV1({ projectSourceId: 'source-a', environmentId, revision: index + 1 }),
                cursor: 32 + index, changedAt: 2,
            }));
            cursor = 34;
            await channel.hintAccountChange(cursor);
            await vi.waitFor(() => expect(publications).toEqual([{ kind: 'changes', environmentIds: ['environment-a', 'environment-b'] }]));
            for (const change of [
                { kind: 'account' as const, entityId: PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 },
                { kind: 'account' as const, entityId: 'teams' },
                { kind: 'account' as const, entityId: 'home-governance' },
                buildAccountIdentitiesChangeV1(),
                { kind: 'account' as const, entityId: buildAccountIdentitiesChangeV1().entityId },
                { kind: 'account' as const, entityId: 'self', hint: { linkedProviders: true } },
            ]) {
                changes = [{ ...change, cursor: ++cursor, changedAt: cursor }];
                await channel.hintAccountChange(cursor);
                await vi.waitFor(() => expect(publications.at(-1)).toEqual({ kind: 'reset' }));
                publications.length = 0;
            }
            feedStatus = 410;
            cursor++;
            await channel.hintAccountChange(cursor);
            await vi.waitFor(() => expect(publications).toEqual([{ kind: 'reset' }]));
            feedStatus = 200;
            changes = [];
            publications.length = 0;
            await channel.disconnect();
            expect(publications).toEqual([{ kind: 'retired' }]);
            await channel.reconnect();
            await vi.waitFor(() => expect(publications).toContainEqual({ kind: 'reset' }));
            release();
            release = undefined;
            await channel.pushProfile('bob');
            const settledReads = feedReads;
            await channel.hintAccountChange(++cursor);
            expect(feedReads).toBe(settledReads);
        } finally { release?.(); await observation.dispose(); await channel.close(); }
    });

    it('delivers Environment access changes to demand joining an existing held Account catch-up', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        let entered!: () => void;
        let releasePage!: () => void;
        const reading = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { releasePage = resolve; });
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (url.endsWith('/currentness')) return { status: 200, data: fact };
            if (new URL(url).pathname !== '/v2/changes') throw new Error(`Unexpected GET ${url}`);
            entered();
            await held;
            return { status: 200, data: { changes: [{
                ...buildDeploymentAccountChangeV1({ environmentId: 'changed-after-subscribe', revision: 2 }),
                cursor: 1, changedAt: 2,
            }], nextCursor: 1 } };
        });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'environment-joining',
            serverBaseUrl: 'https://environment-joining.example' });
        const publications: RequesterEnvironmentAccessObservation[] = [];
        let releaseFollow: (() => void) | undefined;
        let releaseAccess: (() => void) | undefined;
        try {
            await observation.read();
            releaseFollow = observation.subscribeSessionFollowRules(() => {});
            await reading;
            releaseAccess = observation.subscribeEnvironmentAccess(event => { publications.push(event); });
            expect(publications).toEqual([{ kind: 'reset' }]);
            releasePage();
            await vi.waitFor(() => expect(publications).toEqual([{ kind: 'reset' },
                { kind: 'changes', environmentIds: ['changed-after-subscribe'] }]));
        } finally { releasePage(); releaseAccess?.(); releaseFollow?.(); await observation.dispose(); await channel.close(); }
    });

    it.each(['currentness', 'feed unavailable', 'authentication failure', 'credential rotation', 'disposal'] as const)(
        'retires Environment access subscribers on %s through the existing pooled lifetime', async reason => {
            const channel = await createRequesterCurrentnessSocketHarness();
            const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null };
            let unavailable = false;
            let feedReads = 0;
            vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
                if (url.endsWith('/currentness')) return { status: 200, data: fact };
                if (new URL(url).pathname !== '/v2/changes') throw new Error(`Unexpected GET ${url}`);
                feedReads++;
                return unavailable ? { status: reason === 'authentication failure' ? 401 : 503, data: {} }
                    : { status: 200, data: { changes: [], nextCursor: 0 } };
            });
            const scope = { accountId: 'bob', serverBaseUrl: `https://environment-${reason.replaceAll(' ', '-')}.example` };
            const original = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'environment-original' });
            const remaining = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'environment-remaining' });
            const publications: RequesterEnvironmentAccessObservation[] = [];
            const retiring = reason === 'credential rotation' ? remaining : original;
            let release: (() => void) | undefined;
            try {
                await original.read();
                release = retiring.subscribeEnvironmentAccess(event => { publications.push(event); });
                await vi.waitFor(() => expect(feedReads).toBe(1));
                await channel.pushProfile('bob');
                publications.length = 0;
                if (reason === 'currentness') await channel.push('bob', { ...fact, mode: 'e2ee', version: 2,
                    updatedAt: 2, contentKeyFingerprint: 'changed-content-key' });
                else if (reason === 'feed unavailable' || reason === 'authentication failure') { unavailable = true; await channel.hintAccountChange(1); }
                else await original.dispose();
                await vi.waitFor(() => expect(publications).toContainEqual({ kind: 'retired' }));
                if (reason === 'disposal') {
                    // Credential handover settles its new channel before sending an acknowledged wake.
                    await remaining.read();
                    const readsAtDisposal = feedReads;
                    await channel.hintAccountChange(2);
                    expect(feedReads).toBe(readsAtDisposal);
                }
            } finally { release?.(); await original.dispose(); await remaining.dispose(); await channel.close(); }
        });

    it('keeps Environment access invalidations inside their authenticated Account and Home', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        let cursor = 0;
        vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
            if (url.endsWith('/currentness')) return { status: 200, data: fact };
            if (new URL(url).pathname !== '/v2/changes') throw new Error(`Unexpected GET ${url}`);
            const own = new URL(url).origin === 'https://environment-own.example'
                && config?.headers?.Authorization === 'Bearer environment-bob';
            return { status: 200, data: { changes: own && cursor > 0 ? [{
                ...buildDeploymentAccountChangeV1({ environmentId: 'own-environment', revision: 1 }),
                cursor, changedAt: 1,
            }] : [], nextCursor: cursor } };
        });
        const observations = [
            acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'environment-bob', serverBaseUrl: 'https://environment-own.example' }),
            acquireRequesterAccountEncryptionCurrentness({ accountId: 'alice', token: 'environment-alice', serverBaseUrl: 'https://environment-own.example' }),
            acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'environment-bob', serverBaseUrl: 'https://environment-other.example' }),
        ];
        const publications: RequesterEnvironmentAccessObservation[][] = observations.map(() => []);
        const releases: (() => void)[] = [];
        try {
            await Promise.all(observations.map(observation => observation.read()));
            observations.forEach((observation, index) => releases.push(observation.subscribeEnvironmentAccess(event => { publications[index]!.push(event); })));
            await channel.pushProfile('bob');
            publications.forEach(events => { events.length = 0; });
            cursor = 1;
            await channel.hintAccountChange(cursor);
            await vi.waitFor(() => expect(publications[0]).toEqual([{ kind: 'changes', environmentIds: ['own-environment'] }]));
            await channel.pushProfile('bob');
            expect(publications.slice(1)).toEqual([[], []]);
            await channel.push('alice', { ...fact, mode: 'e2ee', version: 2, updatedAt: 2 });
            expect(publications[0]).toHaveLength(1);
            expect(publications[2]).toEqual([]);
        } finally { releases.forEach(release => release()); await Promise.all(observations.map(observation => observation.dispose())); await channel.close(); }
    });

    it.each([
        ['requester', 'mode'], ['requester', 'content key'], ['requester', 'disconnect'],
        ['installed', 'mode'], ['installed', 'content key'], ['installed', 'disconnect'],
    ] as const)('withdraws warm Follow configuration and progress for %s custody when %s changes', async (custody, change) => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
        const secret = new Uint8Array(32).fill(8);
        const nextSecret = new Uint8Array(32).fill(9);
        const mode = change === 'content key' ? 'e2ee' : 'plain';
        const fingerprint = (key: Uint8Array) => computeAccountEncryptionMigrateKeyFingerprintV1(
            nacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(key)).publicKey);
        const fact = { mode, version: 1, updatedAt: 1,
            signingKeyFingerprint: mode === 'e2ee' ? computeAccountEncryptionMigrateKeyFingerprintV1(nacl.sign.keyPair.fromSeed(secret).publicKey) : null,
            contentKeyFingerprint: mode === 'e2ee' ? fingerprint(secret) : null };
        const receiver = { kind: 'session' as const, sessionId: 'receiver' };
        const rule = { ruleId: 'retained-rule', version: 1, receiver,
            content: sealSessionFollowRuleContentV1({ ruleId: 'retained-rule', receiver, mode,
                material: mode === 'e2ee' ? { type: 'legacy', secret } : null,
                definition: { v: 1, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: ['home'] }), policy: { preset: 'quiet' } } }) };
        const configurationReads: string[] = [];
        let currentnessReads = 0;
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (url.endsWith('/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/settings')) return { status: 200, data: mode === 'e2ee' ? { content: null, version: 0 }
                : { content: { t: 'plain', v: {} }, version: 1 } };
            if (url.endsWith('/currentness')) { currentnessReads++; return { status: 200, data: fact }; }
            if (new URL(url).pathname === '/v2/changes') return { status: 200, data: { changes: [], nextCursor: 0 } };
            if (url.endsWith('/session-follow-rules')) {
                configurationReads.push('rules'); return { status: 200, data: { rules: [rule] } };
            }
            if (url.endsWith('/session-follow-preferences')) {
                configurationReads.push('preferences'); return { status: 200,
                    data: { assigned: false, direct: false, team: false, group: false } };
            }
            throw new Error(`Unexpected Follow request ${url}`);
        });
        const prepared = custody === 'requester' ? await prepareRequesterSessionBootstrap({ credentials: { token,
            encryption: mode === 'e2ee' ? { type: 'legacy', secret } : null },
            attribution: { serverId: 'home', accountId: 'bob', machineId: 'machine', installationId: 'installation' },
            boundary: { serverId: 'home', serverHttpBaseUrl: 'https://follow-custody.example', happyHomeDir: '/unused-before-session-binding' },
            verifyMachineAdmissionCurrent: async () => true }) : null;
        if (custody === 'requester' && !prepared) throw new Error('Missing real requester custody');
        const lifetime = new AbortController();
        const bootstrap = prepared?.admitted;
        const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: bootstrap?.credentials ?? { token,
            encryption: mode === 'e2ee' ? { type: 'legacy', secret } : null },
            serverHttpBaseUrl: bootstrap?.serverHttpBaseUrl ?? 'https://follow-custody.example', signal: lifetime.signal,
            // Installed custody proves local credential identity, not Account mode/key identity.
            isCurrent: bootstrap ? () => bootstrap.savedSecretOperationContext.isCurrent() : async () => true,
            subscribeInvalidation: bootstrap?.subscribeSessionFollowRules ?? (() => () => {}),
            subscribeSourceInvalidation: bootstrap?.subscribeSessionFollowSources });
        try {
            expect(await cache.read()).toMatchObject({ status: 'available', rules: [{ ruleId: rule.ruleId }] });
            configurationReads.length = 0;
            const warmCurrentnessReads = currentnessReads;
            for (let arrival = 0; arrival < 20; arrival++) expect(await cache.read()).toMatchObject({ status: 'available' });
            expect(configurationReads).toEqual([]);
            if (custody === 'installed') expect(currentnessReads).toBe(warmCurrentnessReads);
            if (change === 'disconnect') await channel.disconnect();
            else await channel.push('bob', { ...fact, mode: 'e2ee', version: 2, updatedAt: change === 'content key' ? fact.updatedAt : 2,
                signingKeyFingerprint: fact.signingKeyFingerprint ?? computeAccountEncryptionMigrateKeyFingerprintV1(nacl.sign.keyPair.fromSeed(secret).publicKey),
                contentKeyFingerprint: fingerprint(nextSecret) });
            expect(await cache.read()).toMatchObject({ status: 'unavailable', reason: 'account-retired' });
            const progress = cache.readReceiverSourceRanges({ destinationSessionId: receiver.sessionId });
            if (change === 'disconnect') await expect(progress).rejects.toBeInstanceOf(AccountEncryptionCurrentnessUnavailableError);
            else expect(await progress).toMatchObject({ status: 'unavailable', reason: 'account-retired' });
            expect(await cache.hasEnabledSessionReceiver(receiver.sessionId)).toBe(false);
            expect(configurationReads).toEqual([]);
            if (custody === 'installed' && change === 'disconnect') {
                const beforeReconnect = currentnessReads;
                await channel.reconnect();
                const recovered = await Promise.all([cache.read(), cache.read()]);
                expect(recovered.every(result => result.status === 'available')).toBe(true);
                expect(currentnessReads - beforeReconnect).toBe(1);
                expect(configurationReads).toEqual([]);
            }
        } finally { lifetime.abort(); cache.dispose(); await prepared?.cleanupOnFailure(); await channel.close(); }
    });
    it('reloads receiver rules and preferences changed elsewhere through the real Account feed before the next arrival', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        let rules: SessionFollowRuleV1[] = [];
        let preferences = { assigned: false, direct: false, team: false, group: false };
        let cursor = 0;
        let invalidations = 0;
        let receiverHints = 0;
        let changeEntityId = 'session-follows';
        const reads: string[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
            const path = new URL(url).pathname;
            reads.push(path);
            if (path.endsWith('/currentness')) return { status: 200, data: fact };
            if (path.endsWith('/session-follow-rules')) return { status: 200, data: { rules,
                ...(config?.params ? { sourceRanges: { status: 'available', sources: [] } } : {}) } };
            if (path.endsWith('/session-follow-preferences')) return { status: 200, data: preferences };
            if (path === '/v2/changes') {
                const after = Number(new URL(url).searchParams.get('after') ?? 0);
                return { status: 200, data: { changes: cursor > after ? [{ cursor, kind: 'account',
                    entityId: changeEntityId, changedAt: cursor,
                    ...(changeEntityId === 'session-follows' ? { hint: buildSessionFollowChangeHintV1() } : {}) }] : [], nextCursor: cursor } };
            }
            throw new Error(`Unexpected Follow request ${path}`);
        });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token,
            serverBaseUrl: 'https://receiver-feed.example' });
        const lifetime = new AbortController();
        const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
            serverHttpBaseUrl: 'https://receiver-feed.example', signal: lifetime.signal,
            isCurrent: async () => (await observation.read())?.mode === 'plain',
            subscribeInvalidation: listener => observation.subscribeSessionFollowRules(change => { invalidations++; listener(change); }),
            subscribeSourceInvalidation: listener => observation.subscribeSessionFollowSources((source, receiver) => {
                if (receiver) receiverHints++;
                listener(source, receiver);
            }) });
        try {
            await observation.read();
            await vi.waitFor(() => expect(reads).toContain('/v2/changes'));
            expect(await cache.read()).toMatchObject({ status: 'available', rules: [], defaultPreferences: preferences });
            const beforeChange = invalidations;
            preferences = { ...preferences, assigned: true };
            rules = [{ ruleId: 'new-receiver-rule', version: 1, receiver: { kind: 'session', sessionId: 'receiver' },
                content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1({}),
                    policy: { preset: 'everything' } } } }];
            cursor++;
            await channel.hintAccountChange(cursor);
            await vi.waitFor(() => expect(invalidations).toBeGreaterThan(beforeChange));
            expect(await cache.read()).toMatchObject({ status: 'available',
                rules: [{ ruleId: 'new-receiver-rule', definition: { enabled: true } }], defaultPreferences: preferences });
            const beforeWarmRange = reads.filter(path => path.endsWith('/session-follow-rules')).length;
            await Promise.all([cache.readReceiverSourceRanges({ destinationSessionId: 'receiver' }),
                cache.readReceiverSourceRanges({ destinationSessionId: 'receiver' })]);
            expect(reads.filter(path => path.endsWith('/session-follow-rules'))).toHaveLength(beforeWarmRange + 1);
            rules = rules.map(rule => ({ ...rule, sources: [{ sourceSessionId: 'source', delivered: {
                transcriptSeq: 6, readyEventSeq: 0, agentStateVersion: 3, turn: null } }] }));
            const beforeOtherReceiver = receiverHints;
            changeEntityId = buildSessionFollowReceiverChangeEntityIdV1('another-receiver');
            cursor++;
            await channel.hintAccountChange(cursor);
            await vi.waitFor(() => expect(receiverHints).toBeGreaterThan(beforeOtherReceiver));
            await cache.readReceiverSourceRanges({ destinationSessionId: 'receiver' });
            expect(reads.filter(path => path.endsWith('/session-follow-rules'))).toHaveLength(beforeWarmRange + 1);
            const beforeProgress = receiverHints;
            const beforeProgressPreferences = reads.filter(path => path.endsWith('/session-follow-preferences')).length;
            changeEntityId = buildSessionFollowReceiverChangeEntityIdV1('receiver');
            cursor++;
            await channel.hintAccountChange(cursor);
            await vi.waitFor(() => expect(receiverHints).toBeGreaterThan(beforeProgress));
            const progressed = await Promise.all([cache.readReceiverSourceRanges({ destinationSessionId: 'receiver' }),
                cache.readReceiverSourceRanges({ destinationSessionId: 'receiver' })]);
            for (const progress of progressed) expect(progress).toMatchObject({ status: 'available', value: {
                rules: [{ sources: [{ delivered: { transcriptSeq: 6, agentStateVersion: 3 } }] }] } });
            expect(reads.filter(path => path.endsWith('/session-follow-rules'))).toHaveLength(beforeWarmRange + 2);
            expect(await cache.read()).toMatchObject({ status: 'available' });
            expect(reads.filter(path => path.endsWith('/session-follow-preferences'))).toHaveLength(beforeProgressPreferences);
            // Observe the accepted progress once, then warm six exact scopes.
            // A genuine Account-rule edit through this real socket/feed must
            // not reset their unchanged Session discovery.
            expect(await cache.read({ refresh: true })).toMatchObject({ status: 'available' });
            const readScopes = async () => {
                for (let index = 0; index < 6; index++) expect(await cache.readReceiverSourceRanges({
                    destinationSessionId: 'receiver', sourceSessionId: `warm-source-${index}`,
                })).toMatchObject({ status: 'available' });
            };
            await readScopes();
            const sessionRules = rules;
            for (const create of [true, false]) {
                const beforeRules = reads.filter(path => path.endsWith('/session-follow-rules')).length;
                const beforeHint = invalidations;
                rules = [...sessionRules, ...(create ? [{ ...sessionRules[0]!, ruleId: 'account-rule', receiver: { kind: 'account' as const } }] : [])];
                changeEntityId = 'session-follows';
                cursor++;
                await channel.hintAccountChange(cursor);
                await vi.waitFor(() => expect(invalidations).toBeGreaterThan(beforeHint));
                expect(await cache.read()).toMatchObject({ status: 'available' });
                await readScopes();
                expect(reads.filter(path => path.endsWith('/session-follow-rules')),
                    `requester Account rule ${create ? 'create' : 'delete'} keeps six warm scopes`).toHaveLength(beforeRules + 1);
            }
            const beforeReconnect = reads.filter(path => path.endsWith('/session-follow-rules')).length;
            const beforeReconnectHint = invalidations;
            await channel.disconnect();
            await channel.reconnect();
            await vi.waitFor(() => expect(invalidations).toBeGreaterThan(beforeReconnectHint));
            expect(await cache.read()).toMatchObject({ status: 'available' });
            await readScopes();
            expect(reads.filter(path => path.endsWith('/session-follow-rules')),
                'reconnect must rebuild discovery, including previously unseen sources').toHaveLength(beforeReconnect + 7);
            const beforeRemoval = invalidations;
            const beforeRemovalRules = reads.filter(path => path.endsWith('/session-follow-rules')).length;
            changeEntityId = 'session-follows';
            rules = [];
            preferences = { ...preferences, assigned: false };
            cursor++;
            await channel.hintAccountChange(cursor);
            await vi.waitFor(() => expect(invalidations).toBeGreaterThan(beforeRemoval));
            expect(await cache.read()).toMatchObject({ status: 'available',
                rules: [], defaultPreferences: preferences });
            expect(reads.filter(path => path.endsWith('/session-follow-rules'))).toHaveLength(beforeRemovalRules + 1);
            const ruleReads = reads.filter(path => path.endsWith('/session-follow-rules')).length;
            expect(await cache.read()).toMatchObject({ status: 'available', rules: [] });
            expect(reads.filter(path => path.endsWith('/session-follow-rules'))).toHaveLength(ruleReads);
            lifetime.abort();
            expect(await cache.read()).toMatchObject({ status: 'unavailable' });
        } finally { lifetime.abort(); cache.dispose(); await observation.dispose(); await channel.close(); }
    });
    it('keeps projection-only Session notifications out of requester Follow discovery while retaining unseen source changes', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const cursors: number[] = [];
        let change: ChangeEntry | undefined;
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (url.endsWith('/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            const request = new URL(url);
            if (request.pathname !== '/v2/changes') throw new Error(`Unexpected GET ${request.pathname}`);
            const after = Number(request.searchParams.get('after'));
            cursors.push(after);
            return { status: 200, data: { changes: change && change.cursor > after ? [change] : [], nextCursor: change?.cursor ?? after } };
        });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'bob-projection',
            serverBaseUrl: 'https://projection-home.example' });
        const sources: (string | null)[] = [];
        let release = () => {};
        try {
            await observation.read();
            const availability: (boolean | undefined)[] = [];
            const sourceChanges: (false | undefined)[] = [];
            release = observation.subscribeSessionFollowSources((source, _receiver, changed, sourceChanged) => {
                sources.push(source); availability.push(changed); sourceChanges.push(sourceChanged);
            });
            await vi.waitFor(() => expect(cursors).toHaveLength(1));
            change = { cursor: 1, kind: 'session', entityId: 'source', changedAt: 1, hint: { lastMessageSeq: 1 } };
            await channel.hintAccountChange(1);
            await vi.waitFor(() => expect(sources).toEqual([null, 'source']));
            change = { ...change, cursor: 2, hint: { metadataVersion: 1, followSourceChanged: false,
                followSourceUnchangedSinceCursor: 1, followReceiverAvailabilityChanged: false } };
            await channel.hintAccountChange(2);
            await vi.waitFor(() => expect(cursors).toHaveLength(3));
            await channel.pushProfile('bob');
            expect(sources).toEqual([null, 'source']);
            change = { ...change, cursor: 4, hint: { metadataVersion: 2, followSourceChanged: false, followSourceUnchangedSinceCursor: 3 } };
            await channel.hintAccountChange(4);
            await vi.waitFor(() => expect(sources).toEqual([null, 'source', 'source']));
            expect(cursors).toEqual([0, 0, 1, 2]);
            change = { ...change, cursor: 6, hint: { metadataVersion: 3, followSourceChanged: false,
                followSourceUnchangedSinceCursor: 3, followReceiverAvailabilityChanged: true,
                followReceiverAvailabilityChangedAtCursor: 5 } };
            await channel.hintAccountChange(6);
            await vi.waitFor(() => expect(sources).toEqual([null, 'source', 'source', 'source']));
            expect(availability.at(-1)).toBe(true);
            change = { ...change, cursor: 7, hint: { ...change.hint as Record<string, unknown>, metadataVersion: 4 } };
            await channel.hintAccountChange(7);
            await vi.waitFor(() => expect(cursors).toHaveLength(6));
            await channel.pushProfile('bob');
            expect(sources).toEqual([null, 'source', 'source', 'source']);
            change = { ...change, cursor: 8, hint: { lastMessageSeq: 2, followReceiverAvailabilityChanged: false } };
            await channel.hintAccountChange(8);
            await vi.waitFor(() => expect(sources).toHaveLength(5));
            expect(availability.at(-1)).toBe(false);
            change = { ...change, cursor: 9, entityId: 'receiver', hint: { metadataVersion: 5,
                followSourceChanged: false, followSourceUnchangedSinceCursor: 8 } };
            await channel.hintAccountChange(9);
            await vi.waitFor(() => expect(sources).toHaveLength(6));
            expect(sources.at(-1)).toBe('receiver');
            expect(availability.at(-1)).toBeUndefined();
            expect(sourceChanges.at(-1)).toBe(false);
        } finally { release(); await observation.dispose(); await channel.close(); }
    });

    it('shares an already-demanded changes feed across new subscribers and catches up after demand resumes', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        const cursors: number[] = [];
        let cursor = 0;
        let receiverChanged = false;
        vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
            if (url.endsWith('/currentness')) return { status: 200, data: fact };
            if (new URL(url).pathname !== '/v2/changes') throw new Error(`Unexpected GET ${url}`);
            const after = Number(new URL(url).searchParams.get('after') ?? 0);
            cursors.push(after);
            const changes: ChangeEntry[] = cursor > after
                ? [receiverChanged ? { cursor, kind: 'account', entityId: buildSessionFollowReceiverChangeEntityIdV1('receiver'), changedAt: 1 }
                    : { cursor, kind: 'session', entityId: 'follow-source', changedAt: 1 }] : [];
            return { status: 200, data: { changes, nextCursor: cursor } };
        });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'bob-demand',
            serverBaseUrl: 'https://demand-home.example' });
        const releases: (() => void)[] = [];
        try {
            await observation.read();
            releases.push(observation.subscribeSessionFollowRules(() => {}));
            await vi.waitFor(() => expect(cursors).toEqual([0]));
            releases.push(observation.subscribeConnectedAccounts(() => {}));
            const sources: (string | null)[] = [];
            const receivers: string[] = [];
            const receive = (source: string | null, receiver?: true) => {
                sources.push(source);
                if (receiver && source) receivers.push(source);
            };
            releases.push(observation.subscribeSessionFollowSources(receive));
            // Drain the real channel: subscribing and unrelated profile updates are not feed events.
            await channel.pushProfile('bob');
            expect(cursors).toEqual([0]);
            cursor = 1;
            await channel.hintAccountChange();
            await vi.waitFor(() => expect(sources).toEqual([null, 'follow-source']));
            expect(cursors).toEqual([0, 0]);
            releases.splice(0).forEach(release => release());
            cursor = 2;
            await channel.hintAccountChange();
            expect(cursors).toEqual([0, 0]);
            releases.push(observation.subscribeSessionFollowSources(receive));
            await vi.waitFor(() => expect(sources).toEqual([null, 'follow-source', null, 'follow-source']));
            expect(cursors).toEqual([0, 0, 1]);
            receiverChanged = true;
            cursor = 3;
            await channel.hintAccountChange(cursor);
            await vi.waitFor(() => expect(receivers).toEqual(['receiver']));
            expect(sources.at(-1)).toBe('receiver');
        } finally { releases.forEach(release => release()); await observation.dispose(); await channel.close(); }
    });

    it('consumes acknowledged requester wake ranges once across an in-flight burst and revalidates after reconnect', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        const cursors: number[] = [];
        let cursor = 10;
        let hold = false;
        let entered!: () => void;
        let finish!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { finish = resolve; });
        vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
            if (url.endsWith('/currentness')) return { status: 200, data: fact };
            if (new URL(url).pathname !== '/v2/changes') throw new Error(`Unexpected GET ${url}`);
            const after = Number(new URL(url).searchParams.get('after') ?? 0);
            cursors.push(after);
            if (hold) { entered(); await held; }
            return { status: 200, data: { changes: cursor > after ? [{ cursor, kind: 'session',
                entityId: `source-${cursor}`, changedAt: cursor }] : [], nextCursor: cursor } };
        });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'bob-range',
            serverBaseUrl: 'https://requester-range.example' });
        const sources: (string | null)[] = [];
        let release: (() => void) | undefined;
        try {
            await observation.read();
            release = observation.subscribeSessionFollowSources(source => { sources.push(source); });
            await vi.waitFor(() => expect(sources).toContain('source-10'));
            hold = true;
            cursor = 11;
            await channel.hintAccountChange(cursor);
            await waiting;
            // The real feed response covers the entire burst before its first request settles.
            for (cursor = 12; cursor <= 51; cursor++) await channel.hintAccountChange(cursor);
            cursor = 51;
            hold = false;
            finish();
            await vi.waitFor(() => expect(sources).toContain('source-51'));
            await channel.pushProfile('bob');
            expect(cursors).toEqual([0, 10]);
            for (let duplicate = 0; duplicate < 40; duplicate++) await channel.hintAccountChange(51);
            expect(cursors).toEqual([0, 10]);
            cursor = 52;
            await channel.hintAccountChange(cursor);
            await vi.waitFor(() => expect(sources).toContain('source-52'));
            expect(cursors).toEqual([0, 10, 51]);
            await channel.disconnect();
            await channel.reconnect();
            await observation.read();
            await vi.waitFor(() => expect(cursors).toEqual([0, 10, 51, 52]));
            // A lower cursor can describe a restored Home; it is never equality-suppressed.
            await channel.hintAccountChange(3);
            await vi.waitFor(() => expect(cursors).toEqual([0, 10, 51, 52, 52]));
        } finally { finish(); release?.(); await observation.dispose(); await channel.close(); }
    });

    it.each(['error', 'cursor-gone'] as const)('does not acknowledge a requester wake after %s or a changed encryption lifetime', async failure => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        const cursors: number[] = [];
        let failing = false;
        vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
            if (url.endsWith('/currentness')) return { status: 200, data: fact };
            if (new URL(url).pathname !== '/v2/changes') throw new Error(`Unexpected GET ${url}`);
            cursors.push(Number(new URL(url).searchParams.get('after') ?? 0));
            if (failing) return failure === 'error' ? { status: 500, data: {} }
                : { status: 410, data: { error: 'cursor-gone', currentCursor: 8 } };
            return { status: 200, data: { changes: [], nextCursor: 8 } };
        });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: `bob-${failure}`,
            serverBaseUrl: `https://requester-${failure}.example` });
        const sources: (string | null)[] = [];
        let release: (() => void) | undefined;
        try {
            await observation.read();
            release = observation.subscribeSessionFollowSources(source => { sources.push(source); });
            await vi.waitFor(() => expect(cursors).toEqual([0]));
            await channel.pushProfile('bob');
            failing = true;
            await channel.hintAccountChange(9);
            await vi.waitFor(() => expect(sources).toHaveLength(2));
            failing = false;
            await channel.hintAccountChange(8);
            await vi.waitFor(() => expect(cursors).toEqual([0, 8, 8]));
            await channel.pushProfile('bob');
            await channel.push('bob', { ...fact, version: 2, updatedAt: 2 });
            await channel.hintAccountChange(8);
            await vi.waitFor(() => expect(cursors).toEqual([0, 8, 8, 8]));
            await expect(observation.read()).resolves.toMatchObject({ updatedAt: 2 });
        } finally { release?.(); await observation.dispose(); await channel.close(); }
    });

    it('routes service changes through the requester feed without waking on later settings writes', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        const services = [{ pluginId: 'happier.service.openai', localId: 'api-key' },
            { pluginId: 'happier.service.anthropic', localId: 'oauth' }];
        let changes: ChangeEntry[] = [];
        let observedCursor = 0;
        let serviceChangeReads = 0;
        vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
            if (url.endsWith('/currentness')) return { status: 200, data: fact };
            if (new URL(url).pathname !== '/v2/changes') throw new Error(`Unexpected GET ${url}`);
            observedCursor = Number(new URL(url).searchParams.get('after') ?? 0);
            serviceChangeReads++;
            return { status: 200, data: { changes: changes.filter(change => change.cursor > observedCursor),
                nextCursor: changes.at(-1)?.cursor ?? observedCursor } };
        });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'bob-services',
            serverBaseUrl: 'https://service-feed.example' });
        const publications: unknown[] = [];
        let release: (() => void) | undefined;
        try {
            await observation.read();
            release = observation.subscribeConnectedAccounts(event => { publications.push(event); });
            await channel.pushProfile('bob');
            changes = services.map((service, index) => ({ ...buildConnectedServicesAccountChangeV1(service), cursor: index + 1, changedAt: 1 }));
            await channel.hintAccountChange(2);
            await vi.waitFor(() => expect(publications).toEqual([{ services }]));
            changes = [{ ...buildConnectedServicesAccountChangeV1(services[0]!), cursor: 3, changedAt: 1 }];
            await channel.hintAccountChange(3);
            await vi.waitFor(() => expect(publications).toEqual([{ services }, { services: [services[0]] }]));
            changes = [{ kind: 'account', entityId: 'self', hint: { settingsVersion: 2 }, cursor: 4, changedAt: 1 }];
            await channel.hintAccountChange(4);
            await channel.pushProfile('bob');
            expect(publications).toHaveLength(2);
            changes = [{ ...buildConnectedServicesAccountChangeV1(), cursor: 5, changedAt: 1 }];
            await channel.hintAccountChange(5);
            await vi.waitFor(() => expect(publications).toEqual([{ services }, { services: [services[0]] }, {}]));
            changes = [{ kind: 'account', entityId: 'self', hint: { connectedServices: true }, cursor: 6, changedAt: 1 }];
            await channel.hintAccountChange(6);
            await vi.waitFor(() => expect(publications).toHaveLength(4));
            expect(publications[3]).toEqual({});
            const settledReads = serviceChangeReads;
            for (let version = 2; version <= 61; version++) {
                await channel.push('bob', { ...fact, version, settingsVersion: version });
                await channel.hintAccountChange(6);
            }
            expect(serviceChangeReads).toBe(settledReads);
            expect(publications).toHaveLength(4);
            await channel.push('bob', { ...fact, mode: 'e2ee', version: 62, updatedAt: 2,
                contentKeyFingerprint: 'changed-content-key' });
            await channel.hintAccountChange(6);
            await vi.waitFor(() => expect(serviceChangeReads).toBe(settledReads + 1));
            await expect(observation.read()).resolves.toMatchObject({ mode: 'e2ee' });
        } finally { release?.(); await observation.dispose(); await channel.close(); }
    });

    it.each([false, true])('delivers exact quota Refresh through the existing Account feed beyond unrelated full pages and retires demand (mixed=%s)', async mixed => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        const recordId = buildProviderAccountUsageRecordId({ providerId: 'quota-provider', accountSubjectId: 'bob',
            subjectKind: 'account', quotaScope: 'account' });
        let pending = false;
        const cursors: number[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
            if (url.endsWith('/currentness')) return { status: 200, data: fact };
            if (new URL(url).pathname !== '/v2/changes') throw new Error(`Unexpected GET ${url}`);
            const after = Number(new URL(url).searchParams.get('after') ?? 0);
            cursors.push(after);
            const changes: ChangeEntry[] = pending && after === 0
                ? Array.from({ length: 200 }, (_, index) => ({ cursor: index + 1, kind: 'machine',
                    entityId: `unrelated-${index}`, changedAt: 1 }))
                : pending && after === 200 ? [{ cursor: 201, changedAt: 1,
                    ...buildProviderAccountUsageRefreshChangeV1(recordId) },
                    ...(mixed ? [{ cursor: 202, changedAt: 1, kind: 'account' as const, entityId: 'self',
                        hint: { connectedServices: true } }] : [])] : [];
            return { status: 200, data: { changes, nextCursor: changes.at(-1)?.cursor ?? after } };
        });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'bob-quota',
            serverBaseUrl: 'https://quota-home.example' });
        const publications: unknown[] = [];
        let release: (() => void) | undefined;
        try {
            await observation.read();
            expect(observation.hasCurrentConnectedAccountChangesObserver()).toBe(false);
            release = observation.subscribeConnectedAccounts(event => { publications.push(event); });
            await vi.waitFor(() => expect(observation.hasCurrentConnectedAccountChangesObserver()).toBe(true));
            expect(cursors).toEqual([0]);
            pending = true;
            await channel.hintAccountChange();
            await vi.waitFor(() => expect(publications).toEqual([{ quotaRefreshRecordIds: [recordId],
                ...(mixed ? {} : { quotaRefreshOnly: true }) }]));
            expect(cursors).toContain(200);
            // A full page is progress, not a reset of every quota deadline.
            await channel.disconnect();
            expect(observation.hasCurrentConnectedAccountChangesObserver()).toBe(false);
            await channel.reconnect();
            await vi.waitFor(() => expect(observation.hasCurrentConnectedAccountChangesObserver()).toBe(true));
            expect(publications).toHaveLength(2);
            release();
            expect(observation.hasCurrentConnectedAccountChangesObserver()).toBe(false);
            const reads = cursors.length;
            await channel.hintAccountChange();
            expect(cursors).toHaveLength(reads);
            expect(publications).toHaveLength(2);
        } finally { release?.(); await observation.dispose(); await channel.close(); }
    });

    it.each([
        ['reviews.comments.claimPublicationDispatch', 'mode-change'],
        ['reviews.comments.create', 'mode-change'],
        ['reviews.comments.claimPublicationDispatch', 'revoked'],
        ['reviews.comments.create', 'after-signing'],
        ['reviews.comments.claimPublicationDispatch', 'after-final-principal'],
    ] as const)(
        'refuses %s publication sealing after %s while its warm socket identity stays unchanged', async (actionId, change) => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        let mode = change === 'mode-change' ? 'e2ee' as const : 'plain' as 'plain' | 'e2ee';
        let principalChecks = 0;
        const signed = change === 'after-signing' || change === 'after-final-principal';
        const signingKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => url.endsWith('/currentness')
            ? { status: 200, data: fact } : change === 'revoked'
                ? { status: 403, data: { error: 'not_authenticated' } }
                : { status: 200, data: { mode, updatedAt: 2 } });
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {} });
        const scope = { accountId: 'bob', token: 'bob', serverBaseUrl: 'https://home.example' };
        const observation = acquireRequesterAccountEncryptionCurrentness(scope);
        try {
            await observation.read();
            const executor = createCliReviewCommentActionExecutorFromCredentials({
                credentials: { token: scope.token, encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } },
                resolveAccountId: () => scope.accountId,
                resolvePrincipalSigningContext: async () => {
                    await Promise.resolve();
                    if (change === 'after-signing') mode = 'e2ee';
                    return { machineId: 'machine', installationId: 'installation',
                        privateKeyBase64Url: Buffer.from(signingKeys.secretKey).toString('base64url') };
                },
                assertPrincipalCurrent: async () => {
                    await Promise.resolve();
                    if (++principalChecks === 2 && change === 'after-final-principal') mode = 'e2ee';
                },
            });
            const failure = await runWithServerHttpBaseUrl(scope.serverBaseUrl, () => executor(actionId,
                actionId === 'reviews.comments.create' ? { projectId: 'project', anchor: { kind: 'file', filePath: 'PRIVATE-file' },
                    snapshot: { kind: 'none', capturedAt: 1 }, body: 'PRIVATE-body', clientMutationId: 'mutation' } : {
                target: { providerId: 'PRIVATE-provider', configuredAccountId: 'PRIVATE-account',
                    entryRef: { sourceId: 'PRIVATE-source', kindId: 'PRIVATE-kind', collisionScope: 'PRIVATE-scope', entryId: 'PRIVATE-entry' },
                    subtarget: null }, baseRevision: 'PRIVATE-base', headRevision: 'PRIVATE-head', entries: [], verdict: { kind: 'comment', body: 'PRIVATE-body' },
            }, signed ? { principal: { actor: { kind: 'agent', agentId: 'codex', sessionId: 'session' } } } : undefined))
                .then(() => null, error => error);
            expect(post).not.toHaveBeenCalled();
            expect(failure).toMatchObject({ code: change === 'revoked'
                ? 'review_comment_encryption_mode_unavailable' : 'review_comment_encryption_mode_mismatch' });
            expect(get.mock.calls.filter(([url]) => String(url).endsWith('/account/encryption'))).toHaveLength(1);
            expect(await observation.read()).toMatchObject({ mode: 'plain' });
        } finally { await observation.dispose(); await channel.close(); }
    });

    it('refuses a stale encrypted Review commit when Account mode changes during prepare before its socket push', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'e2ee' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: 'signing-key', contentKeyFingerprint: 'content-key' };
        let mode = fact.mode as 'plain' | 'e2ee';
        const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => ({ status: 200,
            data: url.endsWith('/currentness') ? fact : { mode, updatedAt: 2 } }));
        const input = { projectId: 'project', anchor: { kind: 'file' as const, filePath: 'PRIVATE-file' },
            snapshot: { kind: 'none' as const, capturedAt: 1 }, body: 'PRIVATE-body', clientMutationId: 'mutation' };
        const comment: ReviewCommentV1 = { v: 1, id: 'comment', accountId: 'bob', projectId: input.projectId,
            anchor: input.anchor, snapshot: input.snapshot, body: input.body, bodyVersion: 1, edits: [],
            author: { kind: 'user', userId: 'bob' }, state: 'open', flags: {}, dispositions: {}, threadId: 'comment',
            evidence: [], transitions: [], createdAt: 100, updatedAt: 100, serverRevision: 1 };
        const structural = splitReviewCommentV1(comment).structural;
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (!String(url).endsWith('/mutations/prepare')) return { status: 200, data: {} };
            const request = ReviewCommentPrepareMutationRequestV1Schema.parse(body);
            // The mutation prepared under E2EE, then the authoritative transition
            // committed. Its Account socket notification is deliberately held.
            mode = 'plain';
            return { status: 200, data: { v: 1, receipt: 'receipt', request, records: [{ structural,
                event: { eventId: 'event', commentId: structural.id, accountId: 'bob', projectId: input.projectId,
                    eventKind: 'created', actor: structural.author, createdAt: 100, serverRevision: 1,
                    event: { clientMutationId: input.clientMutationId } } }], replayed: false, failed: [] } };
        });
        const scope = { accountId: 'bob', token: 'bob', serverBaseUrl: 'https://home.example' };
        const observation = acquireRequesterAccountEncryptionCurrentness(scope);
        try {
            await observation.read();
            const executor = createCliReviewCommentActionExecutorFromCredentials({
                credentials: { token: scope.token, encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } },
                resolveAccountId: () => scope.accountId,
            });
            const failure = await runWithServerHttpBaseUrl(scope.serverBaseUrl, () => executor('reviews.comments.create', input))
                .then(() => null, error => error);
            expect(post.mock.calls.map(([url]) => String(url).split('/comments/')[1])).toEqual(['mutations/prepare']);
            expect(failure).toMatchObject({ code: 'review_comment_encryption_mode_mismatch' });
            expect(get.mock.calls.filter(([url]) => String(url).endsWith('/account/encryption'))).toHaveLength(1);
            expect(await observation.read()).toMatchObject({ mode: 'e2ee' });
        } finally { await observation.dispose(); await channel.close(); }
    });

    it('seals provider Usage under fresh Account mode before its held socket identity advances', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => ({ status: 200,
            data: url.endsWith('/currentness') ? fact : { mode: 'e2ee', updatedAt: 2 } }));
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { success: true, source: { status: 'linked' } } });
        const scope = { accountId: 'bob', token: 'bob', serverBaseUrl: 'https://home.example' };
        const observation = acquireRequesterAccountEncryptionCurrentness(scope);
        const encryption = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const recordKey = { providerId: 'codex', accountSubjectId: 'PRIVATE-subject', subjectKind: 'account' as const, quotaScope: 'account' as const };
        const snapshot: ProviderAccountUsageSnapshotV1 = { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
            providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'PRIVATE-subject' }, observedAtMs: 1_000,
            fetchedAtMs: 1_000, staleAfterMs: 300_000, source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data', meters: [] };
        const scheduler = createProviderAccountUsagePersistenceScheduler({
            api: new ConnectedServiceCredentialHttpClient({ token: scope.token }), credentials: { token: scope.token, encryption },
            now: () => 1_500, randomBytes: length => new Uint8Array(length).fill(6),
        });
        try {
            await observation.read();
            await runWithServerHttpBaseUrl(scope.serverBaseUrl, async () => {
                await scheduler.recordInBandSnapshot(snapshot, { targets: [{ source: { ref: {
                    service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' }, bindingKind: 'account' },
                    expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', expectedConfigurationRevision: 'cfg-current' }] });
                await scheduler.flush(1_000);
            });
            expect(post).toHaveBeenCalledTimes(1);
            const write = QualifiedProviderAccountUsageWriteV4Schema.parse(post.mock.calls[0]?.[1]);
            expect(write).toMatchObject({ payloadMode: 'sealed_account_scoped_v1' });
            if (write.payloadMode !== 'sealed_account_scoped_v1' || !write.sealedPayload) throw new Error('Expected sealed Usage');
            expect(openSealedProviderAccountUsageSnapshot({ material: encryption, sealed: write.sealedPayload })).toEqual(snapshot);
            expect(write).not.toHaveProperty('snapshot');
            expect(get.mock.calls.filter(([url]) => String(url).endsWith('/account/encryption'))).toHaveLength(1);
            expect(await observation.read()).toMatchObject({ mode: 'plain' });
        } finally { scheduler.dispose(); await observation.dispose(); await channel.close(); }
    });

    it('does not whole-parse unrelated feed traffic in the installed Account adapter', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: fact });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'bob',
            serverBaseUrl: 'https://home.example' });
        // Pass-through instrumentation: every admitted packet still uses the
        // real strict schema; only unnecessary whole-feed validation is counted.
        const validation = vi.spyOn(UpdateContainerSchema, 'safeParse');
        const flush = () => Promise.all([...channel.server.sockets.sockets.values()].map(socket =>
            new Promise<void>(resolve => socket.emit('fx56-delivered', resolve))));
        try {
            await observation.read();
            for (let index = 0; index < 100; index++) {
                for (const body of [
                    { t: 'update-account', id: 'foreign', encryptionCurrentness: fact },
                    { t: 'update-account', id: 'bob', name: 'Changed profile' },
                    { t: 'update-session', id: 'session' },
                ]) channel.server.emit('update', { id: 'feed', seq: index, createdAt: 2, body });
            }
            await flush();
            expect(observation.isCurrent(fact)).toBe(true);
            expect(validation).toHaveBeenCalledTimes(0);
            const encrypted = { ...fact, mode: 'e2ee' as const, version: 2, updatedAt: 2,
                contentKeyFingerprint: 'content-key' };
            await channel.push('bob', encrypted);
            expect(observation.isCurrent(encrypted)).toBe(true);
            expect(validation).toHaveBeenCalledTimes(1);
            await channel.pushInvalidCurrentness('bob');
            expect(observation.isCurrent(encrypted)).toBe(false);
            expect(validation).toHaveBeenCalledTimes(2);
        } finally { validation.mockRestore(); await observation.dispose(); await channel.close(); }
    });

    it('does not grant an unregistered credential the synchronous identity fence of another holder', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: fact });
        const scope = { accountId: 'bob', serverBaseUrl: 'https://home.example' };
        const observation = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'bob' });
        try {
            await observation.read();
            expect(isRequesterAccountEncryptionCurrentnessObserved({ ...scope, token: 'unregistered' }, fact)).toBe(false);
        } finally { await observation.dispose(); await channel.close(); }
    });

    it.each(['valid', 'revoked'] as const)('consumes a fresh HTTP credential independently of another Account holder (%s)', async credential => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        const reads = vi.spyOn(axios, 'get').mockImplementation(async (_url, config) => {
            if (credential === 'revoked' && config?.headers?.Authorization === 'Bearer fresh-http') {
                throw Object.assign(new Error('revoked credential'), { response: { status: 403 } });
            }
            return { status: 200, data: fact };
        });
        const scope = { accountId: 'bob', serverBaseUrl: 'https://home.example' };
        const observation = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'socket-holder' });
        try {
            await observation.read();
            const result = readRequesterAccountEncryptionCurrentness({ ...scope, token: 'fresh-http' }, async currentness => currentness.mode);
            if (credential === 'revoked') await expect(result).rejects.toThrow();
            else await expect(result).resolves.toBe('plain');
            expect(reads).toHaveBeenCalledTimes(2);
        } finally { await observation.dispose(); await channel.close(); }
    });

    it.each(['retired', 'changed'] as const)('refuses a borrowed identity that is %s while its consumer awaits', async invalidation => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: fact });
        const scope = { accountId: 'bob', serverBaseUrl: 'https://home.example' };
        const peer = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'peer' });
        const borrower = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'borrower' });
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let consuming = false;
        try {
            await peer.read();
            const result = readRequesterAccountEncryptionCurrentness({ ...scope, token: 'borrower' }, async currentness => {
                consuming = true;
                await held;
                return currentness.mode;
            }).then(() => 'accepted', () => 'refused');
            try {
                await expect.poll(() => consuming).toBe(true);
                if (invalidation === 'retired') await borrower.dispose();
                else await channel.push('bob', { ...fact, mode: 'e2ee', version: 2, updatedAt: 2,
                    contentKeyFingerprint: 'changed-content-key' });
            } finally { release(); }
            await expect(result).resolves.toBe('refused');
            await expect(peer.read()).resolves.toMatchObject({ mode: invalidation === 'changed' ? 'e2ee' : 'plain' });
        } finally { release(); await borrower.dispose(); await peer.dispose(); await channel.close(); }
    });

    it('does not lend an admitted socket fact to an unregistered credential for the same Account', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        const reads = vi.spyOn(axios, 'get').mockImplementation(async (_url, config) => {
            if (config?.headers?.Authorization === 'Bearer unregistered') {
                throw Object.assign(new Error('revoked credential'), { response: { status: 403 } });
            }
            return { status: 200, data: fact };
        });
        const scope = { accountId: 'bob', serverBaseUrl: 'https://home.example' };
        const observation = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'bob' });
        try {
            await observation.read();
            await expect(readRequesterAccountEncryptionCurrentness({ ...scope, token: 'unregistered' })).rejects.toThrow();
            expect(reads).toHaveBeenCalledTimes(2);
        } finally { await observation.dispose(); await channel.close(); }
    });

    it('projects socket identity without lending an exact Account or Settings cursor witness', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        let fact = { mode: 'plain' as const, version: 1, settingsVersion: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        const reads = vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200, data: fact }));
        const scope = { accountId: 'bob', token: 'bob', serverBaseUrl: 'https://home.example' };
        const observation = acquireRequesterAccountEncryptionCurrentness(scope);
        try {
            await observation.read();
            const identities = await Promise.all(Array.from({ length: 12 }, () => readRequesterAccountEncryptionCurrentness(scope)));
            expect(identities.every(identity => identity.mode === 'plain')).toBe(true);
            expect(identities[0]).not.toHaveProperty('version');
            expect(identities[0]).not.toHaveProperty('settingsVersion');
            expect(reads).toHaveBeenCalledTimes(1);
            // An unrelated Account write advances the exact witness before any push.
            fact = { ...fact, version: 2, settingsVersion: 2 };
            const exact = await runWithServerHttpBaseUrl(scope.serverBaseUrl,
                () => fetchAccountEncryptionCurrentness({ token: scope.token }));
            expect(exact.version).toBe(2);
            expect(exact.settingsVersion).toBe(2);
            expect(reads).toHaveBeenCalledTimes(2);
        } finally { await observation.dispose(); await channel.close(); }
    });

    it('projects socket identity for an admitted opaque credential without decoding it into authority', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        const reads = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: fact });
        const serverBaseUrl = 'https://home.example';
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'opaque-admitted', serverBaseUrl });
        try {
            await observation.read();
            await expect(readRequesterAccountEncryptionCurrentness({ token: 'opaque-admitted', serverBaseUrl }))
                .resolves.toMatchObject({ mode: 'plain' });
            expect(reads).toHaveBeenCalledTimes(1);
        } finally { await observation.dispose(); await channel.close(); }
    });

    it.each(['requester', 'observed'] as const)('refuses a borrowed identity when its exact borrower retires while a different transport holder stays live (%s)', async reader => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: fact });
        const scope = { accountId: 'bob', serverBaseUrl: 'https://home.example' };
        const transport = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'transport-holder' });
        const borrower = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'borrower' });
        try {
            await transport.read();
            const borrowed = reader === 'requester'
                ? readRequesterAccountEncryptionCurrentness({ ...scope, token: 'borrower' })
                : readObservedAccountEncryptionCurrentness({ ...scope, token: 'borrower' });
            const outcome = expect(borrowed).rejects.toThrow();
            await borrower.dispose();
            await outcome;
            await expect(transport.read()).resolves.toMatchObject({ mode: 'plain' });
        } finally { await borrower.dispose(); await transport.dispose(); await channel.close(); }
    });

    it('selects Follow changes beyond a full Account page and invalidates across a cursor gap and reconnect', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        let phase: 'initial' | 'paged' | 'gap' | 'recovered' = 'initial';
        const cursors: number[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
            if (url.endsWith('/currentness')) return { status: 200, data: fact };
            if (new URL(url).pathname !== '/v2/changes') throw new Error(`Unexpected GET ${url}`);
            const after = Number(new URL(url).searchParams.get('after') ?? 0);
            cursors.push(after);
            if (phase === 'gap') return { status: 410, data: { error: 'cursor-gone', currentCursor: 400 } };
            const changes: ChangeEntry[] = phase === 'paged' && after === 0
                ? Array.from({ length: 200 }, (_, index) => ({ cursor: index + 1, kind: 'session',
                    entityId: `session-${index}`, changedAt: 1 }))
                : phase === 'paged' && after === 200
                    ? [{ cursor: 201, kind: 'account', entityId: 'session-follows', changedAt: 1,
                        hint: buildSessionFollowChangeHintV1() }]
                    : phase === 'recovered' && after < 401
                        ? [{ cursor: 401, kind: 'session', entityId: 'ordinary-source', changedAt: 1 }]
                        : [];
            return { status: 200, data: { changes, nextCursor: changes.at(-1)?.cursor ?? after } };
        });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'bob',
            serverBaseUrl: 'https://home.example' });
        let publications = 0;
        let release: () => void = () => undefined;
        const sourceChanges: (string | null)[] = [];
        let releaseSources: (() => void) | undefined;
        try {
            await observation.read();
            release = observation.subscribeSessionFollowRules(() => { publications++; });
            releaseSources = observation.subscribeSessionFollowSources?.(sessionId => { sourceChanges.push(sessionId); });
            await vi.waitFor(() => expect(cursors).toEqual([0]));
            phase = 'paged';
            await channel.hintAccountChange();
            await vi.waitFor(() => expect(publications).toBe(1));
            expect(cursors).toContain(200);
            expect(sourceChanges).toEqual(expect.arrayContaining(['session-0', 'session-199']));
            phase = 'gap';
            await channel.hintAccountChange();
            await vi.waitFor(() => expect(publications).toBe(2));
            expect(sourceChanges).toContain(null);
            phase = 'recovered';
            await channel.disconnect();
            expect(publications).toBeGreaterThan(2);
            await channel.reconnect();
            await observation.read();
            await vi.waitFor(() => expect(cursors).toContain(400));
            const afterReconnect = publications;
            await channel.hintAccountChange();
            await vi.waitFor(() => expect(cursors).toContain(401));
            expect(publications).toBe(afterReconnect);
            expect(sourceChanges).toContain('ordinary-source');
        } finally { releaseSources?.(); release(); await observation.dispose(); await channel.close(); }
    });

    it('does not publish a retired credential late Follow page into its remaining Account holder', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        let holdOriginal = false;
        let liveRule = false;
        let entered!: () => void;
        let finish!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { finish = resolve; });
        const readers: string[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
            if (url.endsWith('/currentness')) return { status: 200, data: fact };
            if (new URL(url).pathname !== '/v2/changes') throw new Error(`Unexpected GET ${url}`);
            const reader = String(config?.headers?.Authorization);
            readers.push(reader);
            const retiredPage = reader === 'Bearer original-token' && holdOriginal;
            if (retiredPage) {
                entered();
                // A transport may complete after cancellation; its old authority cannot publish.
                await held;
            }
            return { status: 200, data: { changes: retiredPage || liveRule
                ? [{ cursor: 21, kind: 'account', entityId: 'session-follows', changedAt: 1,
                    hint: buildSessionFollowChangeHintV1() }] : [], nextCursor: retiredPage || liveRule ? 21 : 20 } };
        });
        const scope = { accountId: 'bob', serverBaseUrl: 'https://home.example' };
        const original = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'original-token' });
        const remaining = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'remaining-token' });
        let publications = 0;
        let release: () => void = () => undefined;
        try {
            await original.read();
            release = remaining.subscribeSessionFollowRules(() => { publications++; });
            await vi.waitFor(() => expect(readers).toEqual(['Bearer original-token']));
            holdOriginal = true;
            await channel.hintAccountChange();
            await waiting;
            await original.dispose();
            await remaining.read();
            const afterHandover = publications;
            finish();
            await vi.waitFor(() => expect(readers).toContain('Bearer remaining-token'));
            expect(publications).toBe(afterHandover);
            liveRule = true;
            await channel.hintAccountChange();
            await vi.waitFor(() => expect(publications).toBe(afterHandover + 1));
        } finally { finish(); release(); await original.dispose(); await remaining.dispose(); await channel.close(); }
    });

    it('refreshes only Follow configuration through the retained requester Account feed and retires its subscriber', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        let changes: ChangeEntry[] = [];
        let cursor = 0;
        const observedCursors: number[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
            if (url.endsWith('/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (url.endsWith('/currentness')) return { status: 200, data: fact };
            if (new URL(url).pathname === '/v2/changes') {
                expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
                const after = Number(new URL(url).searchParams.get('after') ?? 0);
                observedCursors.push(after);
                return { status: 200, data: { changes: changes.filter(change => change.cursor > after), nextCursor: cursor } };
            }
            throw new Error(`Unexpected GET ${url}`);
        });
        const prepared = await prepareRequesterSessionBootstrap({ credentials: { token, encryption: null },
            attribution: { serverId: 'home', accountId: 'bob', machineId: 'alice-machine', installationId: 'installation' },
            boundary: { serverId: 'home', serverHttpBaseUrl: 'https://home.example', happyHomeDir: '/unused-before-session-binding' },
            // Machine admission is a remote system boundary; Account/profile/settings/currentness and its socket stay real.
            verifyMachineAdmissionCurrent: async () => true });
        if (!prepared) throw new Error('Missing admitted requester bootstrap');
        let invalidated = false;
        const release = prepared.admitted.subscribeSessionFollowRules?.(() => { invalidated = true; });
        try {
            expect(channel.clients).toHaveLength(1);
            cursor = 1;
            changes = [{ cursor, kind: 'account', entityId: 'session-follows', changedAt: 1,
                hint: buildSessionFollowChangeHintV1() }];
            await channel.hintAccountChange();
            await vi.waitFor(() => expect(invalidated).toBe(true));
            invalidated = false;
            cursor = 2;
            changes = [{ cursor, kind: 'session', entityId: 'source', changedAt: 2 }];
            await channel.hintAccountChange();
            await vi.waitFor(() => expect(observedCursors).toContain(1));
            expect(invalidated).toBe(false);
            release?.();
            cursor = 3;
            changes = [{ cursor, kind: 'account', entityId: 'session-follows', changedAt: 3,
                hint: buildSessionFollowChangeHintV1() }];
            await channel.hintAccountChange();
            expect(invalidated).toBe(false);
            expect(channel.clients).toHaveLength(1);
        } finally { release?.(); await prepared.cleanupOnFailure(); await channel.close(); }
    });

    it('admits repeated Account storage reads from the live encryption identity without recurring HTTP', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null };
        const reads = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: fact });
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
        const scope = { accountId: 'bob', token, serverBaseUrl: 'https://home.example' };
        const observation = acquireRequesterAccountEncryptionCurrentness(scope);
        const storage = () => resolveCliAccountStorageContext({ credentials: { token, encryption: null },
            serverBaseUrl: scope.serverBaseUrl, authorizationHeaders: { Authorization: `Bearer ${token}` }, usage: 'identity' });
        try {
            await observation.read();
            const initial = reads.mock.calls.length;
            for (let pass = 0; pass < 12; pass++) await expect(storage()).resolves.toEqual({ mode: 'plain', material: null });
            await expect(runWithServerHttpBaseUrl(scope.serverBaseUrl,
                () => resolveCliAccountStorageContext({ credentials: { token, encryption: null }, usage: 'identity' })))
                .resolves.toEqual({ mode: 'plain', material: null });
            expect(reads.mock.calls.length - initial).toBe(0);
            await channel.disconnect();
            await expect(storage()).rejects.toThrow();
            expect(reads.mock.calls.length - initial).toBe(0);
        } finally { await observation.dispose(); await channel.close(); }
    });
    it('reports transport creation failure without secrets while preserving fresh HTTP reads', async () => {
        const sockets = await import('@/api/session/sockets');
        // Transport creation and file logging are system boundaries; currentness logic stays real.
        vi.spyOn(sockets, 'createUserScopedSocketConnection').mockImplementation(() => {
            throw new Error('transport failure with secret-token');
        });
        const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const first = { mode: 'plain' as const, version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null };
        const second = { ...first, version: 2 };
        vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: first }).mockResolvedValueOnce({ status: 200, data: second });
        const scope = { accountId: 'private-account', serverBaseUrl: 'https://private-home.example' };
        const observation = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'secret-token' });
        const remaining = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'remaining-secret-token' });
        try {
            await expect(observation.read(undefined, { requireLiveObservation: true }))
                .rejects.toBeInstanceOf(AccountEncryptionCurrentnessUnavailableError);
            expect(axios.get).not.toHaveBeenCalled();
            await expect(observation.read()).resolves.toEqual(projectAccountEncryptionIdentity(first));
            await observation.dispose();
            await expect(remaining.read()).resolves.toEqual(projectAccountEncryptionIdentity(second));
            expect(axios.get).toHaveBeenLastCalledWith('https://private-home.example/v1/account/encryption/currentness',
                expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer remaining-secret-token' }) }));
            expect(warnings).toHaveBeenCalled();
            expect(JSON.stringify(warnings.mock.calls)).not.toContain('secret-token');
            expect(JSON.stringify(warnings.mock.calls)).not.toContain('private-account');
            expect(JSON.stringify(warnings.mock.calls)).not.toContain('private-home.example');
        } finally {
            await observation.dispose();
            await remaining.dispose();
        }
    });

    it('reads exact claim currentness freshly while sharing only Account/Home encryption identity', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null };
        let serverFact = fact;
        let available = true;
        vi.spyOn(axios, 'get').mockImplementation(async () => available
            ? { status: 200, data: serverFact } : { status: 503, data: {} });
        const scope = { accountId: 'bob', token: `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`,
            serverBaseUrl: 'https://home.example' };
        const observation = acquireRequesterAccountEncryptionCurrentness(scope);
        const api = new ConnectedServiceCredentialHttpClient({ token: scope.token });
        const readObservedMode = () => runWithServerHttpBaseUrl(scope.serverBaseUrl,
            () => api.getAccountEncryptionMode({ usage: 'identity', throwOnTransportError: true }));
        try {
            await observation.read();
            // Claiming advances the Account cursor before returning its exact
            // witness. That response can arrive before the socket wake.
            serverFact = { ...fact, version: 2 };
            expect(projectAutomationAccountCurrentnessWitnessV1(await fetchAccountEncryptionCurrentness(scope)))
                .toEqual({ mode: 'plain', version: 2, contentKeyFingerprint: null });
            available = false;
            await expect(fetchAccountEncryptionCurrentness(scope)).rejects.toThrow();
            await expect(readObservedMode()).resolves.toBe('plain');
            await expect(fetchAccountEncryptionCurrentness({ ...scope, serverBaseUrl: 'https://other.home' })).rejects.toThrow();
            await expect(fetchAccountEncryptionCurrentness({ ...scope,
                token: `header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature` })).rejects.toThrow();
            const signedHeaders = createExternalActionAuthorizedRequestHeaders({ authorization: root,
                effectActionId: root.binding.actionId, target: root.binding.target, installationId: 'installation',
                method: 'GET', path: '/v1/account/encryption/currentness', privateKey: nacl.sign.keyPair().secretKey });
            await expect(fetchAccountEncryptionCurrentness({ ...scope, authorizationHeaders: signedHeaders })).rejects.toThrow();
            const storage = (token: string, serverBaseUrl: string, authorizationHeaders?: Readonly<Record<string, string>>) =>
                resolveCliAccountStorageContext({ credentials: { token, encryption: null }, serverBaseUrl, authorizationHeaders });
            await expect(storage(scope.token, 'https://other.home')).rejects.toThrow();
            await expect(storage(`header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`,
                scope.serverBaseUrl)).rejects.toThrow();
            await expect(storage(scope.token, scope.serverBaseUrl, signedHeaders)).rejects.toThrow();
            await channel.disconnect();
            await expect(fetchAccountEncryptionCurrentness(scope)).rejects.toThrow();
            await expect(readObservedMode()).rejects.toThrow();
        } finally { await observation.dispose(); await channel.close(); }
    });
    it.each(['finite', 'session'] as const)('does not register another Account credential as the requester observation (%s)', async kind => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const encryptionAccounts: string[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
            const account = config?.headers?.Authorization === 'Bearer alice' ? 'alice' : 'bob';
            if (url.endsWith('/profile')) return { status: 200, data: { id: account } };
            if (url.endsWith('/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (url.endsWith('/currentness')) {
                encryptionAccounts.push(account);
                return { status: 200, data: { mode: 'plain', version: 1, updatedAt: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null } };
            }
            throw new Error(`Unexpected GET ${url}`);
        });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
        const privateKey = nacl.sign.keyPair().secretKey;
        const verify = () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: root,
            effectActionId: root.binding.actionId, target: root.binding.target, installationId: 'installation',
            privateKey, serverHttpBaseUrl: 'https://home.example' });
        const admit = async (token: string) => {
            const credentials = { token, encryption: null };
            if (kind === 'finite') return await admitRequesterAccountActionContext({ authorization: root, credentials,
                serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example', isCurrent: verify });
            const prepared = await prepareRequesterSessionBootstrap({ credentials,
                attribution: { serverId: 'home', accountId: 'bob', machineId: 'machine', installationId: 'installation' },
                boundary: { serverId: 'home', serverHttpBaseUrl: 'https://home.example', happyHomeDir: '/unused-before-session-binding' },
                verifyMachineAdmissionCurrent: verify });
            return prepared ? { dispose: prepared.cleanupOnFailure } : null;
        };
        let accepted: Awaited<ReturnType<typeof admit>> = null;
        try {
            expect(await admit('alice')).toBeNull();
            expect(channel.clients).toHaveLength(0);
            // Session admission may read Alice's own HTTP witness while checking
            // her profile; it must never register that fact as Bob's observation.
            expect(encryptionAccounts.every(account => account === 'alice')).toBe(true);
            const beforeBob = encryptionAccounts.length;
            accepted = await admit('bob');
            expect(accepted).not.toBeNull();
            const bobReads = encryptionAccounts.slice(beforeBob);
            expect(bobReads.length).toBeGreaterThan(0);
            expect(bobReads.every(account => account === 'bob')).toBe(true);
            // Finite and Session holders both retain the same admitted Account observation.
            expect(channel.clients).toHaveLength(1);
        } finally { await accepted?.dispose(); await channel.close(); }
    });

    it.each(['unbound', 'bound'] as const)('invalidates requester bootstrap and projected custody on a pushed Account change (%s)', async binding => {
        const channel = await createRequesterCurrentnessSocketHarness();
        let serverFact: AccountEncryptionCurrentnessResponse = { mode: 'plain', version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (url.endsWith('/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (url.endsWith('/v2/sessions/session')) return { status: 200, data: { session: createSessionRecordFixture({
                id: 'session', encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', path: '/repo' }),
                dataEncryptionKey: null, share: null,
            }) } };
            if (url.endsWith('/currentness')) return { status: 200, data: serverFact };
            throw new Error(`Unexpected GET ${url}`);
        });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
        const privateKey = nacl.sign.keyPair().secretKey;
        const custody = await prepareRequesterSessionBootstrap({ credentials: { token: 'bob', encryption: null },
            attribution: { serverId: 'home', accountId: 'bob', machineId: 'machine', installationId: 'installation' },
            boundary: { serverId: 'home', serverHttpBaseUrl: 'https://home.example', happyHomeDir: '/unused-before-session-binding' },
            ...(binding === 'bound' ? { boundSessionId: 'session' } : {}),
            verifyMachineAdmissionCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: root,
                effectActionId: root.binding.actionId, target: root.binding.target, installationId: 'installation',
                privateKey, serverHttpBaseUrl: 'https://home.example' }),
        });
        try {
            if (!custody) throw new Error('Missing real requester bootstrap');
            const projected = await custody.admitted.projectExternalActionAuthorization(root, 'stable-home');
            expect(projected).not.toBeNull();
            expect(await projected?.requesterAccountProjection?.isCurrent()).toBe(true);
            expect(await custody.admitted.isCurrent()).toBe(true);
            expect(channel.clients).toHaveLength(1);
            serverFact = { mode: 'e2ee', version: 2, updatedAt: 2,
                signingKeyFingerprint: 'changed-signing', contentKeyFingerprint: 'changed-content' };
            await channel.push('bob', serverFact);
            expect(await projected?.requesterAccountProjection?.isCurrent()).toBe(false);
            expect(await custody.admitted.isCurrent()).toBe(false);
        } finally {
            try { await custody?.cleanupOnFailure(); } finally { await channel.close(); }
        }
    });

    it.each(['mode', 'signing key', 'content key', 'disconnect', 'withdrawn', 'malformed'] as const)(
        'refuses headers and new projection output when %s is pushed during a Home decision', async change => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const secret = new Uint8Array(32).fill(8);
        const mode = change === 'signing key' || change === 'content key' ? 'e2ee' : 'plain';
        const currentness = { mode, version: 1, updatedAt: 1,
            signingKeyFingerprint: mode === 'e2ee' ? computeAccountEncryptionMigrateKeyFingerprintV1(nacl.sign.keyPair.fromSeed(secret).publicKey) : null,
            contentKeyFingerprint: mode === 'e2ee' ? computeAccountEncryptionMigrateKeyFingerprintV1(nacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey) : null };
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (url.endsWith('/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/settings')) return { status: 200, data: mode === 'e2ee' ? { content: null, version: 0 }
                : { content: { t: 'plain', v: {} }, version: 1 } };
            if (url.endsWith('/currentness')) return { status: 200, data: currentness };
            throw new Error(`Unexpected GET ${url}`);
        });
        let hold = false;
        let entered!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(axios, 'post').mockImplementation(async () => {
            if (hold) { entered(); await held; }
            return { status: 200, data: { ok: true } };
        });
        const installationPrivateKey = nacl.sign.keyPair().secretKey;
        const prepared = await prepareRequesterAccountActionContext({ authorization: { ...root, binding: { ...root.binding, accountEncryptionMode: mode } },
            purpose: { kind: 'external_action' }, machineId: 'machine', installationId: 'installation', installationPrivateKey,
            serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example',
            ownCredentials: { token: 'bob', encryption: mode === 'e2ee' ? { type: 'legacy', secret } : null }, isCurrent: async () => true,
            createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }),
        });
        try {
            if (!prepared) throw new Error('Missing real requester custody');
            hold = true;
            const headers = prepared.authorization.requesterHttpProjection!.createRequestHeaders({
                effectActionId: 'projects.inspect', method: 'GET', path: '/v1/account/encryption/currentness' });
            const projection = projectExternalActionRequesterHttpAuthorization({ authorization: prepared.authorization, serverId: 'home',
                serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example', target: root.binding.target,
                installationId: 'installation', privateKey: installationPrivateKey,
                isCurrent: prepared.authorization.requesterAccountProjection!.isCurrent });
            await waiting;
            if (change === 'disconnect') await channel.disconnect();
            else if (change === 'malformed') await channel.pushInvalidCurrentness('bob');
            else await channel.push('bob', change === 'withdrawn' ? null : { ...currentness, version: 2, updatedAt: 2,
                ...(change === 'mode' ? { mode: 'e2ee', signingKeyFingerprint: 'new-signing', contentKeyFingerprint: 'new-content' }
                    : change === 'signing key' ? { signingKeyFingerprint: 'changed-signing' } : { contentKeyFingerprint: 'changed-content' }) });
            release();
            // Signing is no disclosure and Home refuses a stale request; the next
            // request after the pushed change is the boundary that must stop.
            await headers;
            expect(await prepared.authorization.requesterHttpProjection!.createRequestHeaders({
                effectActionId: 'projects.inspect', method: 'GET', path: '/v1/account/encryption/currentness' })).toBeNull();
            expect(await projection).toBeNull();
        } finally { release(); await prepared?.dispose?.(); await channel.close(); }
    });

    it('shares one Account fact without idle polling, ignores profile/foreign changes, and reads once after reconnect', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null };
        const reads = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: fact });
        const scope = { accountId: 'bob', token: 'bob', serverBaseUrl: 'https://home.example' };
        const first = acquireRequesterAccountEncryptionCurrentness(scope);
        const second = acquireRequesterAccountEncryptionCurrentness(scope);
        try {
            expect(await first.read()).toEqual(projectAccountEncryptionIdentity(fact));
            expect(await second.read()).toEqual(projectAccountEncryptionIdentity(fact));
            expect(reads).toHaveBeenCalledTimes(1);
            expect(channel.clients).toHaveLength(1);
            // Keep initial connection and reconnect on the real Socket.IO clock.
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
            await vi.advanceTimersByTimeAsync(600_000);
            expect(first.isCurrent(fact)).toBe(true);
            expect(await second.read()).toEqual(projectAccountEncryptionIdentity(fact));
            expect(reads).toHaveBeenCalledTimes(1);
            expect(channel.clients).toHaveLength(1);
            vi.useRealTimers();
            await channel.pushProfile('bob');
            await channel.push('other-account', { ...fact, mode: 'e2ee', version: 2 });
            expect(first.isCurrent(fact)).toBe(true);
            await channel.disconnect();
            expect(first.isCurrent(fact)).toBe(false);
            await expect(first.read()).rejects.toThrow();
            expect(reads).toHaveBeenCalledTimes(1);
            await channel.reconnect();
            expect(await second.read()).toEqual(projectAccountEncryptionIdentity(fact));
            expect(reads).toHaveBeenCalledTimes(2);
            await first.dispose();
            expect(second.isCurrent(fact)).toBe(true);
        } finally { vi.useRealTimers(); await first.dispose(); await second.dispose(); await channel.close(); }
    });

    it('keeps the shared observation on a live credential after its original holder retires', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        let retired = false;
        const reads = vi.spyOn(axios, 'get').mockImplementation(async (_url, config) =>
            retired && config?.headers?.Authorization === 'Bearer original-token'
                ? { status: 401, data: {} } : { status: 200, data: fact });
        const scope = { accountId: 'bob', serverBaseUrl: 'https://home.example' };
        const first = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'original-token' });
        const remaining = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'remaining-token' });
        try {
            await expect(first.read()).resolves.toEqual(projectAccountEncryptionIdentity(fact));
            await first.dispose();
            retired = true;
            await expect(remaining.read()).resolves.toEqual(projectAccountEncryptionIdentity(fact));
            await channel.push('bob', null);
            await expect(remaining.read()).resolves.toEqual(projectAccountEncryptionIdentity(fact));
            expect(reads).toHaveBeenLastCalledWith('https://home.example/v1/account/encryption/currentness',
                expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer remaining-token' }) }));
            const connected = channel.clients.filter(client => client.connected);
            expect(connected).toHaveLength(1);
            expect(connected[0]?.auth).toMatchObject({ token: 'remaining-token' });
        } finally {
            await first.dispose();
            await remaining.dispose();
            await channel.close();
        }
    });

    it('does not wait for a retired credential HTTP read or publish its late fact after handover', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const oldFact = { mode: 'plain' as const, version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        const currentFact = { ...oldFact, version: 2, updatedAt: 2 };
        let entered!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(axios, 'get').mockImplementation(async (_url, config) => {
            if (config?.headers?.Authorization === 'Bearer original-token') {
                entered();
                // A network boundary can finish after its AbortSignal; publication must remain fenced.
                await held;
                return { status: 200, data: oldFact };
            }
            return { status: 200, data: currentFact };
        });
        const scope = { accountId: 'bob', serverBaseUrl: 'https://home.example' };
        const original = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'original-token' });
        const remaining = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'remaining-token' });
        const reading = original.read().then(() => 'resolved', () => 'retired');
        try {
            await waiting;
            await original.dispose();
            await expect(reading).resolves.toBe('retired');
            await expect(remaining.read()).resolves.toEqual(projectAccountEncryptionIdentity(currentFact));
            release();
            await new Promise<void>(resolve => setImmediate(resolve));
            await expect(remaining.read()).resolves.toEqual(projectAccountEncryptionIdentity(currentFact));
            expect(remaining.isCurrent(currentFact)).toBe(true);
            const connected = channel.clients.filter(client => client.connected);
            expect(connected).toHaveLength(1);
            expect(connected[0]?.auth).toMatchObject({ token: 'remaining-token' });
        } finally {
            release();
            await original.dispose();
            await remaining.dispose();
            await channel.close();
        }
    });

    it('keeps a pushed fact when an earlier HTTP subscription read finishes later', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        let entered!: () => void;
        let release!: (value: { status: number; data?: unknown }) => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<{ status: number; data?: unknown }>(resolve => { release = resolve; });
        vi.spyOn(axios, 'get').mockImplementation(async () => { entered(); return await held; });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'bob', serverBaseUrl: 'https://home.example' });
        const pending = observation.read();
        try {
            await waiting;
            const changed = { mode: 'e2ee' as const, version: 2, updatedAt: 2, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content' };
            await channel.push('bob', changed);
            release({ status: 200, data: { ...changed, mode: 'plain', version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null } });
            expect(await pending).toEqual(projectAccountEncryptionIdentity(changed));
            expect(observation.isCurrent(changed)).toBe(true);
        } finally { release({ status: 503 }); await observation.dispose(); await channel.close(); }
    });

    it('recovers an unknown HTTP fact on the next decision without a per-connection attempt limit', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null };
        let available = false;
        const reads = vi.spyOn(axios, 'get').mockImplementation(async () => available
            ? { status: 200, data: fact } : { status: 503, data: {} });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'bob', serverBaseUrl: 'https://home.example' });
        try {
            const failure: unknown = await observation.read().catch(error => error);
            expect(readHttpStatus(failure instanceof Error ? failure.cause : null)).toBe(503);
            expect(observation.isCurrent(fact)).toBe(false);
            available = true;
            const before = reads.mock.calls.length;
            expect(await observation.read()).toEqual(projectAccountEncryptionIdentity(fact));
            expect(reads.mock.calls.length - before).toBe(1);
            expect(await observation.read()).toEqual(projectAccountEncryptionIdentity(fact));
            expect(reads.mock.calls.length - before).toBe(1);
        } finally { await observation.dispose(); await channel.close(); }
    });

    it('subscribes once and reuses the observed fact at repeated header decisions', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (url.endsWith('/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (url.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
                updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null } };
            throw new Error(`Unexpected GET ${url}`);
        });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
        const prepared = await prepareRequesterAccountActionContext({ authorization: root, purpose: { kind: 'external_action' },
            machineId: 'machine', installationId: 'installation', installationPrivateKey: nacl.sign.keyPair().secretKey,
            serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example',
            ownCredentials: { token: 'bob', encryption: null }, isCurrent: async () => true,
            createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }),
        });
        try {
            expect(prepared).not.toBeNull();
            const context = readRequesterAccountActionContext(prepared?.authorization);
            expect(context).not.toBeNull();
            expect(await context?.refreshAccountSettings()).toBe(true);
            const initialReads = reads.mock.calls.filter(([url]) => String(url).endsWith('/currentness')).length;
            for (let decision = 0; decision < 3; decision++) {
                expect(await prepared?.authorization.requesterHttpProjection?.createRequestHeaders({
                    effectActionId: 'projects.inspect', method: 'GET', path: '/v1/account/encryption/currentness',
                })).not.toBeNull();
            }
            expect(reads.mock.calls.filter(([url]) => String(url).endsWith('/currentness'))).toHaveLength(initialReads);
            expect(channel.clients).toHaveLength(1);
        } finally { await prepared?.dispose?.(); await channel.close(); }
    });

    it.each(['abort', 'dispose'] as const)('cancels a waiting reader on %s without retiring another holder of the same Account fact', async cancellationKind => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null };
        let entered!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(axios, 'get').mockImplementation(async () => { entered(); await held; return { status: 200, data: fact }; });
        const scope = { accountId: 'bob', token: 'bob', serverBaseUrl: 'https://home.example' };
        const first = acquireRequesterAccountEncryptionCurrentness(scope);
        const second = acquireRequesterAccountEncryptionCurrentness(scope);
        const cancellation = new AbortController();
        let outcome = 'pending';
        const reading = first.read(cancellation.signal).then(() => { outcome = 'resolved'; }, () => { outcome = 'refused'; });
        try {
            await waiting;
            if (cancellationKind === 'abort') cancellation.abort();
            else await first.dispose();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(outcome).toBe('refused');
            await reading;
            await first.dispose();
            release();
            expect(await second.read()).toEqual(projectAccountEncryptionIdentity(fact));
            expect(second.isCurrent(fact)).toBe(true);
        } finally { release(); await first.dispose(); await second.dispose(); await channel.close(); }
    });

    it.each(['session', 'finite'] as const)(
        'keeps the fresh preparation Settings minimum when the idle encryption identity has not changed (%s)', async kind => {
        const channel = await createRequesterCurrentnessSocketHarness();
        let fact = { mode: 'plain' as const, version: 1, settingsVersion: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (url.endsWith('/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (url.endsWith('/currentness')) return { status: 200, data: fact };
            throw new Error(`Unexpected GET ${url}`);
        });
        const scope = { accountId: 'bob', token: 'bob', serverBaseUrl: 'https://home.example' };
        const observation = acquireRequesterAccountEncryptionCurrentness(scope);
        const accepted: { cleanup?: () => Promise<void> } = {};
        try {
            await observation.read();
            // The Home write has committed, while its Settings/socket publication is delayed.
            fact = { ...fact, version: 2, settingsVersion: 2 };
            const preparing = kind === 'finite' ? admitRequesterAccountActionContext({ authorization: root,
                credentials: { token: 'bob', encryption: null }, serverId: 'home', serverIdentityId: 'stable-home',
                serverHttpBaseUrl: scope.serverBaseUrl, isCurrent: async () => true })
                .then(result => { accepted.cleanup = result?.dispose; return result !== null; })
                : prepareRequesterSessionBootstrap({ credentials: { token: 'bob', encryption: null },
                attribution: { serverId: 'home', accountId: 'bob', machineId: 'machine', installationId: 'installation' },
                boundary: { serverId: 'home', serverHttpBaseUrl: scope.serverBaseUrl, happyHomeDir: '/unused-before-session-binding' },
                verifyMachineAdmissionCurrent: async () => true })
                .then(result => { accepted.cleanup = result?.cleanupOnFailure; return result !== null; });
            if (kind === 'finite') await expect(preparing).resolves.toBe(false);
            else await expect(preparing).rejects.toMatchObject({ code: 'ACCOUNT_SETTINGS_STALE' });
        } finally { await accepted.cleanup?.(); await observation.dispose(); await channel.close(); }
    });

    it.each(['malformed', 'reconnect'] as const)(
        'recovers the fresh Settings minimum after %s without an encryption identity change', async recovery => {
        const channel = await createRequesterCurrentnessSocketHarness();
        let fact = { mode: 'plain' as const, version: 1, settingsVersion: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null };
        let settingsVersion = 1;
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (url.endsWith('/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/settings')) return { status: 200, data: {
                content: { t: 'plain', v: { preferredLanguage: settingsVersion === 1 ? 'en' : 'fr' } }, version: settingsVersion } };
            if (url.endsWith('/currentness')) return { status: 200, data: fact };
            throw new Error(`Unexpected GET ${url}`);
        });
        const prepared = await prepareRequesterSessionBootstrap({ credentials: { token: 'bob', encryption: null },
            attribution: { serverId: 'home', accountId: 'bob', machineId: 'machine', installationId: 'installation' },
            boundary: { serverId: 'home', serverHttpBaseUrl: 'https://home.example', happyHomeDir: '/unused-before-session-binding' },
            verifyMachineAdmissionCurrent: async () => true });
        try {
            if (!prepared) throw new Error('Missing requester bootstrap');
            expect(await prepared.admitted.ensureAccountSettingsCurrent()).toBe(true);
            fact = { ...fact, version: 2, settingsVersion: 2 };
            if (recovery === 'malformed') await channel.pushInvalidSettings('bob');
            else { await channel.disconnect(); await channel.reconnect(); }
            await expect(prepared.admitted.ensureAccountSettingsCurrent()).rejects.toMatchObject({ code: 'ACCOUNT_SETTINGS_STALE' });
            expect(prepared.admitted.savedSecretOperationContext.readSnapshot()?.settingsVersion).toBe(1);
            settingsVersion = 2;
            expect(await prepared.admitted.ensureAccountSettingsCurrent()).toBe(true);
            expect(prepared.admitted.savedSecretOperationContext.readSnapshot()?.settingsVersion).toBe(2);
            // Known Settings hints and pushes retain their own publication authority.
            settingsVersion = 3;
            await channel.hintSettings(3);
            expect(await prepared.admitted.ensureAccountSettingsCurrent()).toBe(true);
            expect(prepared.admitted.savedSecretOperationContext.readSnapshot()?.settingsVersion).toBe(3);
            await channel.pushSettings('bob', { preferredLanguage: 'de' }, 4);
            expect(await prepared.admitted.ensureAccountSettingsCurrent()).toBe(true);
            expect(prepared.admitted.savedSecretOperationContext.readSnapshot()?.settingsVersion).toBe(4);
        } finally { await prepared?.cleanupOnFailure(); await channel.close(); }
    });

    it('retires an observation while its initial HTTP read is pending', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fact = { mode: 'plain' as const, version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null };
        let entered!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(axios, 'get').mockImplementation(async () => { entered(); await held; return { status: 200, data: fact }; });
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token: 'bob', serverBaseUrl: 'https://home.example' });
        let outcome = 'pending';
        const reading = observation.read().then(() => { outcome = 'resolved'; }, () => { outcome = 'refused'; });
        try {
            await waiting;
            await new Promise<void>(resolve => setImmediate(resolve));
            await observation.dispose();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(outcome).toBe('refused');
            await reading;
            expect(observation.isCurrent(fact)).toBe(false);
        } finally { release(); await observation.dispose(); await channel.close(); }
    });
});
