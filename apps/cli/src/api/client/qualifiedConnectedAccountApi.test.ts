import axios from "axios";
import { buildProviderAccountUsageRecordId } from "@happier-dev/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from "@/api/clientCompatibility/cliClientCompatibility";

import {
    acquireQualifiedConnectedAccountRefreshLeaseV4,
    deleteQualifiedConnectedAccountCredentialV4,
    listQualifiedConnectedAccountGroupsV4,
    listQualifiedConnectedAccountsV4,
    mutateQualifiedConnectedAccountCredentialHealthV4,
    mutateQualifiedConnectedAccountConfigurationV4,
    readQualifiedConnectedAccountConfigurationV4,
    readQualifiedConnectedAccountCredentialV4,
    readQualifiedConnectedAccountGroupV4,
    readQualifiedConnectedAccountQuotaV4,
    readQualifiedProviderAccountUsageRecordV4,
    requestQualifiedProviderAccountUsageRefreshV4,
    resolveQualifiedProviderAccountUsageSourceV4,
    requestQualifiedConnectedAccountQuotaRefreshV4,
    QualifiedConnectedAccountCredentialConflictError,
    QualifiedConnectedAccountCompatibilityError,
    QualifiedConnectedAccountGroupConflictError,
    QualifiedProviderAccountUsageReadConflictError,
    mutateQualifiedConnectedAccountCredentialV4,
    updateQualifiedConnectedAccountGroupRuntimeStateV4,
    setQualifiedConnectedAccountGroupActiveAccountV4,
    unlinkQualifiedConnectedAccountQuotaV4,
    writeQualifiedProviderAccountUsageV4,
} from "./qualifiedConnectedAccountApi";

vi.mock("axios", () => ({
    default: {
        defaults: {},
        get: vi.fn(),
        patch: vi.fn(),
        post: vi.fn(),
        delete: vi.fn(),
    },
}));
vi.mock("./serverHttpBaseUrl", () => ({
    resolveServerHttpBaseUrl: () => "https://server.example",
}));
vi.mock("./connectedServicesServerApiTimeout", () => ({
    resolveConnectedServicesServerApiTimeoutMs: () => 1_000,
}));

const service = {
    pluginId: "example.connected-accounts",
    localId: "service/with/path",
} as const;

/**
 * Answers like the real Axios boundary: a status the caller's `validateStatus`
 * does not accept is raised as an error instead of returned. Without this the
 * endpoint could stop accepting 409 and every assertion below would still pass
 * while production went back to discarding the conflict body.
 */
function mockAxiosMutationOnce(response: Readonly<{ status: number; data: unknown }>, method: "post" | "patch" = "post"): void {
    vi.mocked(axios[method]).mockImplementationOnce(async (
        _url: unknown,
        _body: unknown,
        config?: { validateStatus?: ((status: number) => boolean) | null },
    ) => {
        if (config?.validateStatus && !config.validateStatus(response.status)) {
            const error = new Error(`Request failed with status code ${response.status}`) as Error & {
                response: typeof response;
                status: number;
            };
            error.name = "AxiosError";
            error.response = response;
            error.status = response.status;
            throw error;
        }
        return response;
    });
}

describe("qualified Connected Account V4 API", () => {
    it('requests only exact qualified account summaries and skips an empty demand', async () => {
        const accounts = [{ service, accountId: 'work' }, {
            service: { ...service, localId: 'second' }, accountId: 'work',
        }];
        const signal = new AbortController().signal;
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { accounts: [] } });
        await expect(listQualifiedConnectedAccountsV4({ token: 'fixture', accounts, signal }))
            .resolves.toEqual({ accounts: [] });
        expect(axios.get).toHaveBeenCalledTimes(1);
        const [url, config] = vi.mocked(axios.get).mock.calls[0] ?? [];
        const query = new URL(String(url)).searchParams;
        expect([...query.keys()]).toEqual(['accounts']);
        expect(JSON.parse(query.get('accounts') ?? 'null')).toEqual(accounts);
        expect(config?.signal).toBe(signal);
        await expect(listQualifiedConnectedAccountsV4({ token: 'fixture', accounts: [] }))
            .resolves.toEqual({ accounts: [] });
        expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('attributes qualified-list reads through the existing request-purpose header', async () => {
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { service, accounts: [] } });
        await listQualifiedConnectedAccountsV4({ token: 'fixture', service });
        expect(vi.mocked(axios.get).mock.calls[0]?.[1]?.headers).toMatchObject({
            'X-Happier-Request-Purpose': 'connected-accounts:qualification',
        });
    });

    it('attributes credential, configuration and quota reads without adding or skipping requests', async () => {
        vi.mocked(axios.get).mockResolvedValue({ status: 404, data: {} });
        const ref = { service, accountId: 'work' };
        await readQualifiedConnectedAccountCredentialV4({ token: 'fixture', ref,
            requestPurpose: 'connected-accounts:purpose-binding' });
        await readQualifiedConnectedAccountConfigurationV4({ token: 'fixture', target: { kind: 'account', ref },
            requestPurpose: 'connected-accounts:persistence' });
        await readQualifiedConnectedAccountQuotaV4({ token: 'fixture', ref,
            requestPurpose: 'connected-accounts:quota-qualification' });
        expect(vi.mocked(axios.get).mock.calls.map(([, config]) => config?.headers?.['X-Happier-Request-Purpose']))
            .toEqual(['connected-accounts:purpose-binding', 'connected-accounts:persistence', 'connected-accounts:quota-qualification']);
    });

    it('retains request-scoped usage authorization while attributing all usage reads', async () => {
        const { readQualifiedProviderAccountUsageHistoryV4 } = await import('./qualifiedConnectedAccountApi');
        vi.mocked(axios.get).mockResolvedValue({ status: 404, data: {} });
        const recordId = buildProviderAccountUsageRecordId({ providerId: 'codex', accountSubjectId: 'account',
            subjectKind: 'account', quotaScope: 'account' });
        const transport = { token: 'fixture', requestPurpose: 'connected-accounts:quota-qualification' as const,
            authorizeRequest: () => ({ Authorization: 'Bearer request-scoped-fixture', 'X-Existing-Authority': 'fixture' }) };
        await resolveQualifiedProviderAccountUsageSourceV4({ ...transport, source: { ref: { service, accountId: 'work' }, bindingKind: 'account' } });
        await readQualifiedProviderAccountUsageRecordV4({ ...transport, recordId });
        await readQualifiedProviderAccountUsageHistoryV4({ ...transport, query: { recordId, history: { range: { startAtMs: 0, endAtMs: 1 }, pageSize: 1 } } });
        expect(axios.get).toHaveBeenCalledTimes(3);
        for (const [, config] of vi.mocked(axios.get).mock.calls) expect(config?.headers).toMatchObject({
            Authorization: 'Bearer request-scoped-fixture', 'X-Existing-Authority': 'fixture',
            'X-Happier-Request-Purpose': 'connected-accounts:quota-qualification',
        });
    });

    it.each(['accounts', 'groups', 'group', 'credential', 'configuration'] as const)(
        'classifies malformed %s responses without retaining their payload', async kind => {
            vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { private: 'secret-payload' } });
            const ref = { service, accountId: 'work' };
            const request = kind === 'accounts' ? listQualifiedConnectedAccountsV4({ token: 'fixture', service })
                : kind === 'groups' ? listQualifiedConnectedAccountGroupsV4({ token: 'fixture', service })
                : kind === 'group' ? readQualifiedConnectedAccountGroupV4({ token: 'fixture', group: { service, groupId: 'work' } })
                : kind === 'credential' ? readQualifiedConnectedAccountCredentialV4({ token: 'fixture', ref })
                : readQualifiedConnectedAccountConfigurationV4({ token: 'fixture', target: { kind: 'account', ref } });
            await expect(request).rejects.toMatchObject({ code: 'connected_account_v4_contract_violation' });
        });
    beforeEach(() => {
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.patch).mockReset();
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.delete).mockReset();
    });

    it('cancels provider usage HTTP without starting acknowledgement reconciliation', async () => {
        const { ProviderAccountUsageSnapshotV1Schema } = await import('@happier-dev/protocol/connect/account-usage-primitives');
        const recordKey = { providerId: 'codex', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
        const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
            providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: 1000, fetchedAtMs: 1000,
            staleAfterMs: 300_000, source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
        const controller = new AbortController();
        const cancelled = new Error('quota loop stopped');
        let release: () => void = () => {};
        let requestAborted = false;
        vi.mocked(axios.post).mockImplementationOnce(async (_url, _body, config) => {
            await new Promise<void>((resolve, reject) => {
                release = resolve;
                config?.signal?.addEventListener?.('abort', () => { requestAborted = true; reject(cancelled); }, { once: true });
            });
            return { status: 200, data: { success: true, source: { status: 'linked' } } };
        });
        const pending = writeQualifiedProviderAccountUsageV4({ token: 'fixture', signal: controller.signal, write: {
            source: { ref: { service, accountId: 'work' }, bindingKind: 'account' },
            expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', expectedConfigurationRevision: null,
            recordId: snapshot.recordId, recordKey, status: 'ok', payloadMode: 'plain_json_v1', snapshot,
        } }).catch(error => error);
        controller.abort(cancelled);
        try {
            expect(requestAborted).toBe(true);
            expect(await pending).toBe(cancelled);
            expect(axios.get).not.toHaveBeenCalled();
        } finally { release(); await pending; }
    });

    it.each(['plain', 'e2ee'] as const)('reconciles a lost usage write acknowledgement in %s mode without resending', async (accountMode) => {
        const { ProviderAccountUsageSnapshotV1Schema } = await import('@happier-dev/protocol/connect/account-usage-primitives');
        const { sealProviderAccountUsageSnapshot } = await import('@happier-dev/protocol/connect/accountUsage');
        const recordKey = { providerId: 'codex', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
        const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
            providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: 1000, fetchedAtMs: 1000,
            staleAfterMs: 300_000, source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data', meters: [] });
        const source = { ref: { service, accountId: 'work' }, bindingKind: 'account' as const };
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const sealed = sealProviderAccountUsageSnapshot({ snapshot, material, randomBytes: length => new Uint8Array(length).fill(2) });
        const write = { source, expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', expectedConfigurationRevision: null,
            recordId: snapshot.recordId, recordKey, status: 'ok', fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs,
            ...(accountMode === 'plain' ? { payloadMode: 'plain_json_v1', snapshot }
                : { payloadMode: 'sealed_account_scoped_v1', sealedPayload: sealed }) };
        const timeout = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        vi.mocked(axios.post).mockRejectedValue(timeout);
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { sources: [source],
            content: accountMode === 'plain' ? { t: 'plain', v: snapshot } : { t: 'encrypted', c: sealed.ciphertext },
            metadata: { status: 'ok', fetchedAt: 1000, staleAfterMs: 300_000 } } });
        await expect(writeQualifiedProviderAccountUsageV4({ token: 'token', write, ...(accountMode === 'e2ee' ? { material } : {}) }))
            .resolves.toMatchObject({ success: true, source: { status: 'linked' } });
        expect(axios.post).toHaveBeenCalledTimes(1);
        expect(axios.get).toHaveBeenCalledTimes(1);
        expect(vi.mocked(axios.get).mock.calls[0]?.[1]?.headers).toMatchObject({
            'X-Happier-Request-Purpose': 'connected-accounts:usage-persistence',
        });
        expect(vi.mocked(axios.post).mock.calls[0]?.[1]).not.toHaveProperty('material');
        vi.mocked(axios.get).mockRejectedValue(new Error('reconciliation read unavailable'));
        await expect(writeQualifiedProviderAccountUsageV4({ token: 'token', write, ...(accountMode === 'e2ee' ? { material } : {}) }))
            .rejects.toBe(timeout);
    });

    it.each(['conflict', 'timeout'] as const)('does not acknowledge unpersisted content or an unlinked source after %s recovery', async (failure) => {
        const { ProviderAccountUsageSnapshotV1Schema } = await import('@happier-dev/protocol/connect/account-usage-primitives');
        const recordKey = { providerId: 'codex', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
        const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
            providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: 1000, fetchedAtMs: 1000,
            staleAfterMs: 300_000, source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data', meters: [] });
        const source = { ref: { service, accountId: 'work' }, bindingKind: 'account' as const };
        const write = { source, expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', expectedConfigurationRevision: null,
            recordId: snapshot.recordId, recordKey, payloadMode: 'plain_json_v1', status: 'ok', snapshot,
            fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs };
        const conflict = failure === 'conflict'
            ? { response: { status: 503, data: { error: 'database_transaction_conflict_exhausted' } } }
            : Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        vi.mocked(axios.post).mockRejectedValue(conflict);
        for (const record of [
            { content: { t: 'plain', v: { ...snapshot, planLabel: 'different' } }, sources: [source] },
            { content: { t: 'plain', v: snapshot }, sources: [{ ...source, ref: { ...source.ref, accountId: 'other' } }] },
        ]) {
            vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { ...record,
                metadata: { fetchedAt: 1000, staleAfterMs: 300_000, status: 'ok' } } });
            await expect(writeQualifiedProviderAccountUsageV4({ token: 'token', write })).rejects.toBe(conflict);
        }
        expect(axios.post).toHaveBeenCalledTimes(2);
        expect(axios.get).toHaveBeenCalledTimes(2);
    });

    it("preserves retained native review facts and serializes exact removal dispositions", async () => {
        const resource = { managedId: 'retained-id', homeId: 'home', custodianAccountId: 'account', intentRevision: 3,
            controller: { machineId: 'controller', installationId: 'installation' }, provider: { pluginId: 'fixture.compute', localId: 'cloud' },
            allocation: 'may-exist', recovery: { reference: 'native-paid-id', reason: 'manual_recovery' },
            cleanup: { disposition: 'unavailable', reason: 'credential_missing' } };
        // Axios rejects 409 unless the actual HTTP owner opts in to parsing it.
        vi.mocked(axios.delete).mockImplementationOnce(async (_url, config) => {
            if (!config?.validateStatus?.(409)) throw new Error('Request failed with status code 409');
            return { status: 409, data: { error: 'managed_resources_review_required', resources: [resource] } };
        });
        const dispositions = [{ managedId: 'retained-id', expectedIntentRevision: 3, responsibility: 'manual', expectedAllocation: 'may-exist',
            expectedRecovery: { reference: 'native-paid-id', reason: 'manual_recovery' } }];
        await expect(deleteQualifiedConnectedAccountCredentialV4({ token: 'token', deletion: {
            ref: { service, accountId: 'work' }, expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
            cleanupGroupReferences: true, reviewOnly: true, managedResourceDispositions: dispositions,
        } })).rejects.toMatchObject({ code: 'managed_resources_review_required', resources: [resource] });
        const url = new URL(String(vi.mocked(axios.delete).mock.calls[0]?.[0]));
        expect(url.searchParams.get('reviewOnly')).toBe('true');
        expect(JSON.parse(url.searchParams.get('managedResourceDispositions') ?? 'null')).toEqual(dispositions);
    });

    it("uses the shared structured-query codec and validates the response", async () => {
        vi.mocked(axios.get).mockResolvedValue({
            status: 200,
            data: { service, accounts: [] },
        });

        await expect(listQualifiedConnectedAccountsV4({
            token: "token",
            service,
        })).resolves.toEqual({ service, accounts: [] });

        const [url] = vi.mocked(axios.get).mock.calls[0] ?? [];
        expect(url).toContain(
            "/v4/connect/qualified/accounts?service=%7B",
        );
        expect(url).toContain("service%2Fwith%2Fpath");
        const parsed = new URL(String(url));
        expect(parsed.searchParams.getAll("service")).toHaveLength(1);
    });

    it("uses exact structured group list/read queries", async () => {
        vi.mocked(axios.get)
            .mockResolvedValueOnce({
                status: 200,
                data: { groups: [] },
            })
            .mockResolvedValueOnce({
                status: 404,
                data: { error: "connect_group_not_found" },
            });

        await expect(listQualifiedConnectedAccountGroupsV4({
            token: "token",
            service,
        })).resolves.toEqual({ groups: [] });
        await expect(readQualifiedConnectedAccountGroupV4({
            token: "token",
            group: { service, groupId: "primary-group" },
        })).resolves.toBeNull();

        const listUrl = new URL(String(
            vi.mocked(axios.get).mock.calls[0]?.[0],
        ));
        const readUrl = new URL(String(
            vi.mocked(axios.get).mock.calls[1]?.[0],
        ));
        expect(listUrl.pathname).toBe(
            "/v4/connect/qualified/groups",
        );
        expect(listUrl.searchParams.getAll("service")).toHaveLength(1);
        expect(readUrl.pathname).toBe(
            "/v4/connect/qualified/group",
        );
        expect(readUrl.searchParams.getAll("group")).toHaveLength(1);
        expect(readUrl.searchParams.get("group")).toContain(
            "primary-group",
        );
    });

    it("rejects a group read projection for a different qualified identity", async () => {
        vi.mocked(axios.get).mockResolvedValueOnce({
            status: 200,
            data: {
                group: {
                    v: 1,
                    ref: { service, groupId: "other-group" },
                    incarnation: "qualified-group-row-other",
                    displayName: null,
                    policy: {},
                    activeConnectedAccountId: null,
                    generation: 0,
                    runtimeStateRevision: 0,
                    state: {},
                    createdAt: 100,
                    updatedAt: 100,
                    members: [],
                },
            },
        });

        const expectedViolation: Partial<QualifiedConnectedAccountCompatibilityError> = {
            code: "connected_account_v4_contract_violation",
        };

        await expect(readQualifiedConnectedAccountGroupV4({
            token: "token",
            group: { service, groupId: "primary-group" },
        })).rejects.toMatchObject(expectedViolation);
    });

    it("resolves, reads, and refreshes provider-account usage through the V4 record owner", async () => {
        const ref = {
            service,
            accountId: "provider/account",
        } as const;
        const recordKey = {
            providerId: "codex",
            accountSubjectId: "acct_123",
            subjectKind: "account",
            quotaScope: "account",
        } as const;
        const recordId = buildProviderAccountUsageRecordId(recordKey);
        const source = { ref, bindingKind: "account" } as const;
        vi.mocked(axios.get)
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    source,
                    recordId,
                    providerAccountId: recordKey.accountSubjectId,
                    fetchedAt: 100,
                    staleAfterMs: 1_000,
                },
            })
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    content: {
                        t: "plain",
                        v: {
                            v: 1,
                            recordId,
                            recordKey,
                            providerId: recordKey.providerId,
                            accountSubject: {
                                kind: "providerSubject",
                                id: recordKey.accountSubjectId,
                            },
                            observedAtMs: 100,
                            fetchedAtMs: 100,
                            staleAfterMs: 1_000,
                            source: "runtimeSignal",
                            confidence: "confirmed",
                            state: "loaded_data",
                            planLabel: null,
                            accountLabel: null,
                            meters: [],
                        },
                    },
                    metadata: {
                        fetchedAt: 100,
                        staleAfterMs: 1_000,
                        status: "ok",
                    },
                    sources: [source],
                },
            });
        vi.mocked(axios.post).mockResolvedValueOnce({
            status: 200,
            data: { success: true },
        });

        await expect(resolveQualifiedProviderAccountUsageSourceV4({
            token: "token",
            source,
        })).resolves.toMatchObject({ source, recordId });
        await expect(readQualifiedProviderAccountUsageRecordV4({
            token: "token",
            recordId,
        })).resolves.toMatchObject({
            content: { t: "plain" },
            sources: [source],
        });
        vi.mocked(axios.get).mockResolvedValueOnce({
            status: 409,
            data: {
                error:
                    "provider_account_usage_storage_mode_mismatch",
            },
        });
        await expect(readQualifiedProviderAccountUsageRecordV4({
            token: "token",
            recordId,
        })).rejects.toBeInstanceOf(
            QualifiedProviderAccountUsageReadConflictError,
        );
        await expect(requestQualifiedProviderAccountUsageRefreshV4({
            token: "token",
            recordId,
        })).resolves.toEqual({ success: true });

        const sourceUrl = new URL(String(
            vi.mocked(axios.get).mock.calls[0]?.[0],
        ));
        const readUrl = new URL(String(
            vi.mocked(axios.get).mock.calls[1]?.[0],
        ));
        expect(sourceUrl.pathname).toBe(
            "/v4/connect/qualified/provider-account-usage/sources/resolve",
        );
        expect(sourceUrl.searchParams.getAll("source")).toHaveLength(1);
        expect(readUrl.pathname).toBe(
            "/v4/connect/qualified/provider-account-usage/record",
        );
        expect(readUrl.searchParams.get("recordId")).toBe(recordId);
        expect(String(vi.mocked(axios.post).mock.calls[0]?.[0])).toContain(
            "/v4/connect/qualified/provider-account-usage/record/refresh",
        );
        expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toEqual({ recordId });
    });

    it("sets the active qualified group account with runtime-state CAS", async () => {
        const group = {
            v: 1 as const,
            ref: { service, groupId: "primary-group" },
            incarnation: "qualified-group-row-primary",
            displayName: null,
            policy: {},
            activeConnectedAccountId: "provider/account",
            generation: 2,
            runtimeStateRevision: 3,
            state: {},
            createdAt: 100,
            updatedAt: 200,
            members: [],
        };
        vi.mocked(axios.post).mockResolvedValue({
            status: 200,
            data: { group },
        });

        await expect(setQualifiedConnectedAccountGroupActiveAccountV4({
            token: "token",
            mutation: {
                group: group.ref,
                connectedAccountId: "provider/account",
                expectedIncarnation: group.incarnation,
                expectedGeneration: 1,
                expectedRuntimeStateRevision: 2,
                expectedSource: {
                    connectedAccountId: "provider/current",
                    credentialRevision:
                        "csr_abcdefghijklmnopqrstuvwxyz",
                    configurationRevision: null,
                },
                overrideRuntimeCooldown: false,
            },
        })).resolves.toMatchObject(group);

        expect(vi.mocked(axios.post)).toHaveBeenCalledWith(
            "https://server.example/v4/connect/qualified/group/active-account",
            {
                group: group.ref,
                connectedAccountId: "provider/account",
                expectedIncarnation: group.incarnation,
                expectedGeneration: 1,
                expectedRuntimeStateRevision: 2,
                expectedSource: {
                    connectedAccountId: "provider/current",
                    credentialRevision:
                        "csr_abcdefghijklmnopqrstuvwxyz",
                    configurationRevision: null,
                },
                overrideRuntimeCooldown: false,
            },
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: "Bearer token",
                }),
            }),
        );
    });

    it("patches qualified group runtime state and exposes revision conflicts", async () => {
        const group = {
            v: 1 as const,
            ref: { service, groupId: "primary-group" },
            incarnation: "qualified-group-row-primary",
            displayName: null,
            policy: {},
            activeConnectedAccountId: "provider/account",
            generation: 2,
            runtimeStateRevision: 3,
            state: {},
            createdAt: 100,
            updatedAt: 200,
            members: [],
        };
        const patch = {
            service,
            groupId: group.ref.groupId,
            expectedGeneration: group.generation,
            expectedIncarnation: group.incarnation,
            expectedRuntimeStateRevision: 2,
            runtimeState: {
                state: { status: "error" as const },
                memberStates: [{
                    connectedAccountId: "provider/account",
                    state: { status: "error" as const },
                }],
            },
        };
        vi.mocked(axios.patch)
            .mockResolvedValueOnce({
                status: 200,
                data: { group },
            })
            .mockResolvedValueOnce({
                status: 409,
                data: {
                    error:
                        "connect_group_runtime_state_revision_conflict",
                    runtimeStateRevision: 3,
                },
            });

        await expect(updateQualifiedConnectedAccountGroupRuntimeStateV4({
            token: "token",
            patch,
        })).resolves.toMatchObject(group);
        await expect(updateQualifiedConnectedAccountGroupRuntimeStateV4({
            token: "token",
            patch,
        })).rejects.toMatchObject({
            name: "QualifiedConnectedAccountGroupConflictError",
            status: 409,
            code: "connect_group_runtime_state_revision_conflict",
            runtimeStateRevision: 3,
            message:
                "connected_service_auth_group_runtime_state_revision_conflict",
        } satisfies Partial<QualifiedConnectedAccountGroupConflictError>);

        expect(vi.mocked(axios.patch).mock.calls[0]?.[0]).toBe(
            "https://server.example/v4/connect/qualified/group/runtime-state",
        );
        expect(vi.mocked(axios.patch).mock.calls[0]?.[1]).toEqual(patch);
    });

    it("preserves the server's closed credential-conflict discriminator at the HTTP boundary", async () => {
        // Every 409 the credential endpoint can return names a different cause.
        // Collapsing identity/authentication-mode mismatch into one settlement
        // conflict hides the action the caller needs to take.
        const mutation = {
            ref: { service, accountId: "provider/account" },
            authenticationModeId: "token",
            expectedCredentialRevision: null,
            content: { t: "plain" as const, v: { token: "opaque" } },
            metadata: { scopes: [] },
        };
        for (const body of [
            { error: "connect_reconnect_provider_identity_mismatch" },
            { error: "connect_authentication_mode_mismatch" },
            { error: 'connect_credential_mutation_superseded', reason: 'credential_revision_mismatch',
                credentialRevision: null, configurationRevision: null },
        ] as const) {
            mockAxiosMutationOnce({ status: 409, data: body });
            await expect(mutateQualifiedConnectedAccountCredentialV4({
                token: "token",
                mutation,
            })).rejects.toMatchObject({
                name: "QualifiedConnectedAccountCredentialConflictError",
                status: 409,
                // The daemon's status-based policies read `response.status`;
                // keep the Axios-like shape so an unmapped cause still lands on
                // the shared 409 path instead of escaping as an unknown error.
                response: { status: 409 },
                code: body.error,
                ...('reason' in body ? { reason: body.reason } : {}),
            } satisfies Partial<QualifiedConnectedAccountCredentialConflictError>);
        }

        mockAxiosMutationOnce({ status: 409, data: { error: "not-a-known-code" } });
        await expect(mutateQualifiedConnectedAccountCredentialV4({
            token: "token",
            mutation,
        })).rejects.toMatchObject({
            name: "QualifiedConnectedAccountCredentialConflictError",
            status: 409,
            code: "connected_account_credential_conflict_response_invalid",
        });
    });

    it.each([
        { body: { error: 'connect_credential_mutation_superseded', reason: 'credential_revision_mismatch',
            credentialRevision: null, configurationRevision: null },
          diagnostic: 'connect_credential_mutation_superseded:credential_revision_mismatch' },
        { body: { error: 'connect_credential_unsupported_format' }, diagnostic: 'connect_credential_unsupported_format' },
        { body: { error: 'private-secret', reason: 'private-account', token: 'private-token' },
          diagnostic: 'connected_account_credential_conflict_response_invalid' },
    ])('preserves only the closed health HTTP409 cause: $diagnostic', async ({ body, diagnostic }) => {
        mockAxiosMutationOnce({ status: 409, data: body }, "patch");
        const error = await mutateQualifiedConnectedAccountCredentialHealthV4({
            token: 'fixture-token', patch: { ref: { service, accountId: 'fixture-account' },
                expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', expectedConfigurationRevision: null,
                health: { v: 1, status: 'connected', reconnectRequired: false } },
        }).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(QualifiedConnectedAccountCredentialConflictError);
        expect(error).toMatchObject({ diagnosticCode: diagnostic, message: diagnostic });
        expect(JSON.stringify(error)).not.toMatch(/private-secret|private-account|private-token|fixture-token|fixture-account/);
    });

    it("reads exact credential and configuration snapshots and applies configuration CAS", async () => {
        const ref = { service, accountId: "provider/account" };
        const target = { kind: "account" as const, ref };
        const credential = {
            ref,
            authenticationModeId: "token",
            revisionSemantics: "revisioned" as const,
            credentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
            configurationRevision: "configuration-revision",
            content: { t: "plain" as const, v: { token: "opaque" } },
            metadata: { scopes: [] },
        };
        const configuration = {
            target,
            authenticationModeId: "token",
            revisionSemantics: "revisioned" as const,
            credentialRevision: credential.credentialRevision,
            configurationRevision: "configuration-revision",
            configurationContent: {
                t: "plain" as const,
                v: { region: "eu" },
            },
        };
        vi.mocked(axios.get)
            .mockResolvedValueOnce({ status: 200, data: credential })
            .mockResolvedValueOnce({ status: 200, data: configuration });
        vi.mocked(axios.patch).mockResolvedValue({
            status: 200,
            data: {
                success: true,
                credentialRevision: credential.credentialRevision,
                configurationRevision: "next-configuration-revision",
            },
        });

        await expect(readQualifiedConnectedAccountCredentialV4({
            token: "token",
            ref,
        })).resolves.toEqual(credential);
        await expect(readQualifiedConnectedAccountConfigurationV4({
            token: "token",
            target,
        })).resolves.toEqual(configuration);
        await expect(mutateQualifiedConnectedAccountConfigurationV4({
            token: "token",
            patch: {
                target,
                expectedCredentialRevision: credential.credentialRevision,
                expectedConfigurationRevision: "configuration-revision",
                replacementContentEnvelope: {
                    t: "plain",
                    v: { region: "us" },
                },
            },
        })).resolves.toEqual({
            success: true,
            credentialRevision: credential.credentialRevision,
            configurationRevision: "next-configuration-revision",
        });
        await expect(mutateQualifiedConnectedAccountCredentialHealthV4({
            token: "token",
            patch: {
                ref,
                expectedCredentialRevision:
                    credential.credentialRevision,
                expectedConfigurationRevision:
                    configuration.configurationRevision,
                health: {
                    v: 1,
                    status: "connected",
                },
            },
        })).resolves.toEqual({
            success: true,
            credentialRevision: credential.credentialRevision,
            configurationRevision: "next-configuration-revision",
        });

        expect(vi.mocked(axios.get).mock.calls[0]?.[0]).toContain(
            "/v4/connect/qualified/credential?ref=%7B",
        );
        expect(vi.mocked(axios.get).mock.calls[1]?.[0]).toContain(
            "/v4/connect/qualified/configuration?target=%7B",
        );
        expect(vi.mocked(axios.patch).mock.calls[0]?.[0]).toContain(
            "/v4/connect/qualified/configuration",
        );
        expect(vi.mocked(axios.patch).mock.calls[1]?.[0]).toContain(
            "/v4/connect/qualified/credential/health",
        );
    });

    it("uses exact V4 credential lease, delete, and quota contracts", async () => {
        const ref = { service, accountId: "provider/account" };
        const credentialRevision = "csr_abcdefghijklmnopqrstuvwxyz";
        const recordKey = {
            providerId: "example-provider",
            accountSubjectId: "provider-account",
            subjectKind: "account" as const,
            quotaScope: "account" as const,
        };
        vi.mocked(axios.post)
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    acquired: true,
                    leaseUntil: 123_456,
                    ownerId: "machine:daemon",
                    credentialRevision,
                },
            })
            .mockResolvedValueOnce({
                status: 200,
                data: { success: true },
            })
            .mockResolvedValueOnce({
                status: 200,
                data: { success: true },
            });
        vi.mocked(axios.delete)
            .mockResolvedValueOnce({
                status: 200,
                data: { success: true },
            })
            .mockResolvedValueOnce({
                status: 200,
                data: { success: true },
            });
        vi.mocked(axios.get).mockResolvedValueOnce({
            status: 200,
            data: {
                ref,
                sourceResolution: {
                    source: { ref, bindingKind: "account" },
                    recordId: buildProviderAccountUsageRecordId(recordKey),
                    providerAccountId: recordKey.accountSubjectId,
                    fetchedAt: 100,
                    staleAfterMs: 1_000,
                },
                content: { t: "encrypted", c: "sealed-quota" },
                metadata: {
                    fetchedAt: 100,
                    staleAfterMs: 1_000,
                    status: "ok",
                },
            },
        });

        await expect(acquireQualifiedConnectedAccountRefreshLeaseV4({
            token: "token",
            lease: {
                ref,
                expectedCredentialRevision: credentialRevision,
                ownerId: "machine:daemon",
                ttlMs: 30_000,
            },
        })).resolves.toMatchObject({ acquired: true, credentialRevision });
        await expect(deleteQualifiedConnectedAccountCredentialV4({
            token: "token",
            deletion: {
                ref,
                expectedCredentialRevision: credentialRevision,
                cleanupGroupReferences: false,
            },
        })).resolves.toEqual({ success: true });
        await expect(readQualifiedConnectedAccountQuotaV4({
            token: "token",
            ref,
        })).resolves.toMatchObject({
            ref,
            content: { t: "encrypted", c: "sealed-quota" },
        });
        await expect(unlinkQualifiedConnectedAccountQuotaV4({
            token: "token",
            ref,
        })).resolves.toEqual({ success: true });
        await expect(requestQualifiedConnectedAccountQuotaRefreshV4({
            token: "token",
            ref,
        })).resolves.toEqual({ success: true });
        await expect(writeQualifiedProviderAccountUsageV4({
            token: "token",
            write: {
                source: { ref, bindingKind: "account" },
                expectedCredentialRevision: credentialRevision,
                expectedConfigurationRevision: null,
                recordId: buildProviderAccountUsageRecordId(recordKey),
                recordKey,
                payloadMode: "sealed_account_scoped_v1",
                status: "refresh_requested",
            },
        })).resolves.toEqual({ success: true });

        expect(String(vi.mocked(axios.post).mock.calls[0]?.[0])).toContain(
            "/credential/refresh-lease",
        );
        expect(String(vi.mocked(axios.delete).mock.calls[0]?.[0])).toContain(
            "cleanupGroupReferences=false",
        );
        for (const [, config] of vi.mocked(axios.delete).mock.calls) {
            expect(config?.headers).toEqual({
                ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                Authorization: "Bearer token",
            });
        }
        expect(String(vi.mocked(axios.get).mock.calls[0]?.[0])).toContain(
            "/v4/connect/qualified/quotas?ref=%7B",
        );
        expect(String(vi.mocked(axios.post).mock.calls[2]?.[0])).toContain(
            "/v4/connect/qualified/provider-account-usage",
        );
    });

    it("normalizes storage-mode conflicts across V4 quota reads and mutations", async () => {
        const ref = { service, accountId: "provider/account" };
        const conflict = {
            error: "provider_account_usage_storage_mode_mismatch",
        };

        vi.mocked(axios.get).mockResolvedValueOnce({
            status: 409,
            data: conflict,
        });
        await expect(readQualifiedConnectedAccountQuotaV4({
            token: "token",
            ref,
        })).rejects.toBeInstanceOf(
            QualifiedProviderAccountUsageReadConflictError,
        );

        vi.mocked(axios.delete).mockResolvedValueOnce({
            status: 409,
            data: conflict,
        });
        await expect(unlinkQualifiedConnectedAccountQuotaV4({
            token: "token",
            ref,
        })).rejects.toBeInstanceOf(
            QualifiedProviderAccountUsageReadConflictError,
        );

        vi.mocked(axios.post).mockResolvedValueOnce({
            status: 409,
            data: conflict,
        });
        await expect(requestQualifiedConnectedAccountQuotaRefreshV4({
            token: "token",
            ref,
        })).rejects.toBeInstanceOf(
            QualifiedProviderAccountUsageReadConflictError,
        );

        vi.mocked(axios.post).mockResolvedValueOnce({
            status: 409,
            data: conflict,
        });
        await expect(requestQualifiedProviderAccountUsageRefreshV4({
            token: "token",
            recordId: buildProviderAccountUsageRecordId({
                providerId: "codex",
                accountSubjectId: "acct-v4",
                subjectKind: "account",
                quotaScope: "account",
            }),
        })).rejects.toBeInstanceOf(
            QualifiedProviderAccountUsageReadConflictError,
        );
    });
});
