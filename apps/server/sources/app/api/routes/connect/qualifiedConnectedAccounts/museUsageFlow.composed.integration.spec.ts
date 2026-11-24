import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import axios, { type AxiosRequestConfig } from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { withAuthenticatedTestApp } from '../../../testkit/sqliteFastify';
import { registerQualifiedConnectedAccountCredentialRoutesV4 } from './registerQualifiedConnectedAccountCredentialRoutesV4';
import { mutateQualifiedConnectedServiceCredential } from './credentialRepository';
import { readExactQualifiedConnectedServiceUsageSource, writeQualifiedProviderAccountUsageRecord } from './usageRepository';
import { openQualifiedConnectedAccountQuotaResponseV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { AgentSessionHostServices } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol';
import * as controlClient from '../../../../../../../cli/src/daemon/controlClient';
import { createNativeAgentAccountUsageService } from '../../../../../../../cli/src/agent/runtime/registry/engineRegistry/nativeAgentAccountUsage';
import { createProviderAccountUsagePersistenceScheduler } from '../../../../../../../cli/src/daemon/connectedServices/accountUsage/persistence';
import { createProviderAccountUsageStore } from '../../../../../../../cli/src/daemon/connectedServices/accountUsage/store';
import { recordProviderAccountUsageSnapshotForSession } from '../../../../../../../cli/src/daemon/connectedServices/accountUsage/recordProviderAccountUsageSnapshotForSession';
import { resolveProviderAccountUsageAuthoritativeSource } from '../../../../../../../cli/src/daemon/connectedServices/accountUsage/runtimeSource';
import { buildProviderAccountUsageIdentityFromQualifiedAccount } from '../../../../../../../cli/src/daemon/connectedServices/accountUsage/qualifiedAccountIdentity';
import { buildProviderAccountUsageSnapshotFromPluginConnectedAccountQuota } from '../../../../../../../cli/src/daemon/connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { readQualifiedConnectedAccountQuotaV4, writeQualifiedProviderAccountUsageV4 } from '../../../../../../../cli/src/api/client/qualifiedConnectedAccountApi';
import { runWithServerHttpBaseUrl } from '../../../../../../../cli/src/api/client/serverHttpBaseUrl';
import { createStablePluginExecService } from '../../../../../../../cli/src/plugins/runtime/invocation/services/exec';
import { recordMuseUsageObservation } from '../../../../../../../../packages/plugins/muse/src/agent/accountUsage';
import { MUSE_ACCOUNT_SERVICE, museAccountDescriptor } from '../../../../../../../../packages/plugins/muse/src/connectedAccounts/declarations';
import { museConnectedAccountRuntime } from '../../../../../../../../packages/plugins/muse/src/connectedAccounts/museAccountNativeRuntime';
import { createMuseMspProcessFixture, readMuseLoginRecording } from '../../../../../../../../packages/plugins/muse/src/agent/testkit/mspProcess';

// Muse 1.4.18 MSP shape and r1112y native-import identity: email only, no expiry/configuration.
const usage = { observedAtMs: 1794530400000, tier: 'Subscription',
    weekly: { usedPercent: 16, resetsAtMs: 1794787200000 },
    window: { usedPercent: 2, resetsAtMs: 1794534000000, windowDurationMins: 300 } };
const ref = { service: MUSE_ACCOUNT_SERVICE, accountId: 'ca_13007abc-ac59-4acb-a4d4-1bfa5dce1538' };
const serviceId = 'happier.agent.muse/muse-account';

describe('Muse qualified usage publication through Home', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-muse-usage-flow-', initEncrypt: true }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => { vi.restoreAllMocks(); await db.serviceAccountToken.deleteMany(); await db.account.deleteMany(); });

    it.each([false, true])('publishes a Muse usage event through recordSnapshot and reads its Account figures (encrypted=%s)', async encrypted => {
        await runFlow(encrypted, 'event');
    });
    it.each([false, true])('registers a cold Muse source, accepts manual Refresh, invokes quota and reads figures (encrypted=%s)', async encrypted => {
        await runFlow(encrypted, 'refresh');
    });

    it.each([
        { service: { pluginId: 'example.other', localId: 'muse-account' }, accountId: ref.accountId },
        { service: ref.service, accountId: 'different-connected-account' },
    ])('does not link identity-free Muse usage to a different qualified Account (%j)', async otherRef => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const credential = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref: otherRef,
            expectedCredentialRevision: null, authenticationModeId: 'native-import',
            content: { t: 'plain', v: { token: 'synthetic' } }, metadata: { scopes: [] } });
        if (credential.status !== 'written') throw new Error('Credential fixture failed');
        const snapshot = buildProviderAccountUsageSnapshotFromPluginConnectedAccountQuota({
            profile: { ref, status: 'connected', authenticationModeId: 'native-import', kind: 'oauth', expiresAt: null,
                revisionSemantics: 'revisioned', credentialRevision: credential.credentialRevision,
                configurationRevision: null, configurationReady: false, providerIdentity: { email: 'qa@example.invalid' }, scopes: [] },
            quota: { observedAtMs: usage.observedAtMs, limits: [{ id: 'weekly', used: 16, limit: 100 }] },
            staleAfterMs: 1, usageIdentity: museAccountDescriptor.usageIdentity });
        const result = await writeQualifiedProviderAccountUsageRecord({ accountId: account.id,
            source: { ref: otherRef, bindingKind: 'account' }, expectedCredentialRevision: credential.credentialRevision,
            expectedConfigurationRevision: null, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
            payloadMode: 'plain_json_v1', snapshot, status: 'ok', fetchedAt: snapshot.fetchedAtMs, staleAfterMs: 1 });
        expect(result).toMatchObject({ sourceOutcome: { status: 'skipped', reason: 'ownership_unproven' } });
        expect(await readExactQualifiedConnectedServiceUsageSource({ accountId: account.id,
            source: { ref: otherRef, bindingKind: 'account' } })).toEqual({ status: 'ownership_unproven' });
    });

    async function runFlow(encrypted: boolean, flow: 'event' | 'refresh') {
        const account = await db.account.create({ data: encrypted
            ? { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' }
            : { publicKey: null, encryptionMode: 'plain' } });
        const created = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref,
            expectedCredentialRevision: null, authenticationModeId: 'native-import',
            content: encrypted ? { t: 'encrypted', c: 'sealed-native-import' } : { t: 'plain', v: { token: 'synthetic' } },
            metadata: { scopes: [], providerIdentity: { email: 'qa@example.invalid' } } });
        if (created.status !== 'written') throw new Error('Credential fixture failed');
        const profile: QualifiedConnectedAccountProfileV4 = { ref, status: 'connected', authenticationModeId: 'native-import',
            revisionSemantics: 'revisioned', credentialRevision: created.credentialRevision,
            configurationRevision: null, configurationReady: false, kind: 'oauth', expiresAt: null,
            providerIdentity: { email: 'qa@example.invalid' }, displayName: 'Muse', scopes: [] };
        const credentials = { token: 'synthetic-account-token', encryption: encrypted
            ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } : null };
        const signal = new AbortController().signal;
        const source = { serviceId, profileId: ref.accountId, bindingKind: 'profile' as const };
        const target = { source: { ref, bindingKind: 'account' as const }, expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: null };
        const store = createProviderAccountUsageStore();
        const identity = buildProviderAccountUsageIdentityFromQualifiedAccount({ ref, providerIdentity: profile.providerIdentity,
            usageIdentity: museAccountDescriptor.usageIdentity });
        await runWithServerHttpBaseUrl('http://home.test', () => withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            // HTTP is the replaced boundary: all request schemas, encryption, source ownership,
            // database writes and public quota reads remain the production implementations.
            const writes: Array<{ path: string; status: number; data: unknown }> = [];
            for (const method of ['get', 'post', 'put'] as const) vi.spyOn(axios, method).mockImplementation(async (url: string, body?: unknown, options?: AxiosRequestConfig) => {
                const parsed = new URL(url);
                const config = method === 'get' ? body as AxiosRequestConfig | undefined : options;
                const headers = Object.fromEntries(Object.entries(config?.headers ?? {}).map(([key, value]) => [key, String(value)]));
                const response = await app.inject({ method: method.toUpperCase() as 'GET' | 'POST' | 'PUT',
                    url: parsed.pathname + parsed.search, headers: { ...headers, 'x-test-user-id': account.id },
                    ...(method === 'get' ? {} : { payload: body }) });
                const result = { status: response.statusCode, data: response.json() };
                if (method === 'post') writes.push({ path: parsed.pathname, ...result });
                if (response.statusCode >= 400 && method !== 'get') throw Object.assign(new Error('Home write refused'), { response: result });
                return result;
            });
            const persistence = createProviderAccountUsagePersistenceScheduler({ credentials,
                async writeQualifiedProviderAccountUsage(input) {
                    try { return await writeQualifiedProviderAccountUsageV4(input); }
                    catch (error) { writes.push({ path: 'writer-failure', status: 0, data: error instanceof Error ? { name: error.name, message: error.message } : String(error) }); throw error; }
                },
                api: { getAccountEncryptionMode: async () => encrypted ? 'e2ee' : 'plain' },
                now: () => usage.observedAtMs, randomBytes: size => new Uint8Array(size).fill(3), fingerprintKey: new Uint8Array(32).fill(4) });
            try {
                const publish = async (snapshot: Parameters<typeof persistence.recordInBandSnapshot>[0]) => {
                    await persistence.recordInBandSnapshot(snapshot, { targets: [target] });
                    await persistence.flush(5_000);
                };
                if (flow === 'event') {
                    vi.spyOn(controlClient, 'notifyDaemonProviderAccountUsageSnapshot').mockImplementation(async request => {
                        const result = await recordProviderAccountUsageSnapshotForSession({
                            getChildren: () => [{ happySessionId: 'muse-session' }], sessionId: request.sessionId,
                            snapshot: request.snapshot, observation: { sources: [source] }, store, persistence,
                            resolveAuthoritativeSource: async claimed => resolveProviderAccountUsageAuthoritativeSource({ source: claimed,
                                activeBindings: [{ serviceId, profileId: ref.accountId, groupId: null, groupGeneration: null,
                                    credentialRevision: created.credentialRevision }] }),
                            resolveRuntimeSourceIdentity: async () => identity, resolvePersistenceTargets: async () => [target],
                        });
                        return { ok: true, result };
                    });
                    const native = createNativeAgentAccountUsageService({ pluginId: ref.service.pluginId,
                        sessionId: 'muse-session', signal, session: { getMetadataSnapshot: () => ({ connectedServices: {
                            v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'profile', profileId: ref.accountId } },
                        } }) } });
                    const accountUsage: AgentSessionHostServices['accountUsage'] = {
                        resolveSourceContext: native.resolveSourceContext,
                        recordSnapshot: (input, options) => native.recordSnapshot({ ...input, sessionId: 'muse-session' }, options),
                        adoptProvisionalRecord: (input, options) => native.adoptProvisionalRecord({ ...input, sessionId: 'muse-session' }, options),
                    };
                    await recordMuseUsageObservation({ params: { usage }, accountUsage, sessionId: 'muse-session', signal,
                        logger: { debug() {}, warn() {} } });
                    await persistence.flush(5_000);
                    expect(writes, JSON.stringify(writes)).toContainEqual(expect.objectContaining({ status: 200, data: { success: true, source: { status: 'linked' } } }));
                    expect(store.resolveBySource(source)?.meters.map(m => m.utilizationPct)).toEqual([16, 2]);
                } else {
                    await publish({ ...buildProviderAccountUsageSnapshotFromPluginConnectedAccountQuota({ profile,
                        quota: { observedAtMs: 0, limits: [] }, staleAfterMs: 1, usageIdentity: museAccountDescriptor.usageIdentity }),
                        state: 'not_loaded', confidence: 'unknown' });
                    expect(writes, JSON.stringify(writes)).toContainEqual(expect.objectContaining({ status: 200, data: { success: true, source: { status: 'linked' } } }));
                    const response = await app.inject({ method: 'POST', url: '/v4/connect/qualified/quotas/refresh',
                        headers: { 'x-test-user-id': account.id }, payload: { ref } });
                    expect(response.statusCode, response.body).toBe(200);
                    // Deliver the accepted demand at the daemon/native process boundary. The actual
                    // Muse quota owner materializes an OAuth-only home and parses the MSP response.
                    const observation = await readNativeQuota(signal);
                    await publish(buildProviderAccountUsageSnapshotFromPluginConnectedAccountQuota({ profile, quota: observation,
                        staleAfterMs: 1, usageIdentity: museAccountDescriptor.usageIdentity }));
                }
                expect(await readExactQualifiedConnectedServiceUsageSource({ accountId: account.id, source: target.source }))
                    .toMatchObject({ recordId: identity.recordId, source: target.source });
                const response = await readQualifiedConnectedAccountQuotaV4({ token: credentials.token, ref });
                expect(response).not.toBeNull();
                const quota = response && openQualifiedConnectedAccountQuotaResponseV4({ response, expectedRef: ref,
                    material: credentials.encryption });
                expect(quota?.meters.map(m => m.utilizationPct)).toEqual([16, 2]);
                expect(quota?.meters.map(m => m.resetsAt)).toEqual([usage.weekly.resetsAtMs, usage.window.resetsAtMs]);
            } finally { persistence.dispose(); }
        }));
    }

    async function readNativeQuota(signal: AbortSignal) {
        const directory = await mkdtemp(join(tmpdir(), 'happier-muse-usage-msp-'));
        try {
            const login = await readMuseLoginRecording();
            if (!login || typeof login !== 'object' || Array.isArray(login) || !Array.isArray(login.rows)) throw new Error('Invalid login recording');
            const native = await createMuseMspProcessFixture({ auditPath: join(directory, 'audit.json'), recording: { rows: [
                ...login.rows.slice(0, 2), { direction: 'send', message: { jsonrpc: '2.0', id: 100, method: 'usage/refresh', params: {} } },
                { direction: 'recv', message: { jsonrpc: '2.0', id: 100, result: { usage, tierName: 'Subscription', subscriptionActive: true } } },
            ] }, playbackSteps: [{ requestRow: 2, receiveUntilRow: 4 }] });
            const values = new Map(Object.entries({ credentialMode: 'native', accountToken: 'synthetic-oauth-token',
                inferenceKey: 'synthetic-key', nativeMechanism: '"oauth"', nativeApiBaseUrl: 'https://api.meta.ai/v1' }));
            const context = { signal, credentials: { async get(key: string) { return values.get(key) ?? null; } }, services: {
                exec: createStablePluginExecService({ signal, isOccurrenceCurrent: () => true, environment: {},
                    resolvePath: async path => typeof path === 'string' ? path : directory, resolveExecutable: native.resolveExecutable }),
            } } as ConnectedAccountReadContext;
            const quota = await museConnectedAccountRuntime.quota!(context);
            expect(quota.limits.map(l => l.used)).toEqual([16, 2]);
            return quota;
        } finally { await rm(directory, { recursive: true, force: true }); }
    }
});
