import { describe, expect, it, vi } from 'vitest';

import type {
    BoundedAgentExternalSessionsContribution,
} from '@/session/external/agentExternalSessionsInvocation';

import type { AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/sessions/external';
import { createBoundedAgentExternalSessionsContribution } from '@/session/external/agentExternalSessionsInvocation';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

import { createAgentExternalSessionsExecutionSurface } from './agentExternalSessionsExecutionSurface';

function createContribution(): BoundedAgentExternalSessionsContribution {
    return Object.freeze({
        supportsAccounting: false,
        supportsCandidateHydration: false,
        hydrateCandidates: async () => ({ ok: false as const, code: 'unsupported' as const }),
        readAccounting: async () => ({ ok: false as const, code: 'unsupported' as const }),
        resolveSource: vi.fn(async (request) => ({ ok: true as const, value: { source: request.source } })),
        listCandidates: vi.fn(async () => ({ ok: true as const, value: { candidates: [], nextCursor: null } })),
        resolveLinkIdentity: vi.fn(async (request) => ({ ok: true as const, value: {
            remoteSessionId: request.remoteSessionId,
            source: request.source,
            linkData: request.linkData ?? {},
        } })),
        resolveLinkedIdentity: vi.fn(async (request) => ({ ok: true as const, value: {
            remoteSessionId: request.remoteSessionId,
            source: request.source,
            linkData: request.linkData,
        } })),
        pageTranscript: vi.fn(async () => ({ ok: true as const, value: { items: [], nextCursor: null } })),
        readAfterTranscript: vi.fn(async () => ({ ok: true as const, value: { outcome: 'already_current' as const } })),
    });
}

describe('createAgentExternalSessionsExecutionSurface', () => {
    it('projects only supported typed facts out of an Agent link payload', async () => {
        const source = {
            kind: 'codexHome',
            home: 'user',
            homePath: '/private/codex-home',
        } as const;
        const runtimeDescriptorV1 = {
            v: 1 as const,
            agentId: 'codex',
            agent: {
                backendMode: 'appServer',
                providerSessionId: 'remote-1',
            },
        };
        const linkData = {
            source,
            runtimeDescriptorV1,
            codexBackendMode: 'appServer',
            codexSessionId: 'remote-1',
            providerSessionInfoV1: {
                v: 1,
                provider: 'codex',
                sessionId: 'remote-1',
                observedAt: 1,
                title: 'Native session title',
            },
            // Owner-metadata and LinkedExternalSessionV1 both accept these keys,
            // so only the projection keeps them off the host's carriers.
            machineId: 'machine_attacker',
            tag: 'attacker-tag',
            vendorOnlyHint: 'vendor-only',
        };
        const contribution = createContribution();
        vi.mocked(contribution.resolveLinkIdentity).mockResolvedValueOnce({
            ok: true,
            value: { source, remoteSessionId: 'remote-1', linkData },
        });
        vi.mocked(contribution.resolveLinkedIdentity).mockResolvedValueOnce({
            ok: true,
            value: { source, remoteSessionId: 'remote-1', linkData },
        });
        const surface = createAgentExternalSessionsExecutionSurface(contribution);

        const result = await surface.resolveLinkIdentity!({
            source,
            remoteSessionId: 'remote-1',
        });
        expect(result.vendorMetadata).toEqual({
            providerSessionInfoV1: linkData.providerSessionInfoV1,
        });
        expect(result.externalSessionMetadata).toEqual({ linkData });
        expect(result.runtimeDescriptor).toEqual(runtimeDescriptorV1);

        await expect(surface.canonicalizeLinkedSession!({
            source,
            remoteSessionId: 'remote-1',
            metadata: { linkData },
        })).resolves.toEqual(expect.objectContaining({
            source,
            remoteSessionId: 'remote-1',
        }));
    });

    it('rejects malformed released linked metadata before invoking the Agent contribution', async () => {
        const contribution = createContribution();
        const surface = createAgentExternalSessionsExecutionSurface(contribution);

        await expect(surface.canonicalizeLinkedSession!({
            source: { kind: 'synthetic' },
            remoteSessionId: 'remote-1',
            metadata: {
                directSessionV1: {
                    v: 1,
                    providerId: 'synthetic',
                },
            },
        })).rejects.toMatchObject({
            name: 'ExternalSessionProviderFailureError',
            code: 'invalid_request',
            operation: 'resolveLinkedIdentity',
        });
        expect(contribution.resolveLinkedIdentity).not.toHaveBeenCalled();
    });

    it('preserves one caller-owned admission deadline across transcript page calls', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const contribution = createContribution();
        const surface = createAgentExternalSessionsExecutionSurface(contribution);

        await surface.pageTranscript!({
            source: { kind: 'synthetic' },
            remoteSessionId: 'remote-1',
            direction: 'newer',
            maxBytes: 524_288,
            maxItems: 200,
            deadlineAtMs: 61_000,
        });

        expect(contribution.pageTranscript).toHaveBeenCalledWith(
            expect.objectContaining({ deadlineAtMs: 61_000 }),
        );
        vi.useRealTimers();
    });
});


describe('selected-page hydration execution surface', () => {
    function bounded(hydrateCandidates?: AgentExternalSessionsContribution['hydrateCandidates']) {
        const contribution: AgentExternalSessionsContribution = {
            resolveSource: request => ({ ok: true, value: { source: request.source } }),
            listCandidates: () => ({ ok: true, value: { candidates: [], nextCursor: null } }),
            resolveLinkIdentity: request => ({ ok: true, value: { source: request.source, remoteSessionId: request.remoteSessionId, linkData: {} } }),
            resolveLinkedIdentity: request => ({ ok: true, value: request }),
            pageTranscript: () => ({ ok: true, value: { items: [], nextCursor: null } }),
            readAfterTranscript: () => ({ ok: true, value: { outcome: 'already_current' } }),
            ...(hydrateCandidates ? { hydrateCandidates } : {}),
        };
        return createBoundedAgentExternalSessionsContribution({ contribution,
            identity: { pluginId: 'test.external', agentId: 'test', occurrenceId: 'occurrence',
                contributionQualifiedId: 'test.external/agents/test',
                sourceCustody: { kind: 'development', registeredRootId: 'test' } },
            isCurrent: () => true, retirementSignal: new AbortController().signal,
            createInvocationExec: async () => createUnavailablePluginServices().exec,
        });
    }

    it('advertises hydration only with positive producer capability', () => {
        expect(createAgentExternalSessionsExecutionSurface(bounded()).hydrateCandidates).toBeUndefined();
        expect(createAgentExternalSessionsExecutionSurface(bounded(request => ({ ok: true,
            value: { candidates: request.candidates } }))).hydrateCandidates).toBeTypeOf('function');
    });

    it('preserves the selected page and caller lifetime through the real bounded owner', async () => {
        const candidates = [{ remoteSessionId: 'remote-1', updatedAtMs: 1, candidateIndexState: { checkpoint: 'retained' } }];
        const deadlineAtMs = Date.now() + 10_000;
        const controller = new AbortController();
        const surface = createAgentExternalSessionsExecutionSurface(bounded(request => {
            expect(request.deadlineAtMs).toBe(deadlineAtMs);
            expect(request.maxSerializedBytes).toBe(2_048);
            expect(request.signal.aborted).toBe(false);
            return { ok: true, value: { candidates: request.candidates.map(row => ({ ...row, title: 'Hydrated' })) } };
        }));
        await expect(surface.hydrateCandidates!({ source: { kind: 'synthetic' }, candidates,
            signal: controller.signal, deadlineAtMs, maxBytes: 2_048 }))
            .resolves.toEqual([{ ...candidates[0], title: 'Hydrated' }]);
    });

    it('propagates invalid producer identity as the typed hydration failure', async () => {
        const surface = createAgentExternalSessionsExecutionSurface(bounded(request => ({ ok: true,
            value: { candidates: request.candidates.map(row => ({ ...row, remoteSessionId: 'different' })) } })));
        await expect(surface.hydrateCandidates!({ source: { kind: 'synthetic' },
            candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }] }))
            .rejects.toMatchObject({ name: 'ExternalSessionProviderFailureError', operation: 'hydrateCandidates',
                code: 'agent_error', retryable: false });
    });
});
