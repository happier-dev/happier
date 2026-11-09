import { buildSessionFollowSourceKeyPrepareRequestV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import { describe, expect, it, vi } from 'vitest';

import { prepareSessionFollowSourceKey } from './prepareSessionFollowSourceKey';

function createDeps(overrides: Partial<Parameters<typeof prepareSessionFollowSourceKey>[1]> = {}) {
    return {
        resolveContext: vi.fn(async () => ({
            scope: 'scoped' as const,
            serverId: 'home-a',
            accountId: 'account-a',
            release: vi.fn(async () => undefined),
            resolveSourceCrypto: vi.fn(async () => ({ encryptionMode: 'e2ee' as const, sessionDataKey: new Uint8Array(32).fill(7) })),
        })),
        resolveDestination: vi.fn(() => ({
            machineId: 'runner-a',
            machine: {
                kind: 'ephemeral_session_runner' as const,
                active: true,
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            },
        })),
        callMachine: vi.fn(async () => ({ v: 1 as const, outcome: 'installed' as const })),
        ...overrides,
    };
}

describe('prepareSessionFollowSourceKey', () => {
    it('issues an explicit preparation retry even when the destination presence is offline', async () => {
        const deps = createDeps({ resolveDestination: vi.fn(() => ({ machineId: 'runner-a', machine: {
            kind: 'ephemeral_session_runner' as const, active: false,
            operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
        } })) });
        await expect(prepareSessionFollowSourceKey({ serverId: 'home-a', sourceSessionId: 'source-a',
            destinationSessionId: 'destination-a' }, deps)).resolves.toEqual({ kind: 'prepared' });
    });
    it('opens the source DEK and sends it only to the current exact destination Runner after the edge exists', async () => {
        const deps = createDeps();
        const result = await prepareSessionFollowSourceKey({
            serverId: 'home-a', sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
        }, deps);

        expect(result).toEqual({ kind: 'prepared' });
        expect(deps.resolveDestination).toHaveBeenCalledWith({
            serverId: 'home-a', accountId: 'account-a', sessionId: 'destination-a',
        });
        // The call is built by the one Protocol owner both DEK-sending hosts use;
        // a locally assembled literal here is how the two hosts drift apart.
        expect(deps.callMachine).toHaveBeenCalledWith({
            serverId: 'home-a', accountId: 'account-a', machineId: 'runner-a',
            ...buildSessionFollowSourceKeyPrepareRequestV1({
                sourceSessionId: 'source-a',
                destinationSessionId: 'destination-a',
                sourceDataEncryptionKeyBase64: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
            }),
        });
    });

    it('does not send keys for a plain source or persistent destination', async () => {
        const plainDeps = createDeps({
            resolveContext: vi.fn(async () => ({
                scope: 'scoped' as const,
                serverId: 'home-a', accountId: 'account-a', release: vi.fn(async () => undefined),
                resolveSourceCrypto: vi.fn(async () => ({ encryptionMode: 'plain' as const, sessionDataKey: null })),
            })),
        });
        await expect(prepareSessionFollowSourceKey({
            serverId: 'home-a', sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
        }, plainDeps)).resolves.toEqual({ kind: 'not_needed' });
        expect(plainDeps.callMachine).not.toHaveBeenCalled();

        const persistentDeps = createDeps({
            resolveDestination: vi.fn(() => ({
                machineId: 'machine-a',
                machine: { kind: 'persistent' as const, active: true, operationProtocolCapabilities: { sessionFollow: { contextV1: true } } },
            })),
        });
        await expect(prepareSessionFollowSourceKey({
            serverId: 'home-a', sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
        }, persistentDeps)).resolves.toEqual({ kind: 'not_needed' });
        expect(persistentDeps.callMachine).not.toHaveBeenCalled();
    });

    it('returns explicit retryable waiting reasons without inferring readiness from the edge', async () => {
        const unavailableKey = createDeps({
            resolveContext: vi.fn(async () => ({
                scope: 'scoped' as const,
                serverId: 'home-a', accountId: 'account-a', release: vi.fn(async () => undefined),
                resolveSourceCrypto: vi.fn(async () => ({ encryptionMode: 'unknown' as const, sessionDataKey: null })),
            })),
        });
        await expect(prepareSessionFollowSourceKey({
            serverId: 'home-a', sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
        }, unavailableKey)).resolves.toEqual({ kind: 'waiting', reason: 'source_key_unavailable' });

        // A historical owner Session reads through the Account-scoped reader; that is never a DEK to hand over.
        const historicalOwnerReader = createDeps({
            resolveContext: vi.fn(async () => ({
                scope: 'scoped' as const,
                serverId: 'home-a', accountId: 'account-a', release: vi.fn(async () => undefined),
                resolveSourceCrypto: vi.fn(async () => ({ encryptionMode: 'legacy_fallback' as const, sessionDataKey: null })),
            })),
        });
        await expect(prepareSessionFollowSourceKey({
            serverId: 'home-a', sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
        }, historicalOwnerReader)).resolves.toEqual({ kind: 'waiting', reason: 'source_key_unavailable' });
        expect(historicalOwnerReader.callMachine).not.toHaveBeenCalled();

        const offlineRunner = createDeps({ resolveDestination: vi.fn(() => null) });
        await expect(prepareSessionFollowSourceKey({
            serverId: 'home-a', sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
        }, offlineRunner)).resolves.toEqual({ kind: 'waiting', reason: 'runner_unreachable' });
        expect(offlineRunner.callMachine).not.toHaveBeenCalled();

        const revokedRunner = createDeps({
            resolveDestination: vi.fn(() => ({
                machineId: 'runner-a',
                machine: {
                    kind: 'ephemeral_session_runner' as const,
                    active: true,
                    activeAt: Date.now(),
                    revokedAt: Date.now(),
                    operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
                },
            })),
        });
        await expect(prepareSessionFollowSourceKey({
            serverId: 'home-a', sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
        }, revokedRunner)).resolves.toEqual({ kind: 'waiting', reason: 'runner_unreachable' });
        expect(revokedRunner.callMachine).not.toHaveBeenCalled();

        const unsupportedRunner = createDeps({
            resolveDestination: vi.fn(() => ({
                machineId: 'runner-a',
                machine: { kind: 'ephemeral_session_runner' as const, active: true, operationProtocolCapabilities: {} },
            })),
        });
        await expect(prepareSessionFollowSourceKey({
            serverId: 'home-a', sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
        }, unsupportedRunner)).resolves.toEqual({ kind: 'waiting', reason: 'unsupported' });
    });

    it('classifies a Runner preparation failure through the shared Protocol vocabulary', async () => {
        const rejectWith = (error: unknown) => createDeps({ callMachine: vi.fn(async () => { throw error; }) });
        const input = { serverId: 'home-a', sourceSessionId: 'source-a', destinationSessionId: 'destination-a' };

        await expect(prepareSessionFollowSourceKey(input, rejectWith(Object.assign(new Error('old daemon'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }))))
            .resolves.toEqual({ kind: 'waiting', reason: 'unsupported', cause: 'rpc_method_unavailable' });
        await expect(prepareSessionFollowSourceKey(input, rejectWith(Object.assign(new Error('no runner key'), { rpcErrorCode: 'machine_content_key_unavailable' }))))
            .resolves.toEqual({ kind: 'waiting', reason: 'runner_key_unavailable', cause: 'machine_content_key_unavailable' });
        await expect(prepareSessionFollowSourceKey(input, rejectWith(Object.assign(new Error('persistent'), { rpcErrorCode: 'machine_kind_mismatch' }))))
            .resolves.toEqual({ kind: 'not_needed' });
        await expect(prepareSessionFollowSourceKey(input, rejectWith(new Error('socket closed'))))
            .resolves.toEqual({ kind: 'waiting', reason: 'runner_unreachable', cause: 'machine_rpc_failed' });
    });
});
