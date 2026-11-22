import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ArtifactActionOutputSchemasV1} from '@happier-dev/protocol/artifacts/artifactActionsV1';
import {
    decodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import {
    normalizeActionsSettingsV1} from '@happier-dev/protocol/actions/actionSettings';
import { act, createDeferred, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { serveActionHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';

const transport = vi.hoisted(() => ({ download: vi.fn() }));
// Machine byte transfer is the boundary; the Action executor, source admission and Artifact writer remain real.
vi.mock('@/sync/domains/transfers/runtime/transferRuntime', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/domains/transfers/runtime/transferRuntime')>(),
    downloadDaemonWorkspaceFileToDestination: transport.download,
}));

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal'))
    .createModalModuleMock({ confirmResult: true, renderCustomModals: true }).module);

const { Modal, ModalProvider } = await import('@/modal');
const { createArtifactActionsClient } = await import('./artifactActionsClient');
const { useSaveWorkspaceFileAsArtifact } = await import('@/components/workspaces/files/file/useSaveWorkspaceFileAsArtifact');
let served: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let machineRoute: ((request: ServedHomeRequest) => Promise<Response | undefined>) | undefined;

async function serveArtifactAccount(serverUrl: string, actionId?: string, exactMachineApproval = false) {
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner-1', encryptionMode: 'plain' });
    served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl,
        ...(exactMachineApproval ? { serverIdentityId: 'srv_artifact-approval' } : {}), accountId: 'owner-1', currentAccount: true,
        ...(actionId ? { settings: { actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }) } } : {}),
    }], route: async request => await machineRoute?.(request)
        ?? (request.path === '/v1/features' || request.path === '/v1/features/authenticated'
            ? Response.json(createRootLayoutFeaturesResponse())
            : artifacts.handle(request.path, { method: request.method, body: JSON.stringify(request.body) }) ?? undefined) });
    await served.restoreActiveConnection();
    if (actionId) await vi.waitFor(() => expect(
        storage.getState().settings.actionsSettingsV1.actions[actionId]?.approvalRequiredSurfaces,
    ).toContain('ui'));
    return { serverId: served.homes.owner!.id, artifacts };
}

describe('Artifact surface pending approvals', () => {
    afterEach(async () => {
        Modal.hideAll();
        standardCleanup();
        await served?.dispose();
        served = undefined;
        machineRoute = undefined;
        transport.download.mockReset();
    });

    it('runs an explicitly confirmed deletion once without creating a second approval', async () => {
        const { serverId, artifacts } = await serveArtifactAccount('https://artifact-confirmed-delete.test');
        const client = createArtifactActionsClient({ serverId, accountId: 'owner-1' });
        const created = await client.createArtifact({ header: { kind: 'artifact.legacy', title: 'Draft' }, body: 'Draft body' });
        if ('approvalId' in created || !created.ok) throw new Error('Expected the existing document');
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        const result = await client.deleteArtifact({ artifactId: created.value.artifactId,
            expectedRevision: created.value.revision }, { confirmed: true });
        expect(result).toMatchObject({ ok: true });
        expect(artifacts.list()).toHaveLength(0);
        expect(Modal.confirm).not.toHaveBeenCalled();
    });

    it('saves an explicit-Ask UI document without manufacturing an agent approval', async () => {
        // 02102e614e1: the person's authenticated UI save answers the approval floor.
        const { serverId, artifacts } = await serveArtifactAccount('https://artifact-surface-create-ask.test', 'artifact.create');
        const client = createArtifactActionsClient({ serverId, accountId: 'owner-1' });
        const draft = { header: { kind: 'artifact.legacy', title: 'Draft' }, body: 'Draft body' };
        const review = await renderScreen(React.createElement(ModalProvider, null, null));
        let pending: ReturnType<typeof client.createArtifact> | undefined;
        act(() => { pending = client.createArtifact(draft); });
        await vi.waitFor(() => expect(review.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
        expect(artifacts.list()).toHaveLength(0);
        await review.pressByTestIdAsync('actions.confirmation-review.decision-approve');
        const outcome = await pending!;
        if (!('ok' in outcome) || !outcome.ok) throw new Error(`Expected acknowledged UI save: ${JSON.stringify(outcome)}`);
        expect(artifacts.list()).toHaveLength(1);
        expect(artifacts.readPlainBody(outcome.value.artifactId)).toBe(draft.body);
        expect(decodePlainArtifactStoredContent(artifacts.read(outcome.value.artifactId)!.header))
            .toMatchObject({ kind: draft.header.kind, title: draft.header.title });
        await review.unmount();
    });

    it('carries real create/update acknowledgements through the surface schema and refuses a stale edit without overwriting content', async () => {
        const { serverId, artifacts } = await serveArtifactAccount('https://artifact-surface-cas.test');
        const client = createArtifactActionsClient({ serverId, accountId: 'owner-1' });
        const draft = { header: { kind: 'artifact.legacy', title: 'Draft' }, body: 'Original 🔐' };
        const created = await client.createArtifact(draft);
        if (!('ok' in created) || !created.ok) throw new Error(`Create failed: ${JSON.stringify(created)}`);
        const { artifactId, revision } = ArtifactActionOutputSchemasV1['artifact.create'].parse(created.value);
        expect(artifacts.readPlainBody(artifactId)).toBe(draft.body);
        const update = { artifactId, expectedRevision: revision, header: draft.header, body: 'Latest content' };
        const updated = await client.updateArtifact(update);
        expect(updated).toEqual({ ok: true, value: { artifactId, revision: { headerVersion: 2, bodyVersion: 2 } } });
        expect(artifacts.readPlainBody(artifactId)).toBe(update.body);
        const stale = await client.updateArtifact({ ...update, body: 'Stale overwrite' });
        expect(stale).toMatchObject({ ok: false, failure: { code: 'version_mismatch' } });
        expect(artifacts.readPlainBody(artifactId)).toBe(update.body);
    });

    it.each(['session', 'workspace', 'workspace-with-session'] as const)('prefills a private %s file copy and publishes the edited title and path through the real UI composition', async sourceKind => {
        const { serverId, artifacts } = await serveArtifactAccount(`https://file-copy-dialog-${sourceKind}.test`);
        const session = createSessionFixture({ id: 'source-session', serverId,
            metadata: { ...createSessionFixture().metadata!,
                path: sourceKind === 'workspace-with-session' ? '/ambient' : '/repo',
                machineId: sourceKind === 'workspace-with-session' ? 'ambient-machine' : 'source-machine' } });
        storage.setState({ sessions: { [session.id]: session }, machineListByServerId: {
            [serverId]: [createMachineFixture({ id: 'source-machine' })],
        } });
        transport.download.mockImplementation(async (request: { machineId: string; rootPath: string; request: { path: string }; destination: { writeBytes(bytes: Uint8Array): Promise<void> } }) => {
            expect(request.machineId).toBe('source-machine');
            expect(request.rootPath).toBe('/repo');
            expect(request.request.path).toBe('docs/note.txt');
            await request.destination.writeBytes(new TextEncoder().encode('Copied bytes'));
            return { ok: true, name: 'note.txt', sizeBytes: 12 };
        });
        const hook = await renderHook(() => useSaveWorkspaceFileAsArtifact({ scope: { serverId, accountId: 'owner-1' },
            sourceSessionId: sourceKind === 'workspace' ? null : session.id,
            ...(sourceKind !== 'session' ? { sourceWorkspace: { machineId: 'source-machine', rootPath: '/repo' } } : {}),
            filePath: 'docs/note.txt', team: { teamId: 'team-1', name: 'Payments' } }));
        await act(async () => { hook.getCurrent().open(); });
        expect(hook.getCurrent().title).toBe('note.txt');
        expect(hook.getCurrent().visibility).toBe('private');
        await act(async () => { hook.getCurrent().setTitle('Notes for review'); });
        await flushHookEffects();
        expect(hook.getCurrent().canSubmit).toBe(true);
        let created: string | null = null;
        await act(async () => { created = await hook.getCurrent().submit(); });
        expect(hook.getCurrent().status.kind).toBe('saved');
        expect(created).toEqual(expect.any(String));
        expect(artifacts.readPlainBody(created!)).toBe('Copied bytes');
        expect(decodePlainArtifactStoredContent(artifacts.read(created!)!.header)).toMatchObject({ title: 'Notes for review' });
        expect(artifacts.list()).toHaveLength(1);
        await hook.unmount();
    });

    it.each(['session', 'project', 'unassociated'] as const)('binds the %s file audience to its source instead of another Account Team', async (sourceKind) => {
        const { serverId } = await serveArtifactAccount(`https://file-copy-source-team-${sourceKind}.test`);
        const { applyTeamProjection } = await import('@/sync/store/teams/teamsSnapshots');
        const session = createSessionFixture({ id: 'source-team-session', serverId });
        session.access = { ...session.access!, primaryTeamId: 'source-team' };
        storage.getState().applySessions([session]);
        const scope = { serverId, accountId: 'owner-1' };
        const team = teamSummaryFixture({ id: 'source-team', name: 'Source Team' });
        applyTeamProjection({ scope, address: { serverId, teamId: team.id }, team, observedAt: Date.now() });
        applyTeamProjection({ scope, address: { serverId, teamId: 'unrelated-team' },
            team: teamSummaryFixture({ id: 'unrelated-team', name: 'Another Team' }), observedAt: Date.now() });
        let sourceReads = 0;
        machineRoute = async request => {
            if (request.path !== '/v1/projects/sources/source-project') return undefined;
            sourceReads += 1;
            const { ProjectSourcesReadOutputV1Schema } = await import('@happier-dev/protocol/projects/sources/projectSourceV1');
            return Response.json(ProjectSourcesReadOutputV1Schema.parse({ ok: true, canManage: true, source: {
                id: 'source-project', revision: 1, name: 'Project Source', createdByAccountId: 'owner-1',
                audience: [{ principal: { kind: 'team', teamId: 'source-team' }, level: 'view' }],
                repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'acme/repo' }, protocol: 'https' },
            } }));
        };
        const hook = await renderHook(() => useSaveWorkspaceFileAsArtifact({ scope,
            sourceSessionId: sourceKind === 'session' ? session.id : null, filePath: 'docs/note.txt',
            sourceProject: sourceKind === 'project' ? { id: 'workspace-project', serverId, machineId: 'source-machine', rootPath: '/repo',
                label: null, createdAtMs: 1, lastOpenedAtMs: null, source: { sourceId: 'source-project', revision: 1 } } : null }));
        expect(sourceReads).toBe(0);
        await act(async () => { hook.getCurrent().open(); });
        if (sourceKind === 'unassociated') {
            expect(hook.getCurrent().team).toBeNull();
            await act(async () => hook.getCurrent().setVisibility('team'));
            expect(hook.getCurrent().visibility).toBe('private');
            await hook.unmount();
            return;
        }
        await vi.waitFor(() => expect(hook.getCurrent().team).toEqual({ teamId: 'source-team', name: 'Source Team' }));
        expect(sourceReads).toBe(sourceKind === 'project' ? 1 : 0);
        await act(async () => hook.getCurrent().setVisibility('team'));
        expect(hook.getCurrent().visibility).toBe('team');
        if (sourceKind === 'session') {
            await act(async () => { storage.getState().applySessions([{ ...session,
                access: { ...session.access!, primaryTeamId: 'unrelated-team' } }]); });
            await vi.waitFor(() => expect(hook.getCurrent().team?.teamId).toBe('unrelated-team'));
            expect(hook.getCurrent().visibility).toBe('private');
        }
        await hook.unmount();
    });

    it('shows the storage recovery link when a binary publication exceeds the Account quota', async () => {
        const { serverId, artifacts } = await serveArtifactAccount('https://file-copy-dialog-quota.test');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'source-machine' })] } });
        transport.download.mockImplementation(async (request: { destination: { writeBytes(bytes: Uint8Array): Promise<void> } }) => {
            await request.destination.writeBytes(Uint8Array.of(0, 255, 3));
            return { ok: true, name: 'copy.bin', sizeBytes: 3 };
        });
        let uploads = 0;
        machineRoute = async request => {
            if (request.path !== '/v1/artifacts/content/upload') return undefined;
            uploads++;
            return Response.json({ error: 'quota_exceeded', budget: 'account', limitBytes: 100, usedBytes: 125 }, { status: 413 });
        };
        const { SaveFileAsArtifactDialog } = await import('@/components/workspaces/files/file/SaveFileAsArtifactDialog');
        const screen = await renderScreen(React.createElement(SaveFileAsArtifactDialog, {
            source: { scope: { serverId, accountId: 'owner-1' }, sourceSessionId: null,
                sourceWorkspace: { machineId: 'source-machine', rootPath: '/repo' }, filePath: 'copy.bin' },
            sourceFacts: 'Project', onClose: () => {},
        }));
        try {
            await vi.waitFor(() => expect(screen.findByTestId('save-as-artifact-save')?.props.disabled).toBe(false));
            await screen.pressByTestIdAsync('save-as-artifact-save');
            await vi.waitFor(() => expect(uploads).toBe(1));
            await vi.waitFor(() => expect(screen.findByTestId('save-as-artifact-quota.action')).not.toBeNull());
            expect(screen.findByTestId('save-as-artifact-title')).not.toBeNull();
            expect(artifacts.list()).toHaveLength(0);
        } finally { await screen.unmount(); }
    });

    it('keeps the mounted UI publication pending through byte acquisition and saves its real receipt without an agent approval', async () => {
        const { serverId, artifacts } = await serveArtifactAccount('https://file-copy-dialog-approval.test', 'artifact.publish_from_file', true);
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'source-machine' })] } });
        const release = createDeferred<void>();
        transport.download.mockImplementation(async (request: { destination: { writeBytes(bytes: Uint8Array): Promise<void> } }) => {
            await release.promise;
            await request.destination.writeBytes(new TextEncoder().encode('Approved bytes'));
            return { ok: true, name: 'note.txt', sizeBytes: 14 };
        });
        const machine = { ...createPlainMachineRowFixture({ id: 'source-machine', accountId: 'owner-1' }),
            installationId: 'source-installation' };
        machineRoute = async request => {
            if (request.path === '/v1/machines') return Response.json([machine]);
            if (request.path === '/v1/machines/read-batch' && request.method === 'POST') {
                return createMachineReadBatchResponseFixture(request.body, id => id === machine.id ? machine : null);
            }
            if (request.path === '/v1/machines/source-machine') return Response.json({ machine });
            return undefined;
        };
        const hook = await renderHook(() => useSaveWorkspaceFileAsArtifact({ scope: { serverId, accountId: 'owner-1' },
            sourceSessionId: null, sourceWorkspace: { machineId: 'source-machine', rootPath: '/repo' }, filePath: 'docs/note.txt' }));
        const review = await renderScreen(React.createElement(ModalProvider, null, null));
        let operation: Promise<string | null> | undefined;
        let settled = false;
        await act(async () => { hook.getCurrent().open(); });
        await flushHookEffects();
        await act(async () => {
            operation = hook.getCurrent().submit();
            void operation.then(() => { settled = true; });
        });
        try {
            await vi.waitFor(() => expect(review.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
            expect(transport.download).not.toHaveBeenCalled();
            expect(artifacts.list()).toHaveLength(0);
            await review.pressByTestIdAsync('actions.confirmation-review.decision-approve');
            await vi.waitFor(() => expect(transport.download).toHaveBeenCalledOnce());
            expect(settled).toBe(false);
            expect(hook.getCurrent().canSubmit).toBe(false);
            expect(hook.getCurrent().status.kind).toBe('publishing');
            expect(hook.getCurrent().approval.approvalId).toBeNull();
            expect(artifacts.list()).toHaveLength(0);
        } finally { release.resolve(); }
        let created: string | null = null;
        await act(async () => { created = await operation!; });
        expect(settled).toBe(true);
        expect(hook.getCurrent().status, JSON.stringify(hook.getCurrent().status)).toMatchObject({ kind: 'saved', receipt: { artifactId: created } });
        expect(artifacts.readPlainBody(created!)).toBe('Approved bytes');
        expect(artifacts.list()).toHaveLength(1);
        await hook.unmount();
        await review.unmount();
    });

});
