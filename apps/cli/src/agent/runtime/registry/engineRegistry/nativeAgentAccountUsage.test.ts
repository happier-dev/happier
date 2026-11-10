import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildProviderAccountUsageRecordId,
    type ConnectedServiceBindingsV2,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import type {
    ProviderAccountUsageAdoptionV1,
} from '@/daemon/connectedServices/accountUsage/adoption';

import { canonicalizeAgentAccountUsageSnapshot, createNativeAgentAccountUsageService } from './nativeAgentAccountUsage';

const {
    notifyAdoption,
    notifySnapshot,
} = vi.hoisted(() => ({
    notifyAdoption: vi.fn(),
    notifySnapshot: vi.fn(),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/controlClient')>(),
    notifyDaemonProviderAccountUsageAdoption: notifyAdoption,
    notifyDaemonProviderAccountUsageSnapshot: notifySnapshot,
}));

function createSnapshot(accountSubjectId = 'acct_123'): Omit<ProviderAccountUsageSnapshotV1, 'recordId'> {
    const recordKey: ProviderAccountUsageRecordKeyV1 = {
        providerId: 'openai-codex',
        accountSubjectId,
        subjectKind: 'account',
        quotaScope: 'account',
    };
    return {
        v: 1,
        recordKey,
        providerId: 'openai-codex',
        accountSubject: { kind: 'providerSubject', id: accountSubjectId },
        observedAtMs: 1,
        fetchedAtMs: 1,
        staleAfterMs: 60_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        accountLabel: null,
        planLabel: null,
        meters: [],
    };
}

function createAdoption(): ProviderAccountUsageAdoptionV1 {
    const fromKey: ProviderAccountUsageRecordKeyV1 = {
        providerId: 'openai-codex',
        accountSubjectId: 'provisional:native',
        subjectKind: 'unknown',
        quotaScope: 'account',
    };
    const stableRecordKey: ProviderAccountUsageRecordKeyV1 = {
        providerId: 'openai-codex',
        accountSubjectId: 'acct_123',
        subjectKind: 'account',
        quotaScope: 'account',
    };
    return {
        providerId: 'openai-codex',
        fromRecordId: buildProviderAccountUsageRecordId(fromKey),
        toRecordId: buildProviderAccountUsageRecordId(stableRecordKey),
        stableRecordKey,
        proof: { kind: 'id_token_account_id', issuer: 'chatgpt' },
        observedAtMs: 1,
    };
}

describe('native Agent account-usage host owner', () => {
    it.each([
        ['muse-account', 'happier.agent.muse/muse-account'],
        ['acme.account/usage', 'acme.account/usage'],
        ['openai-codex', 'happier.agent.codex/openai-codex'],
        ['anthropic', 'happier.agent.claude/anthropic'],
    ])('resolves and publishes the selected account for local, qualified and released service address %s', async (address, serviceId) => {
        notifySnapshot.mockResolvedValue({ ok: true, result: { status: 'snapshot_advanced' } });
        const service = createNativeAgentAccountUsageService({
            pluginId: 'happier.agent.muse', sessionId: 'session-1', signal: new AbortController().signal,
            session: { getMetadataSnapshot: () => ({ path: '/workspace', host: 'test-host', homeDir: '/home/test',
                happyHomeDir: '/home/test/.happier', happyLibDir: '/home/test/.happier/lib', happyToolsDir: '/home/test/.happier/tools' }) },
        });
        const source = { serviceId: address, env: {
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{ kind: 'profile', serviceId, profileId: 'selected' }]),
        } };
        expect(await service.resolveSourceContext(source)).toEqual({ serviceId, profileId: 'selected', bindingKind: 'profile' });
        expect(await service.recordSnapshot({ sessionId: 'session-1', snapshot: createSnapshot(), source })).toEqual({ status: 'recorded' });
        expect(notifySnapshot).toHaveBeenCalledWith(expect.objectContaining({
            source: { serviceId, profileId: 'selected', bindingKind: 'profile' }, deriveCredentialFingerprintFromSource: true,
        }), expect.anything());
    });

    it('preserves recovery presentation while retaining action inventory and rejecting malformed details', () => {
        const recoveryCreditDetails = { grant: { remainingCount: 2, appliesToProviderLimitIds: ['weekly'], unavailableReason: 'cooldown' as const } };
        const recoveryCredits = { availableCount: 0, credits: [{ id: 'grant', kind: 'usage_limit_reset' as const, status: 'unknown' as const }] };
        const input = { ...createSnapshot(), recoveryCredits, recoveryCreditDetails };
        const canonical = canonicalizeAgentAccountUsageSnapshot(input);
        expect(canonical?.recoveryCreditDetails).toEqual(recoveryCreditDetails);
        expect(canonical?.recoveryCredits).toEqual(recoveryCredits);
        expect(canonical?.recordId).toBe(buildProviderAccountUsageRecordId(input.recordKey));
        expect(canonicalizeAgentAccountUsageSnapshot({ ...input,
            recoveryCreditDetails: { grant: { ...recoveryCreditDetails.grant, remainingCount: -1 } },
        })).toBeNull();
    });

    beforeEach(() => {
        notifySnapshot.mockReset();
        notifyAdoption.mockReset();
    });

    it('delivers observed provisional credential proof without deriving proof from the saved profile', async () => {
        notifySnapshot.mockResolvedValue({ ok: true, result: { status: 'snapshot_advanced' } });
        const service = createNativeAgentAccountUsageService({ sessionId: 'session-1', signal: new AbortController().signal,
            session: { getMetadataSnapshot: () => ({ path: '/workspace', host: 'test-host', homeDir: '/home/test',
                happyHomeDir: '/home/test/.happier', happyLibDir: '/home/test/.happier/lib', happyToolsDir: '/home/test/.happier/tools' }) },
        });
        const snapshot = createSnapshot('provisional:native');
        const result = await service.recordSnapshot({ sessionId: 'session-1',
            snapshot: { ...snapshot, recordKey: { ...snapshot.recordKey, subjectKind: 'unknown' },
                accountSubject: { kind: 'provisionalLocalSubject', id: 'provisional:native' } },
            source: { serviceId: 'happier.agent.claude/claude-subscription', env: {
                HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{ kind: 'profile', serviceId: 'happier.agent.claude/claude-subscription', profileId: 'work' }]),
            } }, credentialProof: { providerAccountId: 'observed-user', credentialFingerprint: 'sha256:deadbeef' },
        });
        expect(result.status).toBe('recorded');
        expect(notifySnapshot).toHaveBeenCalledWith(expect.objectContaining({ sourceProviderAccountId: 'observed-user', credentialFingerprint: 'sha256:deadbeef' }), expect.anything());
        expect(notifySnapshot.mock.calls[0]?.[0]).not.toHaveProperty('deriveCredentialFingerprintFromSource');
    });

    it('resolves an external service address without exposing currentness witnesses', async () => {
        const service = createNativeAgentAccountUsageService({
            sessionId: 'session-1',
            session: {
                getMetadataSnapshot: () => ({
                    path: '/workspace',
                    host: 'test-host',
                    homeDir: '/home/test',
                    happyHomeDir: '/home/test/.happier',
                    happyLibDir: '/home/test/.happier/lib',
                    happyToolsDir: '/home/test/.happier/tools',
                }),
            },
            signal: new AbortController().signal,
        });

        const source = await service.resolveSourceContext({
            serviceId: 'acme.agent/usage',
            env: {
                HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
                    kind: 'group',
                    serviceId: 'acme.agent/usage',
                    groupId: 'team',
                    activeProfileId: 'profile-1',
                    fallbackProfileId: 'profile-2',
                    generation: 7,
                    policy: null,
                }]),
            },
        });

        expect(source).toEqual({
            serviceId: 'acme.agent/usage',
            profileId: 'profile-1',
            bindingKind: 'group_member',
            groupId: 'team',
        });
        expect(source).not.toHaveProperty('groupGeneration');
        expect(source).not.toHaveProperty('credentialFingerprint');
    });

    it('prefers the current hot-applied session binding over a stale launch selection hint', async () => {
        const service = createNativeAgentAccountUsageService({
            sessionId: 'session-1',
            session: {
                getMetadataSnapshot: () => ({
                    path: '/workspace',
                    host: 'test-host',
                    homeDir: '/home/test',
                    happyHomeDir: '/home/test/.happier',
                    happyLibDir: '/home/test/.happier/lib',
                    happyToolsDir: '/home/test/.happier/tools',
                    connectedServices: {
                        v: 2,
                        bindingsByServiceId: {
                            'happier.agent.claude/claude-subscription': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'team',
                                profileId: 'profile-current',
                            },
                        },
                    } satisfies ConnectedServiceBindingsV2,
                }),
            },
            signal: new AbortController().signal,
        });

        const source = await service.resolveSourceContext({
            serviceId: 'happier.agent.claude/claude-subscription',
            env: {
                HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
                    kind: 'group',
                    serviceId: 'happier.agent.claude/claude-subscription',
                    groupId: 'team',
                    activeProfileId: 'profile-at-launch',
                    fallbackProfileId: 'profile-current',
                    generation: 7,
                    policy: null,
                }]),
            },
        });

        expect(source).toEqual({
            serviceId: 'happier.agent.claude/claude-subscription',
            profileId: 'profile-current',
            bindingKind: 'group_member',
            groupId: 'team',
        });
    });

    it('re-resolves source currentness from its semantic address for every record', async () => {
        notifySnapshot.mockResolvedValue({
            ok: true,
            result: { status: 'recorded' },
        });
        const env: Record<string, string | undefined> = {
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
                kind: 'group',
                serviceId: 'happier.agent.codex/openai-codex',
                groupId: 'team',
                activeProfileId: 'profile-1',
                fallbackProfileId: 'profile-2',
                generation: 7,
                policy: null,
            }]),
        };
        const source = { serviceId: 'happier.agent.codex/openai-codex', env } as const;
        const service = createNativeAgentAccountUsageService({
            sessionId: 'session-1',
            session: {
                getMetadataSnapshot: () => ({
                    path: '/workspace',
                    host: 'test-host',
                    homeDir: '/home/test',
                    happyHomeDir: '/home/test/.happier',
                    happyLibDir: '/home/test/.happier/lib',
                    happyToolsDir: '/home/test/.happier/tools',
                }),
            },
            signal: new AbortController().signal,
        });

        await expect(service.recordSnapshot({
            sessionId: 'session-1',
            snapshot: createSnapshot(),
            source,
        })).resolves.toEqual({ status: 'recorded' });

        env.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON = JSON.stringify([{
            kind: 'group',
            serviceId: 'happier.agent.codex/openai-codex',
            groupId: 'team',
            activeProfileId: 'profile-2',
            fallbackProfileId: 'profile-1',
            generation: 8,
            policy: null,
        }]);
        await expect(service.recordSnapshot({
            sessionId: 'session-1',
            snapshot: createSnapshot(),
            source,
        })).resolves.toEqual({ status: 'recorded' });

        expect(notifySnapshot).toHaveBeenNthCalledWith(1, expect.objectContaining({
            deriveCredentialFingerprintFromSource: true,
            source: expect.objectContaining({
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'profile-1',
                groupId: 'team',
                groupGeneration: 7,
            }),
        }), expect.objectContaining({ timeoutMs: null }));
        expect(notifySnapshot).toHaveBeenNthCalledWith(2, expect.objectContaining({
            deriveCredentialFingerprintFromSource: true,
            source: expect.objectContaining({
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'profile-2',
                groupId: 'team',
                groupGeneration: 8,
            }),
        }), expect.objectContaining({ timeoutMs: null }));
        expect(notifySnapshot.mock.calls[0]?.[0].source).not.toHaveProperty('env');
        expect(notifySnapshot.mock.calls[1]?.[0].source).not.toHaveProperty('env');
    });

    it('re-resolves a current session binding for each semantic source address use', async () => {
        notifySnapshot.mockResolvedValue({
            ok: true,
            result: { status: 'recorded' },
        });
        let connectedServices: ConnectedServiceBindingsV2 = {
            v: 2,
            bindingsByServiceId: {
                'happier.agent.codex/openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'team',
                    profileId: 'profile-1',
                },
            },
        };
        const source = { serviceId: 'happier.agent.codex/openai-codex' } as const;
        const service = createNativeAgentAccountUsageService({
            sessionId: 'session-1',
            session: {
                getMetadataSnapshot: () => ({
                    path: '/workspace',
                    host: 'test-host',
                    homeDir: '/home/test',
                    happyHomeDir: '/home/test/.happier',
                    happyLibDir: '/home/test/.happier/lib',
                    happyToolsDir: '/home/test/.happier/tools',
                    connectedServices,
                }),
            },
            signal: new AbortController().signal,
        });

        await expect(service.recordSnapshot({
            sessionId: 'session-1',
            snapshot: createSnapshot(),
            source,
        })).resolves.toEqual({ status: 'recorded' });

        connectedServices = {
            v: 2,
            bindingsByServiceId: {
                'happier.agent.codex/openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'team',
                    profileId: 'profile-2',
                },
            },
        };
        await expect(service.recordSnapshot({
            sessionId: 'session-1',
            snapshot: createSnapshot(),
            source,
        })).resolves.toEqual({ status: 'recorded' });

        expect(notifySnapshot).toHaveBeenNthCalledWith(1, expect.objectContaining({
            source: expect.objectContaining({
                profileId: 'profile-1',
            }),
        }), expect.objectContaining({ timeoutMs: null }));
        expect(notifySnapshot).toHaveBeenNthCalledWith(2, expect.objectContaining({
            source: expect.objectContaining({
                profileId: 'profile-2',
            }),
        }), expect.objectContaining({ timeoutMs: null }));
    });

    it('delivers only the bound session snapshot and preserves the daemon result', async () => {
        const snapshot = createSnapshot();
        const recordId = buildProviderAccountUsageRecordId(snapshot.recordKey);
        notifySnapshot.mockResolvedValue({
            ok: true,
            result: {
                status: 'snapshot_advanced',
                recordId,
                persisted: true,
            },
        });
        const service = createNativeAgentAccountUsageService({
            sessionId: 'session-1',
            session: {
                getMetadataSnapshot: () => ({
                    path: '/workspace',
                    host: 'test-host',
                    homeDir: '/home/test',
                    happyHomeDir: '/home/test/.happier',
                    happyLibDir: '/home/test/.happier/lib',
                    happyToolsDir: '/home/test/.happier/tools',
                }),
            },
            signal: new AbortController().signal,
        });

        await expect(service.recordSnapshot({
            sessionId: 'other-session',
            snapshot,
        })).resolves.toEqual({
            status: 'rejected',
            reason: 'session_mismatch',
        });
        await expect(service.recordSnapshot({
            sessionId: 'session-1',
            snapshot,
            policyDisposition: 'evidence_only',
        })).resolves.toEqual({
            status: 'recorded',
        });
        expect(notifySnapshot).toHaveBeenCalledOnce();
        expect(notifySnapshot).toHaveBeenCalledWith({
            sessionId: 'session-1',
            snapshot: { ...snapshot, recordId },
            policyDisposition: 'evidence_only',
        }, expect.objectContaining({ timeoutMs: null }));
    });

    it('reports a daemon credential-fingerprint mismatch as a semantic rejection', async () => {
        const snapshot = createSnapshot();
        notifySnapshot.mockResolvedValue({
            ok: true,
            result: {
                status: 'credential_fingerprint_mismatch',
                recordId: buildProviderAccountUsageRecordId(snapshot.recordKey),
                persisted: false,
            },
        });
        const service = createNativeAgentAccountUsageService({
            sessionId: 'session-1',
            session: {
                getMetadataSnapshot: () => ({
                    path: '/workspace',
                    host: 'test-host',
                    homeDir: '/home/test',
                    happyHomeDir: '/home/test/.happier',
                    happyLibDir: '/home/test/.happier/lib',
                    happyToolsDir: '/home/test/.happier/tools',
                }),
            },
            signal: new AbortController().signal,
        });

        await expect(service.recordSnapshot({
            sessionId: 'session-1',
            snapshot,
        })).resolves.toEqual({
            status: 'rejected',
            reason: 'daemon_rejected',
        });
    });

    it('retries an unreachable daemon and settles its pending observation after recovery', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        notifySnapshot.mockResolvedValueOnce({ error: 'No daemon running, no state file found' })
            .mockResolvedValue({ ok: true, result: { status: 'snapshot_advanced' } });
        const service = createNativeAgentAccountUsageService({
            sessionId: 'session-1', signal: controller.signal,
            session: { getMetadataSnapshot: () => ({ path: '/workspace', host: 'test-host', homeDir: '/home/test',
                happyHomeDir: '/home/test/.happier', happyLibDir: '/home/test/.happier/lib', happyToolsDir: '/home/test/.happier/tools' }) },
        });
        try {
            await expect(service.recordSnapshot({ sessionId: 'session-1', snapshot: createSnapshot() }))
                .resolves.toEqual({ status: 'unavailable', reason: 'daemon_unavailable' });

            await vi.advanceTimersByTimeAsync(1_000);
            expect(notifySnapshot).toHaveBeenCalledTimes(2);
            expect(notifySnapshot.mock.calls[1]?.[0]).toEqual(notifySnapshot.mock.calls[0]?.[0]);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(notifySnapshot).toHaveBeenCalledTimes(2);
        } finally {
            controller.abort();
            vi.useRealTimers();
        }
    });

    it('settles a refused intake without automatic retries and accepts a later observation', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        notifySnapshot.mockResolvedValue({
            error: 'Request failed: /provider-account-usage-snapshot, HTTP 503',
            errorCode: 'provider_account_usage_snapshot_intake_failed',
            response: { ok: false, errorCode: 'provider_account_usage_snapshot_intake_failed' },
        });
        const service = createNativeAgentAccountUsageService({
            sessionId: 'session-1', signal: controller.signal,
            session: { getMetadataSnapshot: () => ({ path: '/workspace', host: 'test-host', homeDir: '/home/test',
                happyHomeDir: '/home/test/.happier', happyLibDir: '/home/test/.happier/lib', happyToolsDir: '/home/test/.happier/tools' }) },
        });
        try {
            const result = await service.recordSnapshot({ sessionId: 'session-1', snapshot: createSnapshot() });

            await vi.advanceTimersByTimeAsync(60_000);
            expect(notifySnapshot).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ status: 'rejected', reason: 'daemon_rejected' });

            notifySnapshot.mockResolvedValue({ ok: true, result: { status: 'snapshot_advanced' } });
            await expect(service.recordSnapshot({ sessionId: 'session-1',
                snapshot: { ...createSnapshot(), observedAtMs: 2, fetchedAtMs: 2 },
            })).resolves.toEqual({ status: 'recorded' });
            expect(notifySnapshot).toHaveBeenCalledTimes(2);
        } finally {
            controller.abort();
            vi.useRealTimers();
        }
    });

    it('validates adoption at the session owner and fences work after retirement', async () => {
        const adoption = createAdoption();
        notifyAdoption.mockResolvedValue({
            ok: true,
            result: {
                status: 'adopted',
                fromRecordId: adoption.fromRecordId,
                toRecordId: adoption.toRecordId,
                persisted: true,
            },
        });
        const controller = new AbortController();
        const service = createNativeAgentAccountUsageService({
            sessionId: 'session-1',
            session: {
                getMetadataSnapshot: () => ({
                    path: '/workspace',
                    host: 'test-host',
                    homeDir: '/home/test',
                    happyHomeDir: '/home/test/.happier',
                    happyLibDir: '/home/test/.happier/lib',
                    happyToolsDir: '/home/test/.happier/tools',
                }),
            },
            signal: controller.signal,
        });

        await expect(service.adoptProvisionalRecord({
            sessionId: 'session-1',
            adoption,
        })).resolves.toEqual({
            status: 'adopted',
        });
        controller.abort(new Error('generation retired'));
        await expect(service.recordSnapshot({
            sessionId: 'session-1',
            snapshot: createSnapshot(),
        })).rejects.toThrow('generation retired');
        expect(notifyAdoption).toHaveBeenCalledOnce();
        expect(notifySnapshot).not.toHaveBeenCalled();
    });

    it('rejects adoption proofs that are not provider-owned evidence', async () => {
        const service = createNativeAgentAccountUsageService({
            sessionId: 'session-1',
            session: {
                getMetadataSnapshot: () => ({
                    path: '/workspace',
                    host: 'test-host',
                    homeDir: '/home/test',
                    happyHomeDir: '/home/test/.happier',
                    happyLibDir: '/home/test/.happier/lib',
                    happyToolsDir: '/home/test/.happier/tools',
                }),
            },
            signal: new AbortController().signal,
        });
        const adoption = createAdoption();

        await expect(service.adoptProvisionalRecord({
            sessionId: 'session-1',
            adoption: {
                ...adoption,
                proof: { kind: 'session_subject_match', sessionId: 'session-1' },
            },
        } as never)).resolves.toEqual({
            status: 'rejected',
            reason: 'invalid_adoption',
        });
        expect(notifyAdoption).not.toHaveBeenCalled();
    });
});
