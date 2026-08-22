import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    ExternalSessionObservationLinkedSession,
    ExternalSessionObservationLinkInput,
} from './resolveExternalSessionObservationLinkInput';
import {
    applyExternalSessionStatusDemandBatch,
    loadCanonicalCurrentExternalSessionStatusDemandLink,
} from './applyExternalSessionStatusDemandBatch';

const {
    loadLinkedExternalSessionMock,
    readCredentialsMock,
} = vi.hoisted(() => ({
    loadLinkedExternalSessionMock: vi.fn(),
    readCredentialsMock: vi.fn(),
}));

vi.mock('@/persistence', () => ({
    readStoredCredentials: readCredentialsMock,
}));

vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', () => ({
    loadLinkedExternalSession: loadLinkedExternalSessionMock,
}));

function resolvedInput(
    sessionId: string,
    linkGeneration: string,
    linkKey: string,
): ExternalSessionObservationLinkInput {
    return {
        resource: {
            pluginId: 'happier.opencode',
            agentLocalId: 'opencode',
            pluginGeneration: 'plugin-generation-1',
            resourceKey: 'shared-endpoint',
        },
        link: {
            sessionId,
            linkGeneration,
            linkKey,
            linkedSource: {
                source: { kind: 'opencodeServer' },
                remoteSessionId: linkKey,
                linkData: {},
            },
            changeObservation: 'reconcile_only',
        },
        target: {
            qualifiedLinkIdentity: {
                v: 1,
                agent: {
                    pluginId: 'happier.opencode',
                    localId: 'opencode',
                },
                source: {
                    kind: 'opencodeServer',
                    contractVersion: 1,
                },
            },
            linkGeneration,
        },
    };
}

function linkedSession(
    linkGeneration: string,
): ExternalSessionObservationLinkedSession {
    return {
        agentId: 'opencode',
        linkGeneration,
        remoteSessionId: `remote-${linkGeneration}`,
        source: {
            kind: 'opencodeServer',
            directory: null,
        },
        metadata: {},
    };
}

describe('applyExternalSessionStatusDemandBatch', () => {
    beforeEach(() => {
        loadLinkedExternalSessionMock.mockReset();
        readCredentialsMock.mockReset();
    });

    it('rechecks and resolves one replace batch before one projection batch', async () => {
        const reconcileFallbackDemandBatch = vi.fn(async () => {});
        const loadCurrentLink = vi.fn(async (input: Readonly<{ sessionId: string }>) => ({
            machineId: 'machine-1',
            linkGeneration: input.sessionId === 'session-1' ? 'generation-1' : 'generation-2',
            linked: linkedSession(
                input.sessionId === 'session-1' ? 'generation-1' : 'generation-2',
            ),
        }));
        const resolveLinkInput = vi.fn(async (input: Readonly<{
            linked: ExternalSessionObservationLinkedSession;
            sessionId: string;
        }>) => resolvedInput(
            input.sessionId,
            input.sessionId === 'session-1' ? 'generation-1' : 'generation-2',
            input.sessionId === 'session-1' ? 'native-1' : 'native-2',
        ));

        await expect(applyExternalSessionStatusDemandBatch({
            machineId: 'machine-1',
            changes: [
                {
                    sessionId: 'session-1',
                    linkGeneration: 'generation-1',
                    demand: 'visible',
                },
                {
                    sessionId: 'session-2',
                    linkGeneration: 'generation-2',
                    demand: 'open',
                },
            ],
            projection: { reconcileFallbackDemandBatch },
            loadCurrentLink,
            resolveLinkInput,
        })).resolves.toEqual({ state: 'applied' });

        expect(loadCurrentLink).toHaveBeenCalledTimes(2);
        expect(resolveLinkInput).toHaveBeenCalledTimes(2);
        expect(reconcileFallbackDemandBatch).toHaveBeenCalledOnce();
        expect(reconcileFallbackDemandBatch).toHaveBeenCalledWith([
            {
                sessionId: 'session-1',
                linkGeneration: 'generation-1',
                resolved: resolvedInput('session-1', 'generation-1', 'native-1'),
                demanded: true,
            },
            {
                sessionId: 'session-2',
                linkGeneration: 'generation-2',
                resolved: resolvedInput('session-2', 'generation-2', 'native-2'),
                demanded: true,
            },
        ]);
    });

    it('keeps the whole batch unapplied when current-link observation resolution is transiently unavailable', async () => {
        const reconcileFallbackDemandBatch = vi.fn(async () => {});
        const resolveLinkInput = vi.fn(async () => null);

        await expect(applyExternalSessionStatusDemandBatch({
            machineId: 'machine-1',
            changes: [
                {
                    sessionId: 'stale-session',
                    linkGeneration: 'generation-old',
                    demand: 'open',
                },
                {
                    sessionId: 'current-session',
                    linkGeneration: 'generation-current',
                    demand: 'visible',
                },
            ],
            projection: { reconcileFallbackDemandBatch },
            loadCurrentLink: async (input) => ({
                machineId: 'machine-1',
                linkGeneration: 'generation-current',
                linked: linkedSession('generation-current'),
            }),
            resolveLinkInput,
        })).resolves.toEqual({
            state: 'retryable-failure',
            phase: 'resolve-link-input',
        });

        expect(resolveLinkInput).toHaveBeenCalledOnce();
        expect(reconcileFallbackDemandBatch).not.toHaveBeenCalled();
    });

    it('keeps demand unapplied when the canonical linked-session load fails transiently', async () => {
        const reconcileFallbackDemandBatch = vi.fn(async () => {});

        await expect(applyExternalSessionStatusDemandBatch({
            machineId: 'machine-1',
            changes: [{
                sessionId: 'session-1',
                linkGeneration: 'generation-current',
                demand: 'open',
            }],
            projection: { reconcileFallbackDemandBatch },
            loadCurrentLink: async () => {
                throw new Error('temporary session load failure');
            },
        })).resolves.toEqual({
            state: 'retryable-failure',
            phase: 'load-current-link',
        });
        expect(reconcileFallbackDemandBatch).not.toHaveBeenCalled();
    });

    it('classifies canonical metadata unavailability as retryable instead of clearing demand', async () => {
        const reconcileFallbackDemandBatch = vi.fn(async () => {});
        readCredentialsMock.mockResolvedValue({ token: 'token-1' });
        loadLinkedExternalSessionMock.mockResolvedValue({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'session_metadata_unavailable',
        });

        await expect(applyExternalSessionStatusDemandBatch({
            machineId: 'machine-1',
            changes: [{
                sessionId: 'session-1',
                linkGeneration: 'generation-current',
                demand: 'open',
            }],
            projection: { reconcileFallbackDemandBatch },
        })).resolves.toEqual({
            state: 'retryable-failure',
            phase: 'load-current-link',
        });
        expect(reconcileFallbackDemandBatch).not.toHaveBeenCalled();
    });

    it('rejects a hosted link through the canonical by-id current-link loader', async () => {
        readCredentialsMock.mockResolvedValue({ token: 'token-1' });
        loadLinkedExternalSessionMock.mockResolvedValue({
            ok: true,
            session: {
                rawSession: {
                    id: 'session-1',
                    currentStorageState: 'hosted',
                },
                machineId: 'machine-1',
                agentId: 'codex',
                linkGeneration: 'generation-1',
                metadata: {},
                remoteSessionId: 'thread-1',
                source: { kind: 'codexHome', home: 'user' },
            },
        });

        await expect(loadCanonicalCurrentExternalSessionStatusDemandLink({
            sessionId: 'session-1',
            machineId: 'machine-1',
        })).resolves.toBeNull();
    });

    it('retains the proven released-server by-id omission compatibility', async () => {
        readCredentialsMock.mockResolvedValue({ token: 'token-1' });
        loadLinkedExternalSessionMock.mockResolvedValue({
            ok: true,
            session: {
                rawSession: { id: 'session-1' },
                machineId: 'machine-1',
                agentId: 'codex',
                linkGeneration: 'generation-1',
                metadata: {},
                remoteSessionId: 'thread-1',
                source: { kind: 'codexHome', home: 'user' },
            },
        });

        await expect(loadCanonicalCurrentExternalSessionStatusDemandLink({
            sessionId: 'session-1',
            machineId: 'machine-1',
        })).resolves.toMatchObject({
            machineId: 'machine-1',
            linkGeneration: 'generation-1',
        });
    });

    it('clears the stored old generation even when the canonical link already relinked', async () => {
        const reconcileFallbackDemandBatch = vi.fn(async () => {});
        const loadCurrentLink = vi.fn(async () => ({
            machineId: 'machine-1',
            linkGeneration: 'generation-new',
            linked: linkedSession('generation-new'),
        }));

        await expect(applyExternalSessionStatusDemandBatch({
            machineId: 'machine-1',
            changes: [{
                sessionId: 'session-1',
                linkGeneration: 'generation-old',
                demand: null,
            }],
            projection: { reconcileFallbackDemandBatch },
            loadCurrentLink,
        })).resolves.toEqual({ state: 'applied' });

        expect(loadCurrentLink).not.toHaveBeenCalled();
        expect(reconcileFallbackDemandBatch).toHaveBeenCalledWith([{
            sessionId: 'session-1',
            linkGeneration: 'generation-old',
            resolved: null,
            demanded: false,
        }]);
    });
});
