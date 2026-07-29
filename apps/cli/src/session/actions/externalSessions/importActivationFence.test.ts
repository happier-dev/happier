import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, type ActionExecuteResult } from '@happier-dev/protocol';

import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

import {
    executeExternalSessionImportActivation,
    isExternalSessionHostedAdmissionAvailable,
} from './importActivationFence';

function ready(currentPublicationFenceVersion?: number): CliServerFeaturesSnapshot {
    const features = FeaturesResponseSchema.parse({
        features: {},
        capabilities: {
            compatibility: {
                v: 1,
                sessionSync: {
                    v: 1,
                    enforcement: 'observe',
                    minimumSessionSyncProtocolVersion: 1,
                    currentSessionSyncProtocolVersion: 2,
                    declarationTransport: 'headers-v1',
                },
            },
        },
    });
    return {
        status: 'ready',
        features: currentPublicationFenceVersion === undefined
            ? features
            : {
            ...features,
            capabilities: {
                ...features.capabilities,
                compatibility: {
                    ...features.capabilities.compatibility!,
                    externalSessionImport: {
                        currentPublicationFenceVersion,
                    },
                },
            },
        },
    };
}

function releasedServerWithoutCompatibilityCapability(): CliServerFeaturesSnapshot {
    return {
        status: 'ready',
        features: FeaturesResponseSchema.parse({
            features: {},
            capabilities: {},
        }),
    };
}

function takeoverStartInput(
    targetStorageMode: 'external-linked' | 'persisted',
) {
    return {
        request: {
            v: 1,
            idempotencyKey: `takeover-${targetStorageMode}`,
            sessionId: 'session-1',
            source: {
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                qualifiedIdentity: {
                    v: 1,
                    agent: {
                        pluginId: 'example.plugin',
                        localId: 'example',
                    },
                    source: { kind: 'jsonl', contractVersion: 1 },
                },
                linkGeneration: 'link-1',
            },
            plan: 'takeover',
            targetStorageMode,
            targetRuntimeMode: 'terminal',
        },
    } as const;
}

describe('external-session import activation publication fence', () => {
    it.each([
        'sessions.external.materialize.start',
        'sessions.external.operation.resume',
        'sessions.external.operation.retry',
    ] as const)('returns upgrade_required before executing %s against a pre-fence server', async (actionId) => {
        const execute = vi.fn(async (): Promise<ActionExecuteResult> => ({ ok: true, result: null }));

        await expect(executeExternalSessionImportActivation({
            actionId,
            input: {},
            serverSnapshot: ready(),
            ...(actionId === 'sessions.external.operation.resume'
                || actionId === 'sessions.external.operation.retry'
                ? { requiredPublicationFenceVersion: 1 }
                : {}),
            execute,
        })).resolves.toMatchObject({
            ok: true,
            result: {
                ok: false,
                error: { code: 'upgrade_required' },
            },
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it('protects the current persisted takeover path while leaving external-linked takeover unchanged', async () => {
        const execute = vi.fn(async (): Promise<ActionExecuteResult> => ({ ok: true, result: null }));

        await expect(executeExternalSessionImportActivation({
            actionId: 'sessions.external.takeover',
            input: { storageMode: 'persisted' },
            serverSnapshot: ready(),
            execute,
        })).resolves.toMatchObject({
            ok: true,
            result: {
                ok: false,
                errorCode: 'upgrade_required',
            },
        });
        expect(execute).not.toHaveBeenCalled();

        await expect(executeExternalSessionImportActivation({
            actionId: 'sessions.external.takeover',
            input: { storageMode: 'external-linked' },
            serverSnapshot: ready(),
            execute,
        })).resolves.toEqual({ ok: true, result: null });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('keeps the unsafe legacy persisted-takeover loop retired after publication-fence activation', async () => {
        const execute = vi.fn(async (): Promise<ActionExecuteResult> => ({ ok: true, result: null }));

        await expect(executeExternalSessionImportActivation({
            actionId: 'sessions.external.takeover',
            input: { storageMode: 'persisted' },
            serverSnapshot: ready(1),
            execute,
        })).resolves.toMatchObject({
            ok: true,
            result: {
                ok: false,
                errorCode: 'upgrade_required',
            },
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it('fails closed without a ready snapshot and admits through the same executor at fence version one', async () => {
        const execute = vi.fn(async (): Promise<ActionExecuteResult> => ({ ok: true, result: null }));

        await expect(executeExternalSessionImportActivation({
            actionId: 'sessions.external.materialize.start',
            input: {},
            serverSnapshot: undefined,
            execute,
        })).resolves.toMatchObject({
            ok: true,
            result: {
                ok: false,
                error: { code: 'upgrade_required' },
            },
        });
        expect(execute).not.toHaveBeenCalled();

        await expect(executeExternalSessionImportActivation({
            actionId: 'sessions.external.materialize.start',
            input: {},
            serverSnapshot: ready(1),
            execute,
        })).resolves.toEqual({ ok: true, result: null });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('requires runtime-bound hosted-admission fence version three before durable takeover start', async () => {
        const execute = vi.fn(async (): Promise<ActionExecuteResult> => ({ ok: true, result: null }));

        await expect(executeExternalSessionImportActivation({
            actionId: 'sessions.external.takeover.start',
            input: takeoverStartInput('persisted'),
            serverSnapshot: ready(1),
            execute,
        })).resolves.toMatchObject({
            ok: true,
            result: {
                ok: false,
                error: { code: 'upgrade_required' },
            },
        });
        expect(execute).not.toHaveBeenCalled();

        await expect(executeExternalSessionImportActivation({
            actionId: 'sessions.external.takeover.start',
            input: takeoverStartInput('persisted'),
            serverSnapshot: ready(3),
            execute,
        })).resolves.toEqual({ ok: true, result: null });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('does not apply the import publication fence to durable external-linked takeover start or continuation', async () => {
        const execute = vi.fn(async (): Promise<ActionExecuteResult> => ({
            ok: true,
            result: null,
        }));

        await expect(executeExternalSessionImportActivation({
            actionId: 'sessions.external.takeover.start',
            input: takeoverStartInput('external-linked'),
            serverSnapshot: undefined,
            execute,
        })).resolves.toEqual({ ok: true, result: null });
        await expect(executeExternalSessionImportActivation({
            actionId: 'sessions.external.operation.resume',
            input: {},
            serverSnapshot: undefined,
            execute,
        })).resolves.toEqual({ ok: true, result: null });
        expect(execute).toHaveBeenCalledTimes(2);
    });

    it('requires runtime-bound hosted-admission fence version three when a persisted takeover Resume overrides the generic operation fence', async () => {
        const execute = vi.fn(async (): Promise<ActionExecuteResult> => ({ ok: true, result: null }));

        await expect(executeExternalSessionImportActivation({
            actionId: 'sessions.external.operation.resume',
            input: {},
            serverSnapshot: ready(1),
            requiredPublicationFenceVersion: 3,
            execute,
        })).resolves.toMatchObject({
            ok: true,
            result: {
                ok: false,
                error: { code: 'upgrade_required' },
            },
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it('exposes the same fail-closed hosted-admission decision to direct admission executors', () => {
        expect(isExternalSessionHostedAdmissionAvailable(undefined)).toBe(false);
        expect(isExternalSessionHostedAdmissionAvailable(ready(1))).toBe(false);
        expect(isExternalSessionHostedAdmissionAvailable(ready(2))).toBe(false);
        expect(isExternalSessionHostedAdmissionAvailable(ready(3))).toBe(true);
    });

    it('fails closed for the released server payload shape that predates compatibility capabilities', async () => {
        const execute = vi.fn(async (): Promise<ActionExecuteResult> => ({ ok: true, result: null }));

        await expect(executeExternalSessionImportActivation({
            actionId: 'sessions.external.materialize.start',
            input: {},
            serverSnapshot: releasedServerWithoutCompatibilityCapability(),
            execute,
        })).resolves.toMatchObject({
            ok: true,
            result: {
                ok: false,
                error: { code: 'upgrade_required' },
            },
        });
        expect(execute).not.toHaveBeenCalled();
    });
});
