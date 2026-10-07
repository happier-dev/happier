import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { Metadata } from '@happier-dev/session-core/state';
import { createSessionFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => async (actionId: string) => {
        if (actionId === 'roles.list') {
            return { ok: true, result: { items: [
                { roleId: 'orchestrator', role: BUILT_IN_ROLES_V1.orchestrator, shared: false, viewOnly: false, migratedFromV0_2: false },
                { roleId: 'builder', role: BUILT_IN_ROLES_V1.builder, shared: false, viewOnly: false, migratedFromV0_2: false },
            ] } };
        }
        return { ok: true, result: { updated: true } };
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const { SessionRoleValueRow, isSessionRoleSnapshotCopiedAcrossOwners } = await import('./sessionRole');
const { invalidateRoleCatalog } = await import('@/components/roles/catalog/useRoleCatalog');
const { storage } = await import('@/sync/domains/state/storageStore');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
let previousState = storage.getState();
let previousSnapshot = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();

function setMetadata(work: Partial<Metadata>) {
    storage.setState({ sessions: { lead: createSessionFixture({ id: 'lead', serverId: 'server-1', metadata: { path: '/repo', host: 'test', ...work } }) } });
}

/** The composite that declared a testID (not the host it painted), for reading its declared props. */
function declared(screen: { findAll: (predicate: (node: any) => boolean) => any[] }, testID: string, prop: string) {
    return screen.findAll((node: any) => node.props?.testID === testID && node.props?.[prop] !== undefined)[0] ?? null;
}

function sessionRoles(roleId: string | null, overrides: Record<string, unknown> = {}) {
    return { work: { sessionRolesV1: { ...(roleId ? { roleId } : {}), overrides, sessionRoles: {}, notes: '' } } };
}

describe('Session Role value row (Work tab top row)', () => {
    beforeEach(async () => { await act(async () => {
        previousState = storage.getState();
        previousSnapshot = getAppliedActiveServerSnapshot();
        previousAvailable = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot({ serverId: 'server-1', serverUrl: 'https://roles.test', generation: 0 });
        storage.setState({ profileScope: { serverId: 'server-1', accountId: 'account-1' } });
        invalidateRoleCatalog();
    }); });
    afterEach(async () => {
        standardCleanup();
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
    });

    it('names the session\'s role with hands-off as its attribute, and opens the Role popover', async () => {
        setMetadata(sessionRoles('orchestrator'));
        const screen = await renderScreen(<SessionRoleValueRow sessionId="lead" testID="session-work-role" />);

        expect(declared(screen, 'session-work-role', 'detail')!.props.detail).toBe('Orchestrator · sessionWork.role.handsOff');

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

    it('lets the person edit the worker\'s copied Role', async () => {
        setMetadata(sessionRoles('orchestrator'));
        const screen = await renderScreen(<SessionRoleValueRow sessionId="lead" serverId="server-1" testID="session-work-role" />);
        expect(declared(screen, 'session-work-role', 'detail')!.props.detail).toBe('Orchestrator · sessionWork.role.handsOff');
        expect(declared(screen, 'session-work-role', 'onPress')).toBeTruthy();
    });
});
