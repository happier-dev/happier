import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildProviderAccountUsageRecordId,
    type ConnectedServiceBindingsV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import type {
    ProviderAccountUsageAdoptionV1,
} from '@/daemon/connectedServices/accountUsage/adoption';

import { createNativeAgentAccountUsageService } from './nativeAgentAccountUsage';

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
    beforeEach(() => {
        notifySnapshot.mockReset();
        notifyAdoption.mockReset();
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
        }));
        expect(notifySnapshot).toHaveBeenNthCalledWith(2, expect.objectContaining({
            deriveCredentialFingerprintFromSource: true,
            source: expect.objectContaining({
                serviceId: 'happier.agent.codex/openai-codex',
                profileId: 'profile-2',
                groupId: 'team',
                groupGeneration: 8,
            }),
        }));
        expect(notifySnapshot.mock.calls[0]?.[0].source).not.toHaveProperty('env');
        expect(notifySnapshot.mock.calls[1]?.[0].source).not.toHaveProperty('env');
    });

    it('re-resolves a current session binding for each semantic source address use', async () => {
        notifySnapshot.mockResolvedValue({
            ok: true,
            result: { status: 'recorded' },
        });
        let connectedServices: ConnectedServiceBindingsV1 = {
            v: 1,
            bindingsByServiceId: {
                'happier.agent.codex/openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    serviceId: 'happier.agent.codex/openai-codex',
                    groupId: 'team',
                    profileId: 'profile-1',
                    groupGeneration: 7,
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
            v: 1,
            bindingsByServiceId: {
                'happier.agent.codex/openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    serviceId: 'happier.agent.codex/openai-codex',
                    groupId: 'team',
                    profileId: 'profile-2',
                    groupGeneration: 8,
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
                groupGeneration: 7,
            }),
        }));
        expect(notifySnapshot).toHaveBeenNthCalledWith(2, expect.objectContaining({
            source: expect.objectContaining({
                profileId: 'profile-2',
                groupGeneration: 8,
            }),
        }));
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
        });
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
