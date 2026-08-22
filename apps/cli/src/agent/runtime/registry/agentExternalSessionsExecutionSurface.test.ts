import { describe, expect, it, vi } from 'vitest';

import type {
    BoundedAgentExternalSessionsContribution,
} from '@/session/external/agentExternalSessionsInvocation';

import { createAgentExternalSessionsExecutionSurface } from './agentExternalSessionsExecutionSurface';

function createContribution(): BoundedAgentExternalSessionsContribution {
    return Object.freeze({
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
        expect(result.vendorMetadata).toEqual({ codexBackendMode: 'appServer' });
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
            deadlineAtMs: 2_000,
        });

        expect(contribution.pageTranscript).toHaveBeenCalledWith(
            expect.objectContaining({ deadlineAtMs: 2_000 }),
        );
        vi.useRealTimers();
    });
});
