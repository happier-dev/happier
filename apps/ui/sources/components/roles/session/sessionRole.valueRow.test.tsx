import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import type { Metadata } from '@happier-dev/session-core/state';
import { createSessionFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { createArtifactListHttpResponse } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

installDisconnectedServerSocketBoundary();
const { SessionRoleValueRow, isSessionRoleSnapshotCopiedAcrossOwners } = await import('./sessionRole');
const { invalidateRoleCatalog, useRoleCatalog } = await import('@/components/roles/catalog/useRoleCatalog');
const { storage } = await import('@/sync/domains/state/storageStore');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
let previousState = storage.getState();
let previousSnapshot = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();
let home: Awaited<ReturnType<typeof serveSessionActionHome>> | undefined;

function setMetadata(work: Partial<Metadata>) {
    storage.setState({ sessions: { lead: createSessionFixture({ id: 'lead', serverId: home!.serverId, metadata: { path: '/repo', host: 'test', ...work } }) } });
}

/** The composite that declared a testID (not the host it painted), for reading its declared props. */
function declared(screen: { findAll: (predicate: (node: any) => boolean) => any[] }, testID: string, prop: string) {
    return screen.findAll((node: any) => node.props?.testID === testID && node.props?.[prop] !== undefined)[0] ?? null;
}

function sessionRoles(roleId: string | null, overrides: Record<string, unknown> = {}) {
    return { work: { sessionRolesV1: { ...(roleId ? { roleId } : {}), overrides, sessionRoles: {}, notes: '' } } };
}

describe('Session Role value row (Work tab top row)', () => {
    beforeEach(async () => {
        previousState = storage.getState();
        previousSnapshot = getAppliedActiveServerSnapshot();
        previousAvailable = isAppliedActiveServerRuntimeAvailable();
        home = await serveSessionActionHome({
            homes: [{ key: 'roles', serverUrl: 'https://roles.test', accountId: 'account-1', currentAccount: true }],
            route: request => {
                if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (request.path === '/v1/artifacts') return createArtifactListHttpResponse(request.url, []);
                if (request.path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows: [{
                    key: 'role-overrides', revision: 1,
                    content: { t: 'plain', v: { key: 'role-overrides', value: { v: 1, overrides: {} } } },
                }] });
                return undefined;
            },
        });
        await home.restoreActiveConnection();
        await act(async () => { invalidateRoleCatalog(); });
        const catalog = await renderHook(() => useRoleCatalog());
        await vi.waitFor(() => expect(catalog.getCurrent().status).toBe('ready'));
    });
    afterEach(async () => {
        standardCleanup();
        if (home) await disconnectActiveServerConnection();
        await home?.dispose();
        home = undefined;
        await act(async () => {
            retireActiveServerAccountScopeLifetime();
            storage.setState(previousState);
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        });
    });

    it('compares the inherited lead and worker owners rather than treating all inheritance as cross-owner', () => {
        const metadata = { path: '/repo', host: 'test', work: { sessionRolesV1: {
            inheritedFrom: 'lead', overrides: {}, sessionRoles: {}, notes: 'Snapshot',
        } } };
        const worker = createSessionFixture({ id: 'worker', serverId: 'home', owner: 'worker-owner', metadata });
        const lead = createSessionFixture({ id: 'lead', serverId: 'home', owner: 'lead-owner' });
        expect(isSessionRoleSnapshotCopiedAcrossOwners(worker, lead, 'worker-owner')).toBe(true);
        expect(isSessionRoleSnapshotCopiedAcrossOwners({ ...worker, owner: 'lead-owner' }, lead, 'lead-owner')).toBe(false);
        expect(isSessionRoleSnapshotCopiedAcrossOwners({ ...worker, metadata: null }, lead, 'worker-owner')).toBe(false);
        expect(isSessionRoleSnapshotCopiedAcrossOwners(worker, { ...lead, serverId: 'other-home' }, 'worker-owner')).toBe(false);
        const ownWorker = { ...worker, owner: undefined, access: createSessionAccessFixture('owner') };
        const receivedLead = { ...lead, access: createSessionAccessFixture('edit') };
        expect(isSessionRoleSnapshotCopiedAcrossOwners(ownWorker, receivedLead, 'worker-owner')).toBe(true);
        expect(isSessionRoleSnapshotCopiedAcrossOwners({ ...worker, access: createSessionAccessFixture('edit') },
            { ...lead, owner: undefined, access: createSessionAccessFixture('owner') }, 'lead-owner')).toBe(true);
        expect(isSessionRoleSnapshotCopiedAcrossOwners(ownWorker,
            { ...lead, owner: undefined, access: createSessionAccessFixture('owner') }, 'worker-owner')).toBe(false);
        const ownerProjectedWorker = { ...worker, metadataLayoutVersion: 1, metadata: null, ownerMetadataView: metadata };
        expect(isSessionRoleSnapshotCopiedAcrossOwners(ownerProjectedWorker, lead, 'worker-owner')).toBe(true);
        expect(isSessionRoleSnapshotCopiedAcrossOwners({ ...ownerProjectedWorker, metadata, ownerMetadataView: null }, lead, 'worker-owner')).toBe(false);
    });

    it('names the copied role with hands-off and lets its owner open the Role popover', async () => {
        setMetadata({ work: { sessionRolesV1: {
            roleId: 'orchestrator', inheritedFrom: 'source-lead', overrides: {}, sessionRoles: {}, notes: '',
        } } });
        const screen = await renderScreen(<SessionRoleValueRow sessionId="lead" serverId={home!.serverId} testID="session-work-role" />);

        expect(declared(screen, 'session-work-role', 'detail')!.props.detail).toBe('Orchestrator ·\u00A0sessionWork.role.handsOff');

        await act(async () => {
            declared(screen, 'session-work-role', 'onPress')!.props.onPress();
        });
        expect(screen.findAll((node: any) => node.props?.anchorRef !== undefined && node.props?.onRequestClose !== undefined).length)
            .toBeGreaterThan(0);
    });

    it('drops hands-off when the session relaxed it, and says None without a role', async () => {
        setMetadata(sessionRoles('orchestrator', { orchestrator: { roleId: 'orchestrator', workspaceWrites: 'allow' } }));
        const relaxed = await renderScreen(<SessionRoleValueRow sessionId="lead" testID="session-work-role" />);
        expect(declared(relaxed, 'session-work-role', 'detail')!.props.detail).toBe('Orchestrator');

        await act(async () => { setMetadata(sessionRoles(null)); });
        const none = await renderScreen(<SessionRoleValueRow sessionId="lead" testID="session-work-role" />);
        expect(declared(none, 'session-work-role', 'detail')!.props.detail).toBe('sessionWork.role.none');
    });

});
