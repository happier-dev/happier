import * as React from 'react';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { act, renderScreen } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { t } from '@/text';
import { ShareSheet } from '../ShareSheet';
import { createMachineShareAdapter } from './machineShareAdapter';
import { useMachineShareController } from './useMachineShareController';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { machinesRoutes } from '../../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { sessionAccessSubjectKey } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { db } from '../../../../../server/sources/storage/db';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock({ renderItems: true });
});
const review = vi.hoisted(() => ({ confirm: undefined as undefined | ((value: boolean) => void) }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: async () => new Promise<boolean>(resolve => { review.confirm = resolve; }) } }).module;
});

const { createRequire } = getVitestNodeBuiltin<typeof import('node:module')>('node:module');
const jsdomModule: unknown = createRequire(import.meta.url)('jsdom');
if (typeof jsdomModule !== 'object' || jsdomModule === null || !('JSDOM' in jsdomModule)
    || typeof jsdomModule.JSDOM !== 'function') throw new Error('Browser document SDK unavailable');
// Browser DOM is the external accessibility boundary; keep the actual announcer real.
const BrowserDocument = jsdomModule.JSDOM as new (html: string) => Readonly<{ window: Readonly<{ document: Document; close(): void }> }>;

describe('Machine sharing save result through the real route and SQLite', () => {
    let database: LightSqliteHarness;
    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-machine-share-save-', initAuth: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 180_000);
    afterAll(async () => { if (database) await database.close(); });

    it.each(['account', 'group', 'team'] as const)('confirms and refreshes %s access, retains committed access on failure, and retries the exact intent', async kind => {
        review.confirm = undefined;
        const owner = await db.account.create({ data: { encryptionMode: 'plain', firstName: 'Alice' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain', firstName: 'Bob' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'workstation', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/alice', happyHomeDir: '/home/alice/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        let principal: PrincipalRefV1 = { kind: 'account', accountId: recipient.id };
        if (kind !== 'account') {
            const team = await db.team.create({ data: { name: 'QA Team' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'member' } });
            if (kind === 'group') {
                const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'QA Group', nameKey: 'qa-group' } });
                principal = { kind: 'group', teamId: team.id, groupId: group.id };
                await db.machineGroupGrant.create({ data: { machineId: machine.id, teamGroupId: group.id,
                    accessLevel: 'view', createdByAccountId: owner.id } });
            } else {
                principal = { kind: 'team', teamId: team.id };
                await db.machineTeamGrant.create({ data: { machineId: machine.id, teamId: team.id,
                    accessLevel: 'view', createdByAccountId: owner.id } });
            }
        } else await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: recipient.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const grantPrincipal = principal;
        const table = kind === 'account' ? 'MachineAccountGrant' : kind === 'team' ? 'MachineTeamGrant' : 'MachineGroupGrant';
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        await app.ready();
        const browser = new BrowserDocument('<!doctype html><html><body></body></html>');
        vi.stubGlobal('document', browser.window.document);
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-share-save.test', accountId: owner.id,
            settings: { actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: {} } },
        }], route: async request => {
            if (request.path !== `/v1/machines/${machine.id}/access`) return undefined;
            const response = await app.inject({ method: request.method, url: request.path,
                headers: { 'x-test-user-id': request.accountId ?? '', 'x-happier-account-stored-content-protocol': '4' },
                ...(request.body === undefined ? {} : { payload: request.body }) });
            return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
        } });
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: owner.id };
            let current: ReturnType<typeof useMachineShareController> | undefined;
            function Surface() {
                const controller = useMachineShareController({ machineId: machine.id, machineName: 'Devbox', scope });
                current = controller;
                return <ShareSheet model={controller.model} actions={controller.actions}
                    adapter={createMachineShareAdapter({ machineName: 'Devbox', online: true, controller })}
                    presentation="full" testID="machine-share-editor" />;
            }
            const screen = await renderScreen(<Surface />);
            const principalKey = sessionAccessSubjectKey(principal);
            const announcement = () => browser.window.document.querySelector('[data-happier-live-region="true"]')?.textContent;
            const grant = () => grantPrincipal.kind === 'account'
                ? db.machineAccountGrant.findUniqueOrThrow({ where: { machineId_accountId: { machineId: machine.id, accountId: recipient.id } } })
                : grantPrincipal.kind === 'team'
                    ? db.machineTeamGrant.findUniqueOrThrow({ where: { machineId_teamId: { machineId: machine.id, teamId: grantPrincipal.teamId } } })
                    : db.machineGroupGrant.findUniqueOrThrow({ where: { machineId_teamGroupId: { machineId: machine.id, teamGroupId: grantPrincipal.groupId } } });
            await vi.waitFor(() => expect(screen.findByTestId(`machine-share-grant-${principalKey}`)).not.toBeNull());
            await screen.pressByTestIdAsync(`machine-share-grant-${principalKey}`);
            await screen.pressByTestIdAsync(`machine-share-level:${principalKey}:admin`);
            await vi.waitFor(() => expect(review.confirm).toBeTypeOf('function'));
            expect(home.requests.filter(request => request.method === 'PUT')).toHaveLength(0);
            await act(async () => { review.confirm!(true); });
            await vi.waitFor(() => expect(announcement()).toBe(t('machines.sharing.saved')));
            expect(current?.model.grants[0]?.level.value).toBe('admin');
            expect(current?.model.grants[0]?.operation.kind).toBe('idle');
            expect((await grant()).accessLevel).toBe('admin');
            // A real storage failure after route admission rolls back the actual grant transaction.
            await db.$executeRawUnsafe(`CREATE TRIGGER reject_machine_share_downgrade BEFORE UPDATE ON ${table}
                WHEN NEW.accessLevel = 'view' BEGIN SELECT RAISE(ABORT, 'fixture-storage-failure'); END`);
            await screen.pressByTestIdAsync(`machine-share-level:${principalKey}:view`);
            await vi.waitFor(() => expect(screen.findByTestId(`machine-share-retry:${principalKey}`)).not.toBeNull());
            const operation = current?.model.grants[0]?.operation;
            expect(operation).toMatchObject({ kind: 'error', error: { code: 'machine_access_request_failed' } });
            if (operation?.kind !== 'error') throw new Error('Failed grant write was not exposed');
            await vi.waitFor(() => expect(announcement()).toBe(operation.error.message));
            expect((await grant()).accessLevel).toBe('admin');
            expect(current?.response?.grants[0]?.level).toBe('admin');
            await db.$executeRawUnsafe('DROP TRIGGER reject_machine_share_downgrade');
            await screen.pressByTestIdAsync(`machine-share-retry:${principalKey}`);
            await vi.waitFor(() => expect(current?.response?.grants[0]?.level).toBe('view'));
            await vi.waitFor(() => expect(announcement()).toBe(t('machines.sharing.saved')));
            expect((await grant()).accessLevel).toBe('view');
            expect(home.requests.filter(request => request.method === 'PUT').map(request => request.body)).toEqual([
                { principal: grantPrincipal, level: 'admin' },
                { principal: grantPrincipal, level: 'view' },
                { principal: grantPrincipal, level: 'view' },
            ]);
            expect(screen.findByTestId(`machine-share-retry:${principalKey}`)).toBeNull();
            await screen.unmount();
        } finally {
            await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS reject_machine_share_downgrade');
            await home.dispose();
            await app.close();
            browser.window.close();
            vi.unstubAllGlobals();
        }
    });
});
