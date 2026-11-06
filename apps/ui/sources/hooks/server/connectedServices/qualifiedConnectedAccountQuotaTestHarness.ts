import { vi } from 'vitest';
import { createMachineFixture, createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { ChangesResponseSchema, CurrentCursorResponseSchema } from '@happier-dev/protocol/changes';
import {
    ConnectedAccountControlCommandRequestSchema,
    CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
    QualifiedConnectedAccountQuotaResponseV4Schema,
    QualifiedConnectedAccountRefSchema,
    parseQualifiedConnectedAccountV4StructuredQueryValue,
    buildProviderAccountUsageRecordId,
    ProviderAccountUsageSnapshotV1Schema,
    type ProviderAccountUsageSnapshotV1,
    type ConnectedAccountDaemonControlResponse,
    type QualifiedConnectedAccountRef,
    type QualifiedConnectedAccountQuotaSnapshotV4,
} from '@happier-dev/protocol';

export const quotaTestRef = { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, accountId: 'work' };
export const quotaTestSnapshot: QualifiedConnectedAccountQuotaSnapshotV4 = {
    v: 1, ref: quotaTestRef, activeAccountId: 'provider-work', fetchedAt: 1, staleAfterMs: 60_000,
    planLabel: 'Pro', accountLabel: null, meters: [],
};

export function quotaTestResponse(snapshot = quotaTestSnapshot, status: 'ok' | 'error' = 'ok', refreshRequestedAt?: number) {
    return QualifiedConnectedAccountQuotaResponseV4Schema.parse({
        ref: snapshot.ref,
        sourceResolution: {
            source: { ref: snapshot.ref, bindingKind: 'account' },
            recordId: buildProviderAccountUsageRecordId({ providerId: 'anthropic', accountSubjectId: 'provider-work', subjectKind: 'account', quotaScope: 'account' }),
            providerAccountId: snapshot.activeAccountId, fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs,
        },
        content: { t: 'plain', v: snapshot },
        metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status,
            ...(refreshRequestedAt === undefined ? {} : { refreshRequestedAt }) },
    });
}

export function quotaTestProviderUsageSnapshot(nowMs = Date.now()): ProviderAccountUsageSnapshotV1 {
    const recordKey = { providerId: 'anthropic', accountSubjectId: 'provider-work', subjectKind: 'account', quotaScope: 'account' } as const;
    return ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordKey, recordId: buildProviderAccountUsageRecordId(recordKey),
        providerId: recordKey.providerId, accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
        observedAtMs: nowMs, fetchedAtMs: nowMs, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed',
        state: 'loaded_data', meters: [{ meterId: 'weekly', label: 'Weekly', used: 40, limit: 100, unit: 'count',
            utilizationPct: null, remainingPct: 60, resetsAt: null, status: 'ok', confidence: 'exact' }] });
}

export function quotaTestProviderUsageResponse(snapshot = quotaTestProviderUsageSnapshot()) {
    return { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: snapshot.fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs, status: 'ok' }, sources: [] };
}

/** Genuine HTTP and socket boundaries; Account lifetime, selectors and Actions stay real. */
export async function createQualifiedQuotaTestHarness(options: Readonly<{
    serverUrl?: string;
    serverIdentityId?: string;
    snapshot?: QualifiedConnectedAccountQuotaSnapshotV4;
    credentials?: AuthCredentials;
    accountMode?: 'plain' | 'e2ee';
    /** A successful predecessor feature response has no qualified-accounts capability. */
    qualifiedAccountsProtocol?: 4 | null;
    request?: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['request']>;
    configureSocket?: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['configureSocket']>;
}> = {}) {
    const serverUrl = options.serverUrl ?? 'https://qualified-quota-fixture.test';
    const serverIdentityId = options.serverIdentityId ?? 'srv_qualified_quota_fixture';
    const requests: Array<{ path: string; method: string }> = [];
    const features = vi.fn(async () => Response.json(createRootLayoutFeaturesResponse({
        capabilities: { serverIdentity: { serverIdentityId }, connectedServices: {
            credentialDelete: { revisionGuard: true },
            ...(options.qualifiedAccountsProtocol === null ? {} : { qualifiedAccounts: { protocolVersion: 4 } }),
        } },
    })));
    const read = vi.fn(async (_ref: QualifiedConnectedAccountRef): Promise<Response> => new Response(JSON.stringify(quotaTestResponse(options.snapshot)), { status: 200 }));
    const refresh = vi.fn(async (_ref: QualifiedConnectedAccountRef): Promise<Response> => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const usageRead = vi.fn(async (_recordId: string): Promise<Response> => Response.json(quotaTestProviderUsageResponse()));
    const controls: Array<{ machineId: string; command: unknown }> = [];
    const control = vi.fn(async (service: QualifiedConnectedAccountRef['service']): Promise<ConnectedAccountDaemonControlResponse> => ({
        status: 'described', service,
        descriptor: { id: service.localId, title: 'Quota service', authentication: { defaultModeId: 'manual', modes: [{
            id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string', minLength: 1 } }],
        }] } },
        occurrenceId: 'occurrence-1', sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-1', installSource: 'npm' },
        accounts: [], operationTransport: { kind: 'v4' },
    }));
    const account = await restoreServerAccountForTest({ serverUrl, serverIdentityId, accountId: 'quota-account', credentials: options.credentials,
        configureSocket: options.configureSocket,
        request: async (input, init) => {
            const url = new URL(String(input));
            requests.push({ path: url.pathname, method: init?.method ?? 'GET' });
            if (url.pathname === '/v1/features') return features();
            const customResponse = await options.request?.(input, init);
            if (customResponse) return customResponse;
            // A restored Home can finish reconnect catch-up after the quota read.
            // Serve its real empty frontier so a missing fixture route does not
            // trigger a fallback snapshot refresh and unrelated quota invalidation.
            if (url.pathname === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
            if (url.pathname === '/v2/changes') return Response.json(ChangesResponseSchema.parse({ changes: [], nextCursor: 0 }));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: options.accountMode ?? 'plain', updatedAt: 0 });
            // Real reconnect catch-up must see the same live census as initial fixture admission.
            if (url.pathname === '/v1/machines') return Response.json([
                createPlainMachineRowFixture({ id: 'machine-first', accountId: 'quota-account' }),
                createPlainMachineRowFixture({ id: 'machine-selected', accountId: 'quota-account' }),
            ]);
            if (url.pathname === '/v4/connect/qualified/provider-account-usage/record') return usageRead(url.searchParams.get('recordId')!);
            if (url.pathname === '/v4/connect/qualified/quotas' && (init?.method ?? 'GET') === 'GET') {
                return read(parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountRefSchema, url.searchParams.get('ref')!));
            }
            if (url.pathname === '/v4/connect/qualified/quotas/refresh') {
                return refresh(QualifiedConnectedAccountRefSchema.parse(JSON.parse(String(init?.body)).ref));
            }
            return new Response('{}', { status: 404 });
        },
    });
    const active = getActiveServerSnapshot();
    storage.getState().activateProfileScope({ serverId: active.serverId, accountId: 'quota-account' });
    await storage.getState().activateSettingsScope({ serverId: active.serverId, accountId: 'quota-account' });
    storage.getState().applyProfile({ ...profileDefaults, id: 'quota-account' });
    storage.getState().applySettings({ ...settingsDefaults, machineAdministrationTargetsLocalV1: {
        [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts]: { serverIdentityId: account.home.serverIdentityId!, machineId: 'machine-selected' },
    } }, 1);
    storage.getState().applyMachines([
        createMachineFixture({ id: 'machine-first', activeAt: Date.now(), isShared: false }),
        createMachineFixture({ id: 'machine-selected', activeAt: Date.now(), isShared: false }),
    ], true, { sourceServerId: active.serverId });
    storage.setState({ isDataReady: true });
    const socket = vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async <R, A>(machineId: string, method: string, payload: A,
        options?: Parameters<typeof apiSocket.machineRPC>[3]): Promise<R> => {
        options?.onIssued?.();
        if (method !== CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD) throw new Error(`Unexpected quota RPC: ${method}`);
        const request = ConnectedAccountControlCommandRequestSchema.parse(payload);
        if (request.machineId !== machineId || request.command.operation !== 'describeService') throw new Error('Unexpected quota control command');
        controls.push({ machineId, command: request.command });
        return await control(request.command.service) as R;
    });
    function context(ref = quotaTestRef) {
        const current = getActiveServerSnapshot();
        return { credentials: account.credentials, ref,
            credentialScope: [current.serverId, String(current.generation), resolveAuthCredentialsScopeKey(account.credentials)].join('\u0000'),
            serverBasis: { serverId: current.serverId, generation: current.generation },
        };
    }
    return { account, read, usageRead, refresh, control, controls, socket, context, features, requests,
        async dispose() { socket.mockRestore(); await account.dispose(); storage.getState().clearProfileScope(); },
    };
}
