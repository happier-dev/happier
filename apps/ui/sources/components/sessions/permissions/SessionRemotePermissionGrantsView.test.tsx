import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionPermissionRemoteGrantSummaryV1Schema } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';

const sessionRpcWithServerScope = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn<() => Promise<boolean>>());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope,
}));

vi.mock('@/modal', () => ({
    Modal: { confirm },
}));

const activeGrant = SessionPermissionRemoteGrantSummaryV1Schema.parse({
    requestId: 'request-1',
    settlementId: 'settlement-1',
    grantId: 'grant-1',
    sourceRef: 'source-1',
    sourceRevisionOrEpoch: 'revision-1',
    admittedPermissionCeiling: 'safe-yolo',
    actor: { namespace: 'external', principalId: 'alice' },
    createdAtMs: 1,
    projection: {
        kind: 'owner',
        rule: { kind: 'exactTool', identifier: 'filesystem.read' },
    },
});

const secondActiveGrant = SessionPermissionRemoteGrantSummaryV1Schema.parse({
    ...activeGrant,
    requestId: 'request-2',
    settlementId: 'settlement-2',
    grantId: 'grant-2',
    projection: {
        kind: 'owner',
        rule: { kind: 'exactTool', identifier: 'filesystem.write' },
    },
});

async function renderGrantsView() {
    const { SessionRemotePermissionGrantsView } = await import('./SessionRemotePermissionGrantsView');
    return renderScreen(<SessionRemotePermissionGrantsView sessionId="session-1" serverId="server-owner" />);
}

describe('SessionRemotePermissionGrantsView', () => {
    beforeEach(() => {
        sessionRpcWithServerScope.mockReset();
        confirm.mockReset();
        confirm.mockResolvedValue(true);
    });

    it('uses the owner Action path to list, revoke, and re-read the authoritative grant record', async () => {
        sessionRpcWithServerScope
            .mockResolvedValueOnce({ grants: [activeGrant], nextCursor: null })
            .mockResolvedValueOnce({ status: 'revoked', grantId: activeGrant.grantId })
            .mockResolvedValueOnce({
                grants: [{ ...activeGrant, revokedAtMs: 2 }],
                nextCursor: null,
            });

        const screen = await renderGrantsView();

        await vi.waitFor(() => expect(sessionRpcWithServerScope).toHaveBeenCalledTimes(1));
        expect(sessionRpcWithServerScope).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owner',
            method: 'session.permission.remote.grants.list',
            payload: { sessionId: 'session-1', limit: 50 },
        });
        expect(screen.findByTestId('session-remote-permission-grant-grant-1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Active grant from external:alice');

        await act(async () => {
            screen.pressByTestId('session-remote-permission-grant-grant-1-revoke');
        });
        await vi.waitFor(() => expect(sessionRpcWithServerScope).toHaveBeenCalledTimes(3));

        expect(sessionRpcWithServerScope).toHaveBeenNthCalledWith(2, {
            sessionId: 'session-1',
            serverId: 'server-owner',
            method: 'session.permission.remote.grants.revoke',
            payload: {
                sessionId: 'session-1',
                requestId: 'request-1',
                grantId: 'grant-1',
            },
        });
        expect(sessionRpcWithServerScope).toHaveBeenNthCalledWith(3, {
            sessionId: 'session-1',
            serverId: 'server-owner',
            method: 'session.permission.remote.grants.list',
            payload: { sessionId: 'session-1', limit: 50 },
        });
        expect(screen.getTextContent()).toContain('Revoked grant from external:alice');
        expect(screen.findByTestId('session-remote-permission-grant-grant-1-revoke')).toBeNull();
    });

    it('fails closed when a response lacks the owner-only grant projection', async () => {
        sessionRpcWithServerScope.mockResolvedValueOnce({
            grants: [{
                ...activeGrant,
                projection: { kind: 'mediator' },
            }],
            nextCursor: null,
        });

        const screen = await renderGrantsView();

        await vi.waitFor(() => expect(sessionRpcWithServerScope).toHaveBeenCalledTimes(1));
        expect(screen.findByTestId('session-remote-permission-grants-unavailable')).toBeTruthy();
        expect(screen.findByTestId('session-remote-permission-grants-unavailable-diagnostic-invalid_grant_projection')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('invalid_grant_projection');
        expect(screen.getTextContent()).not.toContain('filesystem.read');
    });

    it('shows the typed empty state when the owner has no remote grants', async () => {
        sessionRpcWithServerScope.mockResolvedValueOnce({ grants: [], nextCursor: null });

        const screen = await renderGrantsView();

        await vi.waitFor(() => expect(sessionRpcWithServerScope).toHaveBeenCalledTimes(1));
        expect(screen.findByTestId('session-remote-permission-grants-empty')).toBeTruthy();
        expect(screen.getTextContent()).toContain('No remote permission grants');
    });

    it('uses the server-issued cursor to load all owner-visible grants', async () => {
        sessionRpcWithServerScope
            .mockResolvedValueOnce({ grants: [activeGrant], nextCursor: 'cursor-2' })
            .mockResolvedValueOnce({ grants: [secondActiveGrant], nextCursor: null });

        const screen = await renderGrantsView();

        await vi.waitFor(() => expect(screen.findByTestId('session-remote-permission-grants-load-more')).toBeTruthy());
        await act(async () => {
            screen.pressByTestId('session-remote-permission-grants-load-more');
        });
        await vi.waitFor(() => expect(sessionRpcWithServerScope).toHaveBeenCalledTimes(2));

        expect(sessionRpcWithServerScope).toHaveBeenNthCalledWith(2, {
            sessionId: 'session-1',
            serverId: 'server-owner',
            method: 'session.permission.remote.grants.list',
            payload: { sessionId: 'session-1', limit: 50, cursor: 'cursor-2' },
        });
        expect(screen.findByTestId('session-remote-permission-grant-grant-1')).toBeTruthy();
        expect(screen.findByTestId('session-remote-permission-grant-grant-2')).toBeTruthy();
    });

    it('preserves the authoritative row after a typed revoke rejection', async () => {
        sessionRpcWithServerScope
            .mockResolvedValueOnce({ grants: [activeGrant], nextCursor: null })
            .mockResolvedValueOnce({ status: 'rejected', code: 'ownerMachineUnavailable' });

        const screen = await renderGrantsView();
        await vi.waitFor(() => expect(sessionRpcWithServerScope).toHaveBeenCalledTimes(1));
        await act(async () => {
            screen.pressByTestId('session-remote-permission-grant-grant-1-revoke');
        });
        await vi.waitFor(() => expect(sessionRpcWithServerScope).toHaveBeenCalledTimes(2));

        expect(sessionRpcWithServerScope).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('session-remote-permission-grant-grant-1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Could not update remote permission grants');
        expect(screen.getTextContent()).not.toContain('ownerMachineUnavailable');
    });
});
