import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ApprovalRequestV2Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import {
    ArtifactActionOutputSchemasV1} from '@happier-dev/protocol/artifacts/artifactActionsV1';
import {
    decodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import {
    normalizeActionsSettingsV1} from '@happier-dev/protocol/actions/actionSettings';
import {
    ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { act, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { serveActionHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { decideApprovalAsInbox, replayApprovedAsDaemon } from '@/dev/testkit/harness/approvalInbox';
import { storage } from '@/sync/domains/state/storageStore';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';

const transport = vi.hoisted(() => ({ download: vi.fn() }));
// Machine byte transfer is the boundary; the Action executor, source admission and Artifact writer remain real.
vi.mock('@/sync/domains/transfers/runtime/transferRuntime', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/domains/transfers/runtime/transferRuntime')>(),
    downloadDaemonWorkspaceFileToDestination: transport.download,
}));

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal'))
    .createModalModuleMock({ confirmResult: true }).module);

const { createArtifactActionsClient } = await import('./artifactActionsClient');
const { useSaveWorkspaceFileAsArtifact } = await import('@/components/workspaces/files/file/useSaveWorkspaceFileAsArtifact');
let served: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let machineRoute: ((request: ServedHomeRequest) => Promise<Response | undefined>) | undefined;
let disposeSourceAccount: (() => void) | undefined;

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
        standardCleanup();
        disposeSourceAccount?.(); disposeSourceAccount = undefined;
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

    it.each(['create', 'update', 'restore', 'delete', 'publish', 'export'] as const)('recognizes a durable %s approval before parsing the final acknowledgement', async (operation) => {
        const actionId = operation === 'restore' ? 'artifact.revisions.restore'
            : operation === 'publish' ? 'artifact.publish_from_file' : `artifact.${operation}`;
        const { serverId, artifacts } = await serveArtifactAccount(`https://artifact-surface-${operation}-approval.test`, actionId);
        // The default UI composition owns admission, approval creation, codecs and persistence.
        const client = createArtifactActionsClient({ serverId, accountId: 'owner-1' });
        const input = { artifactId: 'document-1', expectedRevision: { headerVersion: 2, bodyVersion: 3 } };
        const draft = { header: { kind: 'artifact.legacy', title: 'Draft' }, body: 'Draft body' };
        const publication = { path: 'src/file.ts', title: 'File' };
        const exported = { artifactId: input.artifactId, destination: 'client' as const, fileName: 'Draft.pdf' };
        const outcome = operation === 'publish' ? await client.publishWorkspaceFile(publication, { sessionId: 'source-session' })
            : operation === 'export' ? await client.exportArtifact(exported, { confirmed: true })
            : operation === 'create' ? await client.createArtifact(draft)
            : operation === 'update' ? await client.updateArtifact({ ...input, ...draft })
            : operation === 'restore'
            ? await client.restoreRevision({ ...input, bodyVersion: 1 })
            : await client.deleteArtifact(input, { confirmed: true });
        const rows = artifacts.list();
        expect(rows).toHaveLength(1);
        const approvalId = rows[0]!.id;
        const persisted = ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(approvalId)!));
        expect(persisted).toMatchObject({ status: 'open', actionId,
            executionOriginV1: { serverId, accountId: 'owner-1', actionId, authority: 'present_user' },
            actionArgs: operation === 'publish' ? publication : operation === 'export' ? exported : operation === 'create' ? draft : operation === 'update' ? { ...input, ...draft }
                : operation === 'restore' ? { ...input, bodyVersion: 1 } : input });
        expect(outcome).toEqual({ approvalId });
        expect(artifacts.read('document-1')).toBeNull();
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

    it('keeps the mounted workspace publication pending until approval delivers its real receipt', async () => {
        const { serverId, artifacts } = await serveArtifactAccount('https://file-copy-dialog-approval.test', 'artifact.publish_from_file', true);
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'source-machine' })] } });
        transport.download.mockImplementation(async (request: { destination: { writeBytes(bytes: Uint8Array): Promise<void> } }) => {
            await request.destination.writeBytes(new TextEncoder().encode('Approved bytes'));
            return { ok: true, name: 'note.txt', sizeBytes: 14 };
        });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { createUiArtifactAction } = await import('@/sync/ops/actions/artifactActionDeps');
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const account = await captureLazyActionAccountContext(serverId);
        disposeSourceAccount = () => account.dispose();
        const sourceAction = createUiArtifactAction(account);
        const machine = { ...createPlainMachineRowFixture({ id: 'source-machine', accountId: 'owner-1' }),
            installationId: 'source-installation' };
        machineRoute = async request => {
            if (request.method === 'POST' && request.path.startsWith('/v1/artifacts/')) {
                const response = await artifacts.handle(request.path, { method: request.method, body: JSON.stringify(request.body) });
                // The HTTP Home boundary also delivers the external change wake
                // a remote daemon's accepted write sends to this mounted client.
                if (response?.ok) publishHomeAccountChange(serverId, [request.path.split('/').at(-1)!], { changeKinds: ['artifact'] });
                return response ?? undefined;
            }
            if (request.path === '/v1/machines') return Response.json([machine]);
            if (request.path === '/v1/machines/read-batch' && request.method === 'POST') {
                return createMachineReadBatchResponseFixture(request.body, id => id === machine.id ? machine : null);
            }
            if (request.path === '/v1/machines/source-machine') return Response.json({ machine });
            if (request.path !== '/v1/actions/approval.request.decide') return undefined;
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.body);
            expect(envelope.target).toMatchObject({ kind: 'machine', machineId: 'source-machine' });
            const args = getActionSpec('approval.request.decide').inputSchema.parse(envelope.input);
            if (!args || typeof args !== 'object' || !('artifactId' in args) || typeof args.artifactId !== 'string')
                throw new Error('Approval Artifact identity is required');
            const execution = await replayApprovedAsDaemon({ serverId, machineId: 'source-machine', artifactId: args.artifactId,
                decision: 'approve', artifactAction: sourceAction });
            return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide',
                requestId: envelope.requestId, execution }));
        };
        const hook = await renderHook(() => useSaveWorkspaceFileAsArtifact({ scope: { serverId, accountId: 'owner-1' },
            sourceSessionId: null, sourceWorkspace: { machineId: 'source-machine', rootPath: '/repo' }, filePath: 'docs/note.txt' }));
        let operation: Promise<string | null> | undefined;
        let settled = false;
        await act(async () => { hook.getCurrent().open(); });
        await flushHookEffects();
        await act(async () => {
            operation = hook.getCurrent().submit();
            void operation.then(() => { settled = true; });
        });
        await vi.waitFor(() => expect(hook.getCurrent().approval.approvalId).toEqual(expect.any(String)));
        expect(settled).toBe(false);
        expect(hook.getCurrent().canSubmit).toBe(false);
        expect(hook.getCurrent().status.kind).toBe('publishing');
        const approvalId = hook.getCurrent().approval.approvalId!;
        const decision = decideApprovalAsInbox(serverId, approvalId, 'approve');
        await vi.waitFor(() => {
            const request = ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(approvalId)!));
            expect(request.status, JSON.stringify(request)).toBe('executed');
        });
        expect(await decision).toMatchObject({ ok: true });
        let created: string | null = null;
        await act(async () => { created = await operation!; });
        expect(settled).toBe(true);
        expect(hook.getCurrent().status, JSON.stringify(hook.getCurrent().status)).toMatchObject({ kind: 'saved', receipt: { artifactId: created } });
        expect(artifacts.readPlainBody(created!)).toBe('Approved bytes');
        expect(artifacts.list()).toHaveLength(2);
        await hook.unmount();
    });

});
