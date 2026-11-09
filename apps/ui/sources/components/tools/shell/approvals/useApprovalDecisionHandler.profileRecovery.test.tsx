import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { renderHook, standardCleanup } from '@/dev/testkit';

const boundary = vi.hoisted(() => ({
    execute: vi.fn(async () => ({ ok: true as const, result: {} })),
    profileGeneration: 0,
    profileId: null as string | null,
    profileListeners: new Set<(generation: number) => void>(),
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute: boundary.execute }),
    resolveApprovalReplayRoute: (approval: ApprovalRequestV2) => boundary.profileId
        ? {
            serverId: boundary.profileId,
            serverIdentityId: approval.executionOriginV1.serverIdentityId,
            originServerId: approval.executionOriginV1.serverId,
        }
        : null,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => null,
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createPartialServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createPartialServerProfilesModuleMock(importOriginal, {
        overrides: {
            resolveServerProfileForPortableIdentity: (serverIdentityIdRaw: string | null | undefined) => {
                const serverIdentityId = serverIdentityIdRaw?.trim() ?? '';
                return boundary.profileId && serverIdentityId
                    ? {
                    kind: 'resolved',
                    serverIdentityId,
                    profile: {
                        id: boundary.profileId,
                        serverIdentityId,
                        name: 'Test Home',
                        serverUrl: 'https://home.example.test',
                        createdAt: 0,
                        updatedAt: 0,
                        lastUsedAt: 0,
                    },
                }
                    : { kind: 'missing', serverIdentityId };
            },
            getServerProfilesGeneration: () => boundary.profileGeneration,
            subscribeServerProfiles: (listener: (generation: number) => void) => {
                boundary.profileListeners.add(listener);
                return () => boundary.profileListeners.delete(listener);
            },
        },
    });
});

function daemonApprovalRequest(): ApprovalRequestV2 {
    return {
        v: 2,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system', sessionId: 'session-1' },
        requestedSurface: 'api',
        executionOriginV1: {
            v: 1,
            authority: 'account_automation',
            surface: 'api',
            caller: { kind: 'host' },
            serverId: 'creator-local-home',
            serverIdentityId: 'stable-home-a',
            accountId: 'account-1',
            principalId: 'principal-1',
            credentialId: 'credential-1',
            sessionId: 'session-1',
            machineId: 'machine-exact',
            target: { kind: 'session', sessionId: 'session-1' },
            actionId: 'session.title.set',
            requestId: 'request-1',
        },
        actionId: 'session.title.set',
        actionArgs: { sessionId: 'session-1', title: 'Current title' },
        summary: 'Set session title',
    };
}

afterEach(() => {
    boundary.execute.mockClear();
    boundary.profileGeneration = 0;
    boundary.profileId = null;
    standardCleanup();
});

describe('useApprovalDecisionHandler portable Home recovery', () => {
    it('makes the immutable replay route available after the matching profile arrives without remounting', async () => {
        const approval = daemonApprovalRequest();
        const artifact = { id: 'approval-1', header: { kind: 'approval_request.v1' as const, title: null } };
        const { useApprovalDecisionHandler } = await import('./useApprovalDecisionHandler');
        const hook = await renderHook(() => useApprovalDecisionHandler(artifact, approval, 'session-1'));

        await expect(hook.getCurrent()('approve')).rejects.toMatchObject({ code: 'approval_origin_unavailable' });
        expect(boundary.execute).not.toHaveBeenCalled();

        await act(async () => {
            boundary.profileId = 'current-local-home';
            boundary.profileGeneration += 1;
            for (const listener of boundary.profileListeners) listener(boundary.profileGeneration);
        });

        await expect(hook.getCurrent()('approve')).resolves.toBe(true);
        expect(boundary.execute).toHaveBeenCalledExactlyOnceWith(
            'approval.request.decide',
            { artifactId: 'approval-1', decision: 'approve' },
            { surface: 'ui', serverId: 'current-local-home' },
        );
    });

    it('approves an agent’s window choice with the window the person picked, as the present user', async () => {
        boundary.profileId = 'current-local-home';
        const approval = { ...daemonApprovalRequest(), actionId: 'computer.target.select' as const,
            actionArgs: { machineId: 'machine-exact', requestedTarget: 'Safari' } };
        const artifact = { id: 'approval-2', header: { kind: 'approval_request.v1' as const, title: null } };
        const { useApprovalDecisionHandler } = await import('./useApprovalDecisionHandler');
        const hook = await renderHook(() => useApprovalDecisionHandler(artifact, approval, 'session-1'));
        const chosen = { kind: 'window', displayId: ':0', pid: 10, windowId: 3 } as const;

        const narrowedInput = { ...approval.actionArgs, target: chosen, access: 'see' };
        await expect(hook.getCurrent()('approve', { narrowedInput })).resolves.toBe(true);
        expect(boundary.execute).toHaveBeenCalledExactlyOnceWith(
            'approval.request.decide',
            { artifactId: 'approval-2', decision: 'approve', narrowedInput },
            { surface: 'ui', authority: 'present_user', serverId: 'current-local-home' },
        );
    });
});
