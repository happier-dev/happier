import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createProjectSourceActionDeps } from '@/sync/api/projects/projectSourceActions';
import { createProjectSourcesController } from '@/components/projects/sources/projectSourcesController';
import { presentProjectSourceShareFailure, useProjectSourceShareController } from './useProjectSourceShareController';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { getStorage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { presentProjectSourceIssue } from '@/components/projects/sources/projectSourceIssue';
import { ProjectSourcesUpdateInputV1Schema, type ProjectSourceRepositorySelectorV1,
    type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { projectPrivateLabelForRecipientV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { createLegacyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { flushHookEffects } from '@/dev/testkit';
import { createPrivateLabelClient } from '@/sync/ops/privateLabels/privateLabelClient';
import { teamGroupNameBinding } from '@/sync/ops/teams/teamGroupLabels';
import { readSharePrincipalNames } from '../sharePrincipalNames';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();

const scope = { serverId: 'home-a', accountId: 'owner-a' };
const principal = { kind: 'team' as const, teamId: 'team-a' };
const repository = { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
    repository: { nameWithOwner: 'owner/repo', visibility: 'private' }, protocol: 'https' } satisfies ProjectSourceRepositorySelectorV1;

describe('Source audience ShareSheet controller', () => {
    afterEach(async () => { await homes.reset(); });

    it('keeps authorized Group grant names on open and reopen without browsing the lazy directory', async () => {
        installHomeGovernanceBoundaries(homes);
        await homes.reset();
        const secret = new Uint8Array(32).fill(52);
        const credentials = { token: createAccountTokenForTests(scope.accountId, { currentAccount: true }), secret: encodeBase64(secret, 'base64url') };
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        if (!encryption) throw new Error('E2EE fixture needs actual key material');
        const serverUrl = 'https://source-grant-labels.test';
        const serverId = await homes.addHome({ name: 'Source sharing Home', serverUrl, accountId: scope.accountId,
            teamsEnabled: true, currentAccount: true, accountEncryptionMode: 'e2ee', credentials });
        const ownedScope = { serverId, accountId: scope.accountId };
        homes.answer(serverId, 'GET /v1/account/encryption/currentness', { body: createLegacyAccountEncryptionCurrentnessFixture({ secret }) });
        homes.answer(serverId, '/v1/account/private-labels/recipient-census', { body: { contentEncryptionMode: 'e2ee', recipients: [{
            account: { kind: 'account', accountId: scope.accountId, firstName: null, lastName: null, username: null, avatarUrl: null },
            readiness: { status: 'available', contentPublicKey: encodeBase64(encryption.contentDataKey),
                contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey) }, envelopeStatus: 'missing',
        }] } });
        const group = { kind: 'group', teamId: principal.teamId, groupId: 'existing-private-group' } as const;
        const sealed = await createPrivateLabelClient(ownedScope).seal({ owner: principal,
            binding: teamGroupNameBinding(group.groupId), value: 'TH177 Group' });
        if (!sealed) throw new Error('Group label sealing failed');
        expect(sealed.content.t).toBe('encrypted');
        expect(JSON.stringify(sealed)).not.toContain('TH177 Group');
        homes.answer(serverId, 'POST /v1/session-access/principals/resolve', { body: { v: 1, principals: [
            { ...group, name: { kind: 'available', label: projectPrivateLabelForRecipientV1({ stored: sealed, recipientAccountId: scope.accountId }) }, teamName: 'Payments' },
            { ...principal, name: 'Payments' },
        ] } });
        // Control: the real authorized resolver, credential capture and cipher can open this exact label.
        const names = await readSharePrincipalNames([group, principal], ownedScope);
        expect(names.get(`group:${principal.teamId}:${group.groupId}`)).toBe('TH177 Group, Payments');
        homes.answer(serverId, 'POST /v1/teams/list', { body: { items: [], nextCursor: null } });
        const unknown = { kind: 'account', accountId: 'unresolved-account-id' } as const;
        const source: ProjectSourceV1 = { id: 'source-existing-group-grant', revision: 2, name: 'Repository',
            createdByAccountId: scope.accountId, repository,
            audience: [group, principal, unknown].map(principal => ({ principal, level: 'view' })) };
        homes.answer(serverId, `GET /v1/projects/sources/${source.id}`, { body: { ok: true, canManage: true, source } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            ...createProjectSourceActionDeps({ ...ownedScope, credentialAuthorityKind: 'account', assertCurrent() {},
                workflowArtifacts: { read: async () => null }, request: (path, init) => homes.request(`${serverUrl}${path}`, init) }),
        }));
        const controller = createProjectSourcesController(ownedScope, (id, input, context) => executor.execute(id, input,
            { ...context, authority: 'present_user', bypassApprovals: true }));
        await controller.select(source.id);
        const exactReads = () => homes.requestsFor('/v1/session-access/principals/resolve').length;
        const beforeClosed = homes.requests.length;
        const hook = await renderHook((enabled: boolean) => useProjectSourceShareController({ controller, enabled }),
            { initialProps: false, flushOptions: { cycles: 25 } });
        await flushHookEffects({ cycles: 25 });
        expect(homes.requests).toHaveLength(beforeClosed);
        const beforeOpen = exactReads();
        await hook.rerender(true);
        await flushHookEffects({ cycles: 25 });
        expect(hook.getCurrent().model.directory.sections.flatMap(section => section.candidates)).toEqual([]);
        const opened = hook.getCurrent().model.grants.map(row => row.principal.displayName);
        await hook.rerender(false);
        await flushHookEffects({ cycles: 25 });
        const afterClosed = homes.requests.length;
        await hook.rerender(false);
        await flushHookEffects({ cycles: 25 });
        expect(homes.requests).toHaveLength(afterClosed);
        await hook.unmount();
        const reopened = await renderHook(() => useProjectSourceShareController({ controller, enabled: true }), { flushOptions: { cycles: 25 } });
        try {
            await flushHookEffects({ cycles: 25 });
            expect(reopened.getCurrent().model.grants.map(row => row.grant)).toEqual([group, principal, unknown]);
            expect(reopened.getCurrent().model.grants.at(-1)?.principal.accessibilityLabel).not.toContain(unknown.accountId);
            expect(homes.requestsFor('/v1/teams/groups/list')).toEqual([]);
            const expected = ['TH177 Group, Payments', 'Payments', t('accountDisplay.unnamed')];
            expect([opened, reopened.getCurrent().model.grants.map(row => row.principal.displayName)]).toEqual([expected, expected]);
            expect(exactReads() - beforeOpen).toBe(2);
        } finally { await reopened.unmount(); }
    });

    it('distinguishes Source write permission refusals from Source withdrawal', () => {
        expect(presentProjectSourceShareFailure('source_conflict')).toBe(t('projects.sources.changed'));
        expect(presentProjectSourceShareFailure('outcome_unknown')).toBe(t('projects.sources.outcomeUnknown'));
        for (const code of ['source_access_denied', 'action_forbidden']) {
            expect(presentProjectSourceIssue(code, 'Home')).toEqual({ title: t('errors.permissionDenied'), tone: 'warning' });
        }
        expect(presentProjectSourceShareFailure('source_access_denied')).toBe(t('errors.permissionDenied'));
        expect(presentProjectSourceShareFailure('action_forbidden')).toBe(t('errors.permissionDenied'));
        expect(presentProjectSourceShareFailure('source_unavailable')).toBe(t('projects.sources.unavailable'));
        expect(presentProjectSourceIssue('source_unavailable', 'Home')).toEqual({
            title: t('projects.sources.unavailable'), description: t('projects.sources.unavailableBody'), tone: 'neutral',
        });
        expect(presentProjectSourceShareFailure('source_save_failed')).toBe(t('projects.sources.saveFailed'));
        expect(presentProjectSourceShareFailure('future_source_failure')).toBeNull();
    });

    it('presents the named creator as You and never exposes unresolved audience ids as names', async () => {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            ...createProjectSourceActionDeps({ ...scope, credentialAuthorityKind: 'account', assertCurrent() {}, workflowArtifacts: { read: async () => null },
                request: async () => Response.json({ ok: true, canManage: true, source: {
                    id: 'source-identity', revision: 1, name: 'Repository', createdByAccountId: scope.accountId, repository,
                    audience: [{ principal, level: 'view' }, { principal: { kind: 'account', accountId: 'unknown-person-id' }, level: 'view' }],
                } }),
            }),
        }));
        getStorage().setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId, firstName: 'Avery', lastName: 'Owner' }) });
        const controller = createProjectSourcesController(scope, (id, input, context) => executor.execute(id, input,
            { ...context, authority: 'present_user', bypassApprovals: true }));
        await controller.select('source-identity');
        const hook = await renderHook(() => useProjectSourceShareController({ controller, enabled: false }));
        expect(hook.getCurrent().model.owner?.principal.displayName).toBe('Avery Owner');
        expect(hook.getCurrent().model.owner?.principal.secondaryLabel).toBe(t('shareSheet.you'));
        expect(hook.getCurrent().model.grants.map(row => row.principal.displayName)).toEqual([t('shareSheet.team'), t('accountDisplay.unnamed')]);
        expect(hook.getCurrent().model.grants.map(row => row.principal.accessibilityLabel).join(' ')).not.toContain('unknown-person-id');
        await hook.unmount();
    });
    it.each([
        { description: 'no additional grants', audience: [] },
        { description: 'an explicit grant to that same Team', audience: [{ principal, level: 'view' as const }] },
    ])('presents the owning Team once with $description', async ({ audience }) => {
        const source: ProjectSourceV1 = { id: 'team-source', revision: 1, name: 'Repository',
            createdByAccountId: scope.accountId, repository, owner: principal, audience,
            audienceTeams: [{ teamId: principal.teamId, name: 'Payments' }] };
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            ...createProjectSourceActionDeps({ ...scope, credentialAuthorityKind: 'account', assertCurrent() {}, workflowArtifacts: { read: async () => null },
                request: async () => Response.json({ ok: true, canManage: true, source }),
            }),
        }));
        const controller = createProjectSourcesController(scope, (id, input, context) => executor.execute(id, input,
            { ...context, authority: 'present_user', bypassApprovals: true }));
        await controller.select(source.id);
        const hook = await renderHook(() => useProjectSourceShareController({ controller, enabled: false }));
        try {
            expect(hook.getCurrent().model.owner?.principal).toMatchObject({ ref: principal, displayName: 'Payments' });
            expect(hook.getCurrent().model.grants).toEqual([]);
        } finally {
            await hook.unmount();
        }
    });
    it('offers view-only audience and serializes additions and removals against acknowledged Source revisions', async () => {
        let source: ProjectSourceV1 = { id: 'source-a', revision: 1, name: 'Repository', createdByAccountId: scope.accountId,
            repository,
            audience: [] };
        const writes: unknown[] = [];
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            ...createProjectSourceActionDeps({ ...scope, credentialAuthorityKind: 'account', assertCurrent() {}, workflowArtifacts: { read: async () => null },
                request: async (_path, init) => {
                    if (init?.method === 'PATCH') {
                        const input = ProjectSourcesUpdateInputV1Schema.parse(JSON.parse(String(init.body)));
                        writes.push(input);
                        source = { ...source, revision: source.revision + 1, audience: input.patch.audience ?? source.audience };
                    }
                    return new Response(JSON.stringify({ ok: true, source, canManage: true }));
                },
            }),
        }));
        const controller = createProjectSourcesController(scope, (id, input, context) => executor.execute(id, input,
            { ...context, authority: 'present_user', bypassApprovals: true }));
        await controller.select(source.id);
        // Closed directory demand uses the real directory hook without Account/Team lookup traffic.
        const hook = await renderHook(() => useProjectSourceShareController({ controller, enabled: false }));
        await act(async () => { hook.getCurrent().actions.addPrincipal(principal); });
        expect(hook.getCurrent().model.grants[0].level).toEqual({ kind: 'editable', value: 'view', options: ['view'] });
        expect(hook.getCurrent().model.revision).toBe(2);
        // Only the exact row under review may submit a live Source removal.
        await act(async () => { hook.getCurrent().actions.confirmRemove(principal); });
        expect(writes).toHaveLength(1);
        await act(async () => { hook.getCurrent().actions.requestRemove(principal); });
        expect(writes).toHaveLength(1);
        expect(hook.getCurrent().model.grants[0].removal.kind).toBe('confirming');
        await act(async () => { hook.getCurrent().actions.cancelRemove(principal); });
        expect(hook.getCurrent().model.grants[0].removal.kind).toBe('allowed');
        await act(async () => { hook.getCurrent().actions.requestRemove(principal); });
        await act(async () => { hook.getCurrent().actions.confirmRemove({ kind: 'team', teamId: 'other' }); });
        expect(writes).toHaveLength(1);
        await act(async () => { hook.getCurrent().actions.confirmRemove(principal); });
        expect(hook.getCurrent().model.grants).toEqual([]);
        expect(writes).toEqual([
            { serverId: scope.serverId, sourceId: source.id, expectedRevision: 1, patch: { audience: [{ principal, level: 'view' }] } },
            { serverId: scope.serverId, sourceId: source.id, expectedRevision: 2, patch: { audience: [] } },
        ]);
        await hook.unmount();
    });

    it('does not grant management from audience membership or creator identity', async () => {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            ...createProjectSourceActionDeps({ ...scope, credentialAuthorityKind: 'account', assertCurrent() {}, workflowArtifacts: { read: async () => null },
                request: async () => new Response(JSON.stringify({ ok: true, canManage: false, source: {
                    id: 'source-a', revision: 1, name: 'Repository', createdByAccountId: scope.accountId,
                    repository,
                    audience: [{ principal, level: 'view' }],
                } })),
            }),
        }));
        const controller = createProjectSourcesController(scope, (id, input, context) => executor.execute(id, input,
            { ...context, authority: 'present_user', bypassApprovals: true }));
        await controller.select('source-a');
        const hook = await renderHook(() => useProjectSourceShareController({ controller, enabled: false }));
        expect(hook.getCurrent().model.editable).toBe(false);
        await act(async () => { hook.getCurrent().actions.addPrincipal({ kind: 'team', teamId: 'other' }); });
        expect(controller.getSnapshot().current?.revision).toBe(1);
        expect(hook.getCurrent().model.grants).toHaveLength(1);
        await hook.unmount();
    });
});
