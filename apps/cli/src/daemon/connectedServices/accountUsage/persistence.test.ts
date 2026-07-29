import {
    buildProviderAccountUsageRecordId,
    ConnectedServiceUsageSourceV1Schema,
    FeaturesResponseSchema,
    openConnectedServiceQuotaSnapshotCiphertext,
    openProviderAccountUsageSnapshotCiphertext,
    ProviderAccountUsageRecordKeyV1Schema,
    SealedProviderAccountUsageSnapshotV1Schema,
    type ConnectedServiceUsageSourceV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

const currentServerFeatures: CliServerFeaturesSnapshot = {
    status: 'ready',
    features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: {
            connectedServices: {
                qualifiedAccounts: { protocolVersion: 4 },
            },
        },
    }),
};

const releasedServerV021Features: CliServerFeaturesSnapshot = {
    status: 'ready',
    features: FeaturesResponseSchema.parse({
        features: {
            sharing: {
                pendingQueueV2: { enabled: true },
            },
        },
        capabilities: {},
    }),
};

/**
 * Exact POST body admitted by Remote e67f3751's strict PAU V2 route.
 * Keep this frozen: the predecessor rejects unknown top-level fields.
 */
const RemoteE67ProviderAccountUsagePostBodySchema = z.object({
    recordKey: ProviderAccountUsageRecordKeyV1Schema.optional(),
    sealed: SealedProviderAccountUsageSnapshotV1Schema.extend({
        ciphertext: z.string().min(1).max(200_000),
    }),
    metadata: z.object({
        fetchedAt: z.number().int().nonnegative(),
        staleAfterMs: z.number().int().nonnegative(),
        status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
        materialFingerprint: z.string().min(1).max(256).optional(),
    }).passthrough(),
    source: ConnectedServiceUsageSourceV1Schema.optional(),
}).strict();

type PersistenceScheduler = Readonly<{
    recordInBandSnapshot(
        snapshot: ProviderAccountUsageSnapshotV1,
        options?: Readonly<{ source?: ConnectedServiceUsageSourceV1; sources?: readonly ConnectedServiceUsageSourceV1[] }>,
    ): Promise<
        | Readonly<{ status: 'enqueued'; enqueue: 'accepted' | 'coalesced' }>
        | Readonly<{ status: 'already_persisted'; reason: string }>
    >;
    flush(timeoutMs: number): Promise<void>;
    dispose(): void;
}>;

type PersistenceModule = Readonly<{
    createProviderAccountUsagePersistenceScheduler(params: Readonly<{
        api: {
            getAccountEncryptionMode: () => Promise<'plain' | 'e2ee' | 'unknown'>;
            getServerFeaturesSnapshot: (
                options?: Readonly<{ refresh?: boolean }>,
            ) => Promise<CliServerFeaturesSnapshot | undefined>;
            getProviderAccountUsageWriteRouteAvailability: (
                args: Readonly<{ recordId: string }>,
            ) => Promise<'available' | 'absent' | 'indeterminate'>;
            registerProviderAccountUsageSnapshotPlain?: (args: Readonly<{
                recordId: string;
                source?: ConnectedServiceUsageSourceV1;
                content: { t: 'plain'; v: ProviderAccountUsageSnapshotV1 };
                metadata: {
                    fetchedAt: number;
                    staleAfterMs: number;
                    status: 'ok' | 'unavailable' | 'estimated' | 'error';
                    materialFingerprint?: string;
                };
            }>) => Promise<void>;
            registerProviderAccountUsageSnapshotSealed?: (args: Readonly<{
                recordId: string;
                recordKey: ProviderAccountUsageRecordKeyV1;
                source?: ConnectedServiceUsageSourceV1;
                sealed: { format: 'account_scoped_v1'; ciphertext: string };
                legacyQuotaCompatibility?: {
                    format: 'account_scoped_v1';
                    ciphertext: string;
                };
                metadata: {
                    fetchedAt: number;
                    staleAfterMs: number;
                    status: 'ok' | 'unavailable' | 'estimated' | 'error';
                    materialFingerprint?: string;
                };
            }>) => Promise<void>;
        };
        now: () => number;
        fingerprintKey: Uint8Array;
        credentials?: {
            token: string;
            encryption:
                | { type: 'legacy'; secret: Uint8Array }
                | {
                    type: 'dataKey';
                    publicKey: Uint8Array;
                    machineKey: Uint8Array;
                };
        };
        randomBytes?: (length: number) => Uint8Array;
        minFreshnessMs: number;
        resolveServerContract?: () =>
            | Readonly<{
                mode: 'released_server_v0_2_1';
                sessionConnectionEpoch: number;
                socket: Readonly<{ connected: true }>;
            }>
            | null;
    }>): PersistenceScheduler;
}>;

type RegisterSealedUsageArgs = Parameters<
    NonNullable<
        Parameters<
            PersistenceModule['createProviderAccountUsagePersistenceScheduler']
        >[0]['api']['registerProviderAccountUsageSnapshotSealed']
    >
>[0];

type RegisterPlainUsageArgs = Parameters<
    NonNullable<
        Parameters<
            PersistenceModule['createProviderAccountUsagePersistenceScheduler']
        >[0]['api']['registerProviderAccountUsageSnapshotPlain']
    >
>[0];

async function loadPersistenceModule(): Promise<PersistenceModule | null> {
    return await import('./persistence').catch(() => null) as PersistenceModule | null;
}

function createSnapshot(overrides: Partial<ProviderAccountUsageSnapshotV1> = {}): ProviderAccountUsageSnapshotV1 {
    const recordKey: ProviderAccountUsageRecordKeyV1 = {
        providerId: 'codex',
        accountSubjectId: 'acct_123',
        subjectKind: 'account',
        quotaScope: 'account',
    };
    return {
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: 'codex',
        accountSubject: { kind: 'providerSubject', id: 'acct_123' },
        observedAtMs: 1_000,
        fetchedAtMs: 1_000,
        staleAfterMs: 300_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        meters: [],
        ...overrides,
    };
}

describe('provider account usage persistence scheduler', () => {
    it('persists the first plain snapshot and suppresses unchanged fresh repeats', async () => {
        const module = await loadPersistenceModule();
        expect(module).not.toBeNull();
        const registerProviderAccountUsageSnapshotPlain = vi.fn(async () => {});
        const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
            api: {
                getAccountEncryptionMode: async () => 'plain',
                getServerFeaturesSnapshot: async () => currentServerFeatures,
                getProviderAccountUsageWriteRouteAvailability: async () => 'available',
                registerProviderAccountUsageSnapshotPlain,
            },
            now: () => 1_500,
            fingerprintKey: new Uint8Array(32).fill(3),
            minFreshnessMs: 60_000,
        });

        try {
            const snapshot = createSnapshot();
            await expect(scheduler.recordInBandSnapshot(snapshot)).resolves.toEqual({
                status: 'enqueued',
                enqueue: 'accepted',
            });
            await scheduler.flush(1_000);
            expect(registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith({
                recordId: snapshot.recordId,
                content: { t: 'plain', v: snapshot },
                metadata: {
                    fetchedAt: 1_000,
                    staleAfterMs: 300_000,
                    status: 'ok',
                    materialFingerprint: expect.any(String),
                },
            });
            await expect(scheduler.recordInBandSnapshot(createSnapshot())).resolves.toEqual({
                status: 'already_persisted',
                reason: 'unchanged_fresh',
            });
        } finally {
            scheduler.dispose();
        }
    });

    it('rejects intake when the persistence scheduler cannot take custody', async () => {
        const module = await loadPersistenceModule();
        expect(module).not.toBeNull();
        const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
            api: {
                getAccountEncryptionMode: async () => 'plain',
                getServerFeaturesSnapshot: async () => currentServerFeatures,
                getProviderAccountUsageWriteRouteAvailability: async () => 'available',
                registerProviderAccountUsageSnapshotPlain: async () => {},
            },
            now: () => 1_500,
            fingerprintKey: new Uint8Array(32).fill(3),
            minFreshnessMs: 60_000,
        });
        scheduler.dispose();

        await expect(scheduler.recordInBandSnapshot(createSnapshot()))
            .rejects.toThrow('provider_account_usage_persistence_disposed');
    });

    it('passes explicit connected-service source context through plaintext persistence', async () => {
        const module = await loadPersistenceModule();
        expect(module).not.toBeNull();
        const registerProviderAccountUsageSnapshotPlain = vi.fn(async () => {});
        const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
            api: {
                getAccountEncryptionMode: async () => 'plain',
                getServerFeaturesSnapshot: async () => currentServerFeatures,
                getProviderAccountUsageWriteRouteAvailability: async () => 'available',
                registerProviderAccountUsageSnapshotPlain,
            },
            now: () => 1_500,
            fingerprintKey: new Uint8Array(32).fill(3),
            minFreshnessMs: 0,
        });

        try {
            const snapshot = createSnapshot();
            await scheduler.recordInBandSnapshot(snapshot, {
                source: {
                    serviceId: 'openai-codex',
                    profileId: 'work',
                    bindingKind: 'profile',
                },
            });
            await scheduler.flush(1_000);
            expect(registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith(expect.objectContaining({
                recordId: snapshot.recordId,
                source: {
                    serviceId: 'openai-codex',
                    profileId: 'work',
                    bindingKind: 'profile',
                },
            }));
        } finally {
            scheduler.dispose();
        }
    });

    it('persists every connected-service source relation for a provider-account usage record', async () => {
        const module = await loadPersistenceModule();
        expect(module).not.toBeNull();
        const registerProviderAccountUsageSnapshotPlain = vi.fn(async () => {});
        const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
            api: {
                getAccountEncryptionMode: async () => 'plain',
                getServerFeaturesSnapshot: async () => currentServerFeatures,
                getProviderAccountUsageWriteRouteAvailability: async () => 'available',
                registerProviderAccountUsageSnapshotPlain,
            },
            now: () => 1_500,
            fingerprintKey: new Uint8Array(32).fill(3),
            minFreshnessMs: 0,
        });

        try {
            const snapshot = createSnapshot();
            const profileSource: ConnectedServiceUsageSourceV1 = {
                serviceId: 'openai-codex',
                profileId: 'work',
                bindingKind: 'profile',
            };
            const groupSource: ConnectedServiceUsageSourceV1 = {
                serviceId: 'openai-codex',
                profileId: 'work',
                bindingKind: 'group_member',
                groupId: 'team',
                groupGeneration: 4,
            };
            await scheduler.recordInBandSnapshot(snapshot, {
                sources: [profileSource, groupSource],
            });
            await scheduler.flush(1_000);

            expect(registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(2);
            expect(registerProviderAccountUsageSnapshotPlain).toHaveBeenNthCalledWith(1, expect.objectContaining({
                recordId: snapshot.recordId,
                source: profileSource,
            }));
            expect(registerProviderAccountUsageSnapshotPlain).toHaveBeenNthCalledWith(2, expect.objectContaining({
                recordId: snapshot.recordId,
                source: groupSource,
            }));
        } finally {
            scheduler.dispose();
        }
    });

    it.each([
        {
            name: 'legacy secretbox',
            encryption: {
                type: 'legacy' as const,
                secret: new Uint8Array(32).fill(5),
            },
        },
        {
            name: 'data-key AES',
            encryption: {
                type: 'dataKey' as const,
                publicKey: new Uint8Array(32).fill(7),
                machineKey: new Uint8Array(32).fill(5),
            },
        },
    ])('seals predecessor recovery-credit bytes through $name account encryption', async ({ encryption }) => {
        const module = await loadPersistenceModule();
        expect(module).not.toBeNull();
        const registerProviderAccountUsageSnapshotSealed = vi.fn(
            async (_input: RegisterSealedUsageArgs) => {},
        );
        const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
            api: {
                getAccountEncryptionMode: async () => 'e2ee',
                getServerFeaturesSnapshot: async () => currentServerFeatures,
                getProviderAccountUsageWriteRouteAvailability: async () => 'available',
                registerProviderAccountUsageSnapshotSealed,
            },
            now: () => 1_500,
            fingerprintKey: new Uint8Array(32).fill(4),
            credentials: {
                token: 'token',
                encryption,
            },
            randomBytes: (length) => new Uint8Array(length).fill(6),
            minFreshnessMs: 60_000,
        });

        try {
            const snapshot = createSnapshot({
                recoveryCredits: {
                    availableCount: 1,
                    credits: [{
                        id: 'credit-1',
                        kind: 'rate_limit_reset',
                        status: 'available',
                    }],
                },
            });
            await expect(scheduler.recordInBandSnapshot(snapshot)).resolves.toEqual({
                status: 'enqueued',
                enqueue: 'accepted',
            });
            await scheduler.flush(1_000);
            expect(registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledWith({
                recordId: snapshot.recordId,
                recordKey: snapshot.recordKey,
                sealed: {
                    format: 'account_scoped_v1',
                    ciphertext: expect.any(String),
                },
                metadata: {
                    fetchedAt: 1_000,
                    staleAfterMs: 300_000,
                    status: 'ok',
                    materialFingerprint: expect.any(String),
                },
            });
            const ciphertext =
                registerProviderAccountUsageSnapshotSealed.mock.calls[0]?.[0]
                    .sealed.ciphertext;
            expect(openProviderAccountUsageSnapshotCiphertext({
                material: encryption,
                ciphertext: ciphertext!,
            })?.value).toMatchObject({
                recoveryCredits: {
                    availableCount: 1,
                    credits: [{
                        id: 'credit-1',
                        kind: 'rate_limit_reset',
                        status: 'available',
                    }],
                },
            });
        } finally {
            scheduler.dispose();
        }
    });

    it('passes explicit connected-service source context through sealed persistence', async () => {
        const module = await loadPersistenceModule();
        expect(module).not.toBeNull();
        const registerProviderAccountUsageSnapshotSealed = vi.fn(
            async (_input: RegisterSealedUsageArgs) => {},
        );
        const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
            api: {
                getAccountEncryptionMode: async () => 'e2ee',
                getServerFeaturesSnapshot: async () => currentServerFeatures,
                getProviderAccountUsageWriteRouteAvailability: async () => 'available',
                registerProviderAccountUsageSnapshotSealed,
            },
            now: () => 1_500,
            fingerprintKey: new Uint8Array(32).fill(4),
            credentials: {
                token: 'token',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(5) },
            },
            randomBytes: (length) => new Uint8Array(length).fill(6),
            minFreshnessMs: 0,
        });

        try {
            const snapshot = createSnapshot();
            await scheduler.recordInBandSnapshot(snapshot, {
                source: {
                    serviceId: 'openai-codex',
                    profileId: 'work',
                    bindingKind: 'profile',
                },
            });
            await scheduler.flush(1_000);
            expect(registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledWith(expect.objectContaining({
                recordId: snapshot.recordId,
                recordKey: snapshot.recordKey,
                source: {
                    serviceId: 'openai-codex',
                    profileId: 'work',
                    bindingKind: 'profile',
                },
                legacyQuotaCompatibility: {
                    format: 'account_scoped_v1',
                    ciphertext: expect.any(String),
                },
            }));
            const request =
                registerProviderAccountUsageSnapshotSealed
                    .mock.calls[0]?.[0];
            if (!request) {
                throw new Error(
                    'Expected a sealed PAU persistence request',
                );
            }
            expect(openConnectedServiceQuotaSnapshotCiphertext({
                material: {
                    type: 'legacy',
                    secret: new Uint8Array(32).fill(5),
                },
                ciphertext:
                    request.legacyQuotaCompatibility!.ciphertext,
            })?.value).toMatchObject({
                serviceId: 'openai-codex',
                profileId: 'work',
            });
        } finally {
            scheduler.dispose();
        }
    });

    it('matches the strict e67 PAU V2 POST shape by omitting the current-server compatibility field', async () => {
        const module = await loadPersistenceModule();
        expect(module).not.toBeNull();
        const registerProviderAccountUsageSnapshotSealed =
            vi.fn(async (_input: RegisterSealedUsageArgs) => {});
        const e67ServerFeatures: CliServerFeaturesSnapshot = {
            status: 'ready',
            features: FeaturesResponseSchema.parse({
                features: {},
                capabilities: {
                    connectedServices: {
                        credentialDelete: { revisionGuard: true },
                    },
                },
            }),
        };
        const scheduler =
            module!.createProviderAccountUsagePersistenceScheduler({
                api: {
                    getAccountEncryptionMode: async () => 'e2ee',
                    getServerFeaturesSnapshot: async () =>
                        e67ServerFeatures,
                    getProviderAccountUsageWriteRouteAvailability:
                        async () => 'available',
                    registerProviderAccountUsageSnapshotSealed,
                },
                now: () => 1_500,
                fingerprintKey: new Uint8Array(32).fill(4),
                credentials: {
                    token: 'token',
                    encryption: {
                        type: 'legacy',
                        secret: new Uint8Array(32).fill(5),
                    },
                },
                randomBytes: (length) =>
                    new Uint8Array(length).fill(6),
                minFreshnessMs: 0,
            });

        try {
            await scheduler.recordInBandSnapshot(createSnapshot(), {
                source: {
                    serviceId: 'openai-codex',
                    profileId: 'work',
                    bindingKind: 'profile',
                },
            });
            await scheduler.flush(1_000);

            expect(
                registerProviderAccountUsageSnapshotSealed,
            ).toHaveBeenCalledOnce();
            const request =
                registerProviderAccountUsageSnapshotSealed.mock.calls[0]![0];
            expect(request).not.toHaveProperty(
                'legacyQuotaCompatibility',
            );
            expect(Object.keys(request).sort()).toEqual([
                'metadata',
                'recordId',
                'recordKey',
                'sealed',
                'source',
            ]);
            expect(
                RemoteE67ProviderAccountUsagePostBodySchema.safeParse({
                    recordKey: request.recordKey,
                    source: request.source,
                    sealed: request.sealed,
                    metadata: request.metadata,
                }).success,
            ).toBe(true);
        } finally {
            scheduler.dispose();
        }
    });

    it('does not emit a kind-4 shadow without generated released-peer proof', async () => {
        const module = await loadPersistenceModule();
        expect(module).not.toBeNull();
        const registerProviderAccountUsageSnapshotSealed =
            vi.fn(async (
                _input: RegisterSealedUsageArgs,
            ) => {});
        const scheduler =
            module!.createProviderAccountUsagePersistenceScheduler({
                api: {
                    getAccountEncryptionMode:
                        async () => 'e2ee',
                    getServerFeaturesSnapshot:
                        async () => currentServerFeatures,
                    getProviderAccountUsageWriteRouteAvailability:
                        async () => 'available',
                    registerProviderAccountUsageSnapshotSealed,
                },
                now: () => 1_500,
                fingerprintKey: new Uint8Array(32).fill(4),
                credentials: {
                    token: 'token',
                    encryption: {
                        type: 'dataKey',
                        publicKey:
                            new Uint8Array(32).fill(7),
                        machineKey:
                            new Uint8Array(32).fill(5),
                    },
                },
                randomBytes: (length) =>
                    new Uint8Array(length).fill(6),
                minFreshnessMs: 0,
            });

        try {
            await scheduler.recordInBandSnapshot(createSnapshot(), {
                source: {
                    serviceId: 'github',
                    profileId: 'work',
                    bindingKind: 'profile',
                },
            });
            await scheduler.flush(1_000);
            expect(
                registerProviderAccountUsageSnapshotSealed,
            ).toHaveBeenCalledOnce();
            expect(
                registerProviderAccountUsageSnapshotSealed
                    .mock.calls[0]![0],
            ).not.toHaveProperty('legacyQuotaCompatibility');
        } finally {
            scheduler.dispose();
        }
    });

    it('refuses exact v0.2.1 before any plaintext quota write', async () => {
        const module = await loadPersistenceModule();
        expect(module).not.toBeNull();
        const registerModern = vi.fn(async () => {});
        let serverFeatures = releasedServerV021Features;
        let routeAvailability: 'available' | 'absent' = 'absent';
        let serverContract: Readonly<{
            mode: 'released_server_v0_2_1';
            sessionConnectionEpoch: number;
            socket: Readonly<{ connected: true }>;
        }> | null = {
            mode: 'released_server_v0_2_1',
            sessionConnectionEpoch: 7,
            socket: { connected: true },
        };
        const getServerFeaturesSnapshot = vi.fn(async () => serverFeatures);
        const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
            api: {
                getAccountEncryptionMode: async () => 'plain',
                getServerFeaturesSnapshot,
                getProviderAccountUsageWriteRouteAvailability: async () => routeAvailability,
                registerProviderAccountUsageSnapshotPlain: registerModern,
            },
            now: () => 1_500,
            fingerprintKey: new Uint8Array(32).fill(3),
            minFreshnessMs: 0,
            resolveServerContract: () => serverContract,
        });

        try {
            const snapshot = createSnapshot();
            await scheduler.recordInBandSnapshot(snapshot, {
                source: {
                    serviceId: 'openai-codex',
                    profileId: 'work',
                    bindingKind: 'profile',
                },
            });
            await scheduler.flush(1_000);

            expect(getServerFeaturesSnapshot).toHaveBeenCalledWith({ refresh: true });
            expect(registerModern).not.toHaveBeenCalled();

            serverFeatures = currentServerFeatures;
            routeAvailability = 'available';
            serverContract = null;
            await expect(scheduler.recordInBandSnapshot(snapshot, {
                source: {
                    serviceId: 'openai-codex',
                    profileId: 'work',
                    bindingKind: 'profile',
                },
            })).resolves.toEqual({
                status: 'enqueued',
                enqueue: 'accepted',
            });
            await scheduler.flush(1_000);
            expect(registerModern).toHaveBeenCalledOnce();
        } finally {
            scheduler.dispose();
        }
    });

    it('refuses exact v0.2.1 before any E2EE quota write', async () => {
        const module = await loadPersistenceModule();
        expect(module).not.toBeNull();
        const registerModern = vi.fn(
            async (_input: RegisterSealedUsageArgs) => {},
        );
        const encryption = {
            type: 'dataKey' as const,
            publicKey: new Uint8Array(32).fill(7),
            machineKey: new Uint8Array(32).fill(5),
        };
        const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
            api: {
                getAccountEncryptionMode: async () => 'e2ee',
                getServerFeaturesSnapshot: async () => releasedServerV021Features,
                getProviderAccountUsageWriteRouteAvailability: async () => 'absent',
                registerProviderAccountUsageSnapshotSealed: registerModern,
            },
            now: () => 1_500,
            fingerprintKey: new Uint8Array(32).fill(4),
            credentials: { token: 'token', encryption },
            randomBytes: (length) => new Uint8Array(length).fill(6),
            minFreshnessMs: 0,
            resolveServerContract: () => ({
                mode: 'released_server_v0_2_1',
                sessionConnectionEpoch: 7,
                socket: { connected: true },
            }),
        });

        try {
            await scheduler.recordInBandSnapshot(createSnapshot(), {
                source: {
                    serviceId: 'openai-codex',
                    profileId: 'work',
                    bindingKind: 'profile',
                },
            });
            await scheduler.flush(1_000);

            expect(registerModern).not.toHaveBeenCalled();
        } finally {
            scheduler.dispose();
        }
    });

    it('does not fall back after an ambiguous modern PAU failure', async () => {
        const module = await loadPersistenceModule();
        expect(module).not.toBeNull();
        const registerModern = vi.fn(async (
            _input: RegisterPlainUsageArgs,
        ) => {
            throw new Error('response lost after server commit');
        });
        const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
            api: {
                getAccountEncryptionMode: async () => 'plain',
                getServerFeaturesSnapshot: async () => currentServerFeatures,
                getProviderAccountUsageWriteRouteAvailability: async () => 'available',
                registerProviderAccountUsageSnapshotPlain: registerModern,
            },
            now: () => 1_500,
            fingerprintKey: new Uint8Array(32).fill(3),
            minFreshnessMs: 0,
        });

        try {
            await scheduler.recordInBandSnapshot(createSnapshot(), {
                source: {
                    serviceId: 'openai-codex',
                    profileId: 'work',
                    bindingKind: 'profile',
                },
            });
            await scheduler.flush(1_000);
            expect(
                registerModern.mock.calls.length,
            ).toBeGreaterThan(0);
            for (const call of registerModern.mock.calls) {
                expect(call[0]).toMatchObject({
                    recordId: createSnapshot().recordId,
                });
            }
        } finally {
            scheduler.dispose();
        }
    });
});
