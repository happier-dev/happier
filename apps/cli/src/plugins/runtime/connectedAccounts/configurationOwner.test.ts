import { describe, expect, it, vi } from 'vitest';
import {
    PluginConnectedAccountAuthenticationModeV2Schema,
    type PluginConnectedAccountAuthenticationModeV2,
} from '@happier-dev/protocol';

import {
    createConnectedAccountConfigurationOwner,
    type ConnectedAccountConfigurationRecord,
    type ConnectedAccountConfigurationTarget,
} from './configurationOwner';

const service = Object.freeze({ pluginId: 'acme.accounts', localId: 'work' });
const account = Object.freeze({ service, accountId: 'account-a' });
const generation = Object.freeze({
    generation: 'process-7',
    immutableGenerationId: 'sha256:artifact-7',
});

function configuredMode(
    scope: 'service' | 'account',
    changeBehavior: 'refresh' | 'reconnect' = 'refresh',
): PluginConnectedAccountAuthenticationModeV2 {
    return PluginConnectedAccountAuthenticationModeV2Schema.parse({
        id: 'oauth',
        kind: 'oauthDeviceCode',
        outcomeReconciliation: 'providerCheck',
        configuration: {
            scope,
            changeBehavior,
            fields: [{
                id: 'endpoint',
                title: 'Endpoint',
                schema: { type: 'string', minLength: 1 },
                required: true,
            }, {
                id: 'audience',
                title: 'Audience',
                schema: { type: 'string', minLength: 1 },
                default: 'default-audience',
            }, {
                id: 'clientSecret',
                title: 'Client secret',
                schema: { type: 'string', minLength: 1 },
                secret: true,
                required: true,
            }],
        },
    });
}

function createHarness(records: readonly Readonly<{
    target: ConnectedAccountConfigurationTarget;
    record: ConnectedAccountConfigurationRecord;
}>[] = [], options?: Readonly<{
    hasSecret?(secretId: string): Promise<boolean>;
    isGenerationCurrent?(): boolean | Promise<boolean>;
}>) {
    const byTarget = new Map(records.map(({ target, record }) => [JSON.stringify(target), record]));
    const read = vi.fn(async (target: ConnectedAccountConfigurationTarget) => (
        byTarget.get(JSON.stringify(target)) ?? null
    ));
    const replace = vi.fn(async (input: Readonly<{
        target: ConnectedAccountConfigurationTarget;
        expectedRevision: string | null;
        replacement: Omit<ConnectedAccountConfigurationRecord, 'revision'>;
    }>) => {
        const key = JSON.stringify(input.target);
        const current = byTarget.get(key) ?? null;
        if ((current?.revision ?? null) !== input.expectedRevision) {
            return { status: 'conflict' as const };
        }
        const record = Object.freeze({
            ...input.replacement,
            revision: `revision-${byTarget.size + 1}`,
        });
        byTarget.set(key, record);
        return { status: 'committed' as const, record };
    });
    let currentGeneration = true;
    const replaceForControl = vi.fn(async (input: Readonly<{
        target: ConnectedAccountConfigurationTarget;
        expectedRevision: string | null;
        values: ConnectedAccountConfigurationRecord['values'];
        currentSecretRefs: Readonly<Record<string, string>>;
        secretValues: Readonly<Record<string, string>>;
    }>) => {
        const key = JSON.stringify(input.target);
        const current = byTarget.get(key) ?? null;
        if ((current?.revision ?? null) !== input.expectedRevision) {
            return { status: 'conflict' as const };
        }
        const serviceScoped = input.target.kind === 'service';
        const record: ConnectedAccountConfigurationRecord = Object.freeze({
            revision: `revision-${byTarget.size + 1}`,
            values: input.values,
            secretRefs: serviceScoped
                ? Object.freeze({
                    ...input.currentSecretRefs,
                    ...Object.fromEntries(
                        Object.keys(input.secretValues).map((fieldId) => [
                            fieldId,
                            `saved-secret-${fieldId}`,
                        ]),
                    ),
                })
                : input.currentSecretRefs,
            ...(!serviceScoped
                ? {
                    secretValues: Object.freeze({
                        ...input.secretValues,
                    }),
                }
                : {}),
        });
        byTarget.set(key, record);
        return { status: 'committed' as const, record };
    });
    const hasSecret = vi.fn(options?.hasSecret ?? (async (secretId: string) =>
        secretId.startsWith('saved-secret-')));
    const readSecret = vi.fn(async (secretId: string) =>
        secretId === 'saved-secret-1' ? 'super-secret' : null);
    const isGenerationCurrent = vi.fn(async () => (
        options?.isGenerationCurrent
            ? await options.isGenerationCurrent()
            : currentGeneration
    ));
    const owner = createConnectedAccountConfigurationOwner({
        read,
        replace,
        replaceForControl,
        destroyAttempt: vi.fn(async (attemptId) => {
            for (const [key] of byTarget) {
                const target = JSON.parse(key) as ConnectedAccountConfigurationTarget;
                if (target.kind === 'attempt' && target.attemptId === attemptId) byTarget.delete(key);
            }
        }),
        secrets: {
            has: hasSecret,
            read: readSecret,
        },
        isGenerationCurrent,
    });
    return {
        owner,
        read,
        replace,
        replaceForControl,
        hasSecret,
        readSecret,
        isGenerationCurrent,
        setGenerationCurrent(value: boolean) {
            currentGeneration = value;
        },
        setRecord(target: ConnectedAccountConfigurationTarget, record: ConnectedAccountConfigurationRecord) {
            byTarget.set(JSON.stringify(target), record);
        },
    };
}

describe('ConnectedAccountConfigurationOwner', () => {
    it('inspects normalized readiness without exposing secret refs and binds explicit secret replacements', async () => {
        const target = Object.freeze({
            kind: 'service' as const,
            service,
            modeId: 'oauth',
        });
        const harness = createHarness([{
            target,
            record: {
                revision: 'revision-current',
                values: { endpoint: 'https://old.example.test' },
                secretRefs: { clientSecret: 'saved-secret-1' },
            },
        }]);
        const mode = configuredMode('service');

        await expect(harness.owner.inspect({
            target,
            mode,
            ...generation,
        })).resolves.toEqual({
            status: 'ready',
            revision: 'revision-current',
            values: {
                endpoint: 'https://old.example.test',
                audience: 'default-audience',
            },
            configuredSecretFieldIds: ['clientSecret'],
            missingFieldIds: [],
        });

        await expect(harness.owner.replaceForControl({
            target,
            mode,
            expectedRevision: 'revision-current',
            values: {
                endpoint: 'https://new.example.test',
                audience: 'custom-audience',
            },
            secretValues: { clientSecret: 'replacement-secret' },
            ...generation,
        })).resolves.toMatchObject({
            status: 'committed',
            snapshot: {
                target,
                values: {
                    endpoint: 'https://new.example.test',
                    audience: 'custom-audience',
                },
            },
        });
        expect(harness.replaceForControl).toHaveBeenCalledWith(expect.objectContaining({
            target,
            currentSecretRefs: { clientSecret: 'saved-secret-1' },
            secretValues: { clientSecret: 'replacement-secret' },
            values: {
                endpoint: 'https://new.example.test',
                audience: 'custom-audience',
            },
        }));
        expect(harness.replace).not.toHaveBeenCalled();
    });

    it('rejects an inspected snapshot when its exact target revision changes during secret validation', async () => {
        const target = Object.freeze({
            kind: 'service' as const,
            service,
            modeId: 'oauth',
        });
        let finishSecretValidation!: (present: boolean) => void;
        const secretValidation = new Promise<boolean>((resolve) => {
            finishSecretValidation = resolve;
        });
        const harness = createHarness([{
            target,
            record: {
                revision: 'revision-before',
                values: { endpoint: 'https://old.example.test' },
                secretRefs: { clientSecret: 'saved-secret-1' },
            },
        }], {
            hasSecret: async () => await secretValidation,
        });

        const inspection = harness.owner.inspect({
            target,
            mode: configuredMode('service'),
            ...generation,
        });
        await vi.waitFor(() => expect(harness.hasSecret).toHaveBeenCalled());
        harness.setRecord(target, {
            revision: 'revision-after',
            values: { endpoint: 'https://new.example.test' },
            secretRefs: { clientSecret: 'saved-secret-1' },
        });
        finishSecretValidation(true);

        await expect(inspection).rejects.toMatchObject({
            code: 'connected_account_configuration_stale',
        });
    });

    it('returns the exact missing service fields without allocating attempt-local state', async () => {
        const harness = createHarness();

        await expect(harness.owner.admit({
            intent: 'connect',
            service,
            mode: configuredMode('service'),
            ...generation,
        })).resolves.toEqual({
            status: 'configurationRequired',
            target: { kind: 'service', service, modeId: 'oauth' },
            missingFieldIds: ['clientSecret', 'endpoint'],
        });
        expect(harness.read).toHaveBeenCalledWith({
            kind: 'service',
            service,
            modeId: 'oauth',
        });
    });

    it('loads one validated service snapshot, applies defaults, and fences bounded secret reads', async () => {
        const target = Object.freeze({
            kind: 'service' as const,
            service,
            modeId: 'oauth',
        });
        const harness = createHarness([{
            target,
            record: {
                revision: 'revision-7',
                values: { endpoint: 'https://api.example.test' },
                secretRefs: { clientSecret: 'saved-secret-1' },
            },
        }]);

        const admission = await harness.owner.admit({
            intent: 'connect',
            service,
            mode: configuredMode('service'),
            expectedConfigurationRevision: 'revision-7',
            ...generation,
        });
        expect(admission).toMatchObject({
            status: 'ready',
            snapshot: {
                target,
                revision: 'revision-7',
                values: {
                    endpoint: 'https://api.example.test',
                    audience: 'default-audience',
                },
            },
        });
        if (admission.status !== 'ready') throw new Error('Expected ready admission');
        await expect(admission.snapshot.getSecret('clientSecret')).resolves.toBe('super-secret');
        await expect(admission.snapshot.getSecret('endpoint')).rejects.toMatchObject({
            code: 'connected_account_configuration_secret_field_invalid',
        });

        harness.setGenerationCurrent(false);
        await expect(admission.snapshot.getSecret('clientSecret')).rejects.toMatchObject({
            code: 'connected_account_configuration_stale',
        });
        await expect(harness.owner.isCurrent(admission.snapshot)).resolves.toBe(false);
    });

    it('deep-snapshots nested configuration data instead of retaining mutable persistence objects', async () => {
        const mode = PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: 'oauth',
            kind: 'oauthDeviceCode',
            outcomeReconciliation: 'none',
            configuration: {
                scope: 'service',
                changeBehavior: 'refresh',
                fields: [{
                    id: 'metadata',
                    title: 'Metadata',
                    schema: {
                        type: 'object',
                        properties: {
                            labels: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['labels'],
                        additionalProperties: false,
                    },
                    required: true,
                }],
            },
        });
        const target = Object.freeze({ kind: 'service' as const, service, modeId: 'oauth' });
        const labels = ['alpha'];
        const metadata = { labels };
        const harness = createHarness([{
            target,
            record: {
                revision: 'revision-nested',
                values: { metadata },
                secretRefs: {},
            },
        }]);
        const admission = await harness.owner.admit({
            intent: 'connect',
            service,
            mode,
            ...generation,
        });
        if (admission.status !== 'ready') throw new Error('Expected ready admission');

        labels.push('mutated');
        expect(admission.snapshot.values).toEqual({
            metadata: { labels: ['alpha'] },
        });
        expect(Object.isFrozen(admission.snapshot.values.metadata)).toBe(true);
        expect(Object.isFrozen((admission.snapshot.values.metadata as { labels: string[] }).labels)).toBe(true);
    });

    it('fails closed for invalid defaults and dangling optional secret references', async () => {
        const invalidDefaultMode = PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: 'oauth',
            kind: 'oauthDeviceCode',
            outcomeReconciliation: 'none',
            configuration: {
                scope: 'service',
                changeBehavior: 'refresh',
                fields: [{
                    id: 'endpoint',
                    title: 'Endpoint',
                    schema: { type: 'string', minLength: 1 },
                    default: '',
                }],
            },
        });
        const target = Object.freeze({ kind: 'service' as const, service, modeId: 'oauth' });
        const invalidDefault = createHarness([{
            target,
            record: { revision: 'revision-1', values: {}, secretRefs: {} },
        }]);
        await expect(invalidDefault.owner.admit({
            intent: 'connect',
            service,
            mode: invalidDefaultMode,
            ...generation,
        })).rejects.toMatchObject({ code: 'connected_account_configuration_invalid' });

        const dangling = createHarness([{
            target,
            record: {
                revision: 'revision-2',
                values: {
                    endpoint: 'https://api.example.test',
                },
                secretRefs: {
                    clientSecret: 'saved-secret-1',
                    backupSecret: 'missing-secret',
                },
            },
        }]);
        const configuredServiceMode = configuredMode('service');
        if (!('configuration' in configuredServiceMode) || !configuredServiceMode.configuration) {
            throw new Error('Expected a configurable authentication mode');
        }
        const modeWithOptionalSecret = PluginConnectedAccountAuthenticationModeV2Schema.parse({
            ...configuredServiceMode,
            configuration: {
                ...configuredServiceMode.configuration,
                fields: [
                    ...configuredServiceMode.configuration!.fields,
                    {
                        id: 'backupSecret',
                        title: 'Backup secret',
                        schema: { type: 'string', minLength: 1 },
                        secret: true,
                    },
                ],
            },
        });
        await expect(dangling.owner.admit({
            intent: 'connect',
            service,
            mode: modeWithOptionalSecret,
            ...generation,
        })).rejects.toMatchObject({ code: 'connected_account_configuration_invalid' });
    });

    it('uses only an attempt target for first-connect account configuration', async () => {
        const target = Object.freeze({
            kind: 'attempt' as const,
            attemptId: 'attempt-1',
            service,
            modeId: 'oauth',
        });
        const harness = createHarness([{
            target,
            record: {
                revision: 'attempt-revision-1',
                values: { endpoint: 'https://api.example.test' },
                secretRefs: {},
                secretValues: { clientSecret: 'attempt-inline-secret' },
            },
        }]);

        await expect(harness.owner.admit({
            intent: 'connect',
            service,
            attemptId: 'attempt-1',
            mode: configuredMode('account'),
            ...generation,
        })).resolves.toMatchObject({
            status: 'ready',
            snapshot: { target },
            stagedAccountConfigurationContent: {
                values: {
                    endpoint: 'https://api.example.test',
                    audience: 'default-audience',
                },
                secretRefs: {},
                secretValues: { clientSecret: 'attempt-inline-secret' },
            },
        });
    });

    it('settles account and attempt secret bytes through their canonical record writer without global SavedSecrets', async () => {
        const targets = [
            Object.freeze({
                kind: 'account' as const,
                account,
                modeId: 'oauth',
            }),
            Object.freeze({
                kind: 'attempt' as const,
                attemptId: 'attempt-inline',
                service,
                modeId: 'oauth',
            }),
        ];

        for (const target of targets) {
            const harness = createHarness();
            const result = await harness.owner.replaceForControl({
                target,
                mode: configuredMode('account'),
                expectedRevision: null,
                values: { endpoint: 'https://api.example.test' },
                secretValues: { clientSecret: `inline-${target.kind}` },
                ...generation,
            });
            expect(result).toMatchObject({
                status: 'committed',
                snapshot: { target },
            });
            expect(harness.replace).toHaveBeenCalledWith(
                expect.objectContaining({
                    target,
                    replacement: {
                        values: {
                            endpoint: 'https://api.example.test',
                            audience: 'default-audience',
                        },
                        secretRefs: {},
                        secretValues: {
                            clientSecret: `inline-${target.kind}`,
                        },
                    },
                }),
            );
            expect(harness.replaceForControl).not.toHaveBeenCalled();
            expect(harness.hasSecret).not.toHaveBeenCalled();
            expect(harness.readSecret).not.toHaveBeenCalled();
            if (result.status !== 'committed') {
                throw new Error('Expected committed inline configuration');
            }
            await expect(result.snapshot.getSecret('clientSecret'))
                .resolves.toBe(`inline-${target.kind}`);
            expect(harness.readSecret).not.toHaveBeenCalled();

            const admission = await harness.owner.admit({
                intent: target.kind === 'account' ? 'reconnect' : 'connect',
                service,
                ...(target.kind === 'account'
                    ? { account }
                    : { attemptId: target.attemptId }),
                mode: configuredMode('account'),
                ...generation,
            });
            expect(admission).toMatchObject({
                status: 'ready',
                ...(target.kind === 'attempt'
                    ? {
                        stagedAccountConfigurationContent: {
                            secretRefs: {},
                            secretValues: {
                                clientSecret: 'inline-attempt',
                            },
                        },
                    }
                    : {}),
            });
        }
    });

    it('rejects account and attempt SavedSecret references before consulting Account Settings', async () => {
        const targets = [
            Object.freeze({
                kind: 'account' as const,
                account,
                modeId: 'oauth',
            }),
            Object.freeze({
                kind: 'attempt' as const,
                attemptId: 'attempt-ref-invalid',
                service,
                modeId: 'oauth',
            }),
        ];
        for (const target of targets) {
            const harness = createHarness([{
                target,
                record: {
                    revision: `revision-${target.kind}`,
                    values: { endpoint: 'https://api.example.test' },
                    secretRefs: { clientSecret: 'saved-secret-1' },
                },
            }]);
            await expect(harness.owner.inspect({
                target,
                mode: configuredMode('account'),
                ...generation,
            })).rejects.toMatchObject({
                code: 'connected_account_configuration_invalid',
            });
            expect(harness.hasSecret).not.toHaveBeenCalled();
            expect(harness.readSecret).not.toHaveBeenCalled();
        }
    });

    it('rejects inline bytes returned from service persistence', async () => {
        const target = Object.freeze({
            kind: 'service' as const,
            service,
            modeId: 'oauth',
        });
        const harness = createHarness([{
            target,
            record: {
                revision: 'revision-service-inline-invalid',
                values: { endpoint: 'https://api.example.test' },
                secretRefs: {},
                secretValues: { clientSecret: 'inline-service-secret' },
            },
        }]);

        await expect(harness.owner.inspect({
            target,
            mode: configuredMode('service'),
            ...generation,
        })).rejects.toMatchObject({
            code: 'connected_account_configuration_invalid',
        });
        expect(harness.hasSecret).not.toHaveBeenCalled();
        expect(harness.readSecret).not.toHaveBeenCalled();
    });

    it('loads reconnect configuration from the exact account and rejects an expected-revision mismatch', async () => {
        const target = Object.freeze({
            kind: 'account' as const,
            account,
            modeId: 'oauth',
        });
        const harness = createHarness([{
            target,
            record: {
                revision: 'revision-8',
                values: { endpoint: 'https://api.example.test' },
                secretRefs: {},
                secretValues: { clientSecret: 'account-inline-secret' },
            },
        }]);

        await expect(harness.owner.admit({
            intent: 'reconnect',
            service,
            account,
            mode: configuredMode('account'),
            expectedConfigurationRevision: 'revision-old',
            ...generation,
        })).resolves.toEqual({
            status: 'conflict',
            code: 'connected_account_configuration_changed',
        });
        expect(harness.read).toHaveBeenCalledWith(target);
    });

    it('rejects exact-account admission when its revision changes after the awaited record read', async () => {
        const target = Object.freeze({
            kind: 'account' as const,
            account,
            modeId: 'oauth',
        });
        let generationCheckCount = 0;
        let finishPostReadCheck!: () => void;
        const postReadCheck = new Promise<void>((resolve) => {
            finishPostReadCheck = resolve;
        });
        const harness = createHarness([{
            target,
            record: {
                revision: 'revision-before',
                values: { endpoint: 'https://old.example.test' },
                secretRefs: {},
                secretValues: { clientSecret: 'account-inline-secret' },
            },
        }], {
            isGenerationCurrent: async () => {
                generationCheckCount += 1;
                if (generationCheckCount === 2) await postReadCheck;
                return true;
            },
        });

        const admission = harness.owner.admit({
            intent: 'reconnect',
            service,
            account,
            mode: configuredMode('account'),
            expectedConfigurationRevision: 'revision-before',
            ...generation,
        });
        await vi.waitFor(() => {
            expect(harness.read).toHaveBeenCalledWith(target);
            expect(harness.isGenerationCurrent).toHaveBeenCalledTimes(2);
        });
        harness.setRecord(target, {
            revision: 'revision-after',
            values: { endpoint: 'https://new.example.test' },
            secretRefs: {},
            secretValues: { clientSecret: 'account-inline-secret' },
        });
        finishPostReadCheck();

        await expect(admission).resolves.toEqual({
            status: 'conflict',
            code: 'connected_account_configuration_changed',
        });
    });

    it('rejects undeclared, secret/plain-swapped, and schema-invalid replacement fields before CAS', async () => {
        const harness = createHarness();
        const target = Object.freeze({
            kind: 'service' as const,
            service,
            modeId: 'oauth',
        });

        for (const replacement of [{
            values: { endpoint: 'https://api.example.test', extra: true },
            secretRefs: { clientSecret: 'saved-secret-1' },
        }, {
            values: { endpoint: 'https://api.example.test', clientSecret: 'plaintext' },
            secretRefs: {},
        }, {
            values: { endpoint: '' },
            secretRefs: { clientSecret: 'saved-secret-1' },
        }]) {
            await expect(harness.owner.replace({
                target,
                mode: configuredMode('service'),
                expectedRevision: null,
                replacement,
                ...generation,
            })).rejects.toMatchObject({
                code: 'connected_account_configuration_invalid',
            });
        }
        expect(harness.replace).not.toHaveBeenCalled();
    });

    it.each([
        ['service', 'not-an-origin'],
        ['service', 'http://api.example.test'],
        ['service', 'https://user:secret@api.example.test'],
        ['service', 'https://api.example.test/v1'],
        ['account', 'not-an-origin'],
        ['account', 'http://api.example.test'],
        ['account', 'https://user:secret@api.example.test'],
        ['account', 'https://api.example.test/v1'],
    ] as const)(
        'rejects %s-scoped semantic Connected Account origin %s before configuration CAS',
        async (scope, origin) => {
        const harness = createHarness();
        const target: ConnectedAccountConfigurationTarget = scope === 'service'
            ? Object.freeze({
                kind: 'service' as const,
                service,
                modeId: 'oauth',
            })
            : Object.freeze({
                kind: 'account' as const,
                account,
                modeId: 'oauth',
            });
        const mode = PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: 'oauth',
            kind: 'oauthDeviceCode',
            outcomeReconciliation: 'none',
            configuration: {
                scope,
                changeBehavior: 'reconnect',
                fields: [{
                    id: 'api-origin',
                    title: 'API origin',
                    schema: { type: 'string', minLength: 1 },
                    semantic: 'connectedAccountOrigin',
                    required: true,
                }],
            },
        });

        await expect(harness.owner.replaceForControl({
            target,
            mode,
            expectedRevision: null,
            values: { 'api-origin': origin },
            secretValues: {},
            ...generation,
        })).rejects.toMatchObject({
            code: 'connected_account_configuration_invalid',
        });
        expect(harness.replaceForControl).not.toHaveBeenCalled();
        await expect(harness.owner.inspect({
            target,
            mode,
            ...generation,
        })).resolves.toMatchObject({
            status: 'configurationRequired',
            revision: null,
            values: {},
        });
    });

    it('commits a full replacement under exact CAS without assigning runtime consequence ownership to persistence', async () => {
        const harness = createHarness();
        const target = Object.freeze({
            kind: 'service' as const,
            service,
            modeId: 'oauth',
        });

        await expect(harness.owner.replace({
            target,
            mode: configuredMode('service', 'reconnect'),
            expectedRevision: null,
            replacement: {
                values: { endpoint: 'https://api.example.test' },
                secretRefs: { clientSecret: 'saved-secret-1' },
            },
            ...generation,
        })).resolves.toMatchObject({
            status: 'committed',
            snapshot: {
                target,
                revision: 'revision-1',
            },
        });
        expect(harness.replace).toHaveBeenCalledOnce();
        expect(harness.replace).toHaveBeenCalledWith(expect.objectContaining({
            target,
        }));
        expect(harness.replace.mock.calls[0]![0]).not.toHaveProperty('consequence');
    });

    it('does not create a meaningless persistence record for a mode without configuration', async () => {
        const harness = createHarness();
        const mode = PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{
                id: 'token',
                title: 'Token',
                schema: { type: 'string' },
                secret: true,
            }],
        });

        await expect(harness.owner.replace({
            target: { kind: 'service', service, modeId: 'manual' },
            mode,
            expectedRevision: null,
            replacement: { values: {}, secretRefs: {} },
            ...generation,
        })).rejects.toMatchObject({ code: 'connected_account_configuration_invalid' });
        expect(harness.replace).not.toHaveBeenCalled();
    });
});
