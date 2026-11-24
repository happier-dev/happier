// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { SESSION_WORKSPACE_RETURN_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/sessionWorkspaceReturnActionIdsV1';
import { buildSessionCreationCorrespondence } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';

import { standardCleanup } from '@/dev/testkit';
import { createTestSessionTranscriptSource, wrapWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '../views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries({ platformOS: 'web' });
vi.doMock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ renderCustomModals: true }).module;
});
await prepareSessionFilesViewTestkit();
const { Modal, ModalProvider } = await import('@/modal');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { scmFileStatusFromChange } = await import('@/scm/scmStatusFiles');
const { TranscriptTurnChangesCard } = await import('./TranscriptTurnChangesCard');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { standardCleanup(); Modal.hideAll(); await fixture?.dispose(); });

it('opens a Return review from a copied Session for its managed SSH Project', async () => {
    const serverUrl = 'https://session-file-views.test';
    const serverIdentityId = 'srv_transcript_return';
    const controller = { machineId: 'controller', installationId: 'test-installation' };
    const sessionId = 'copied-session';
    const sourcePath = '/guest/project';
    const copyPath = '/copies/project';
    const file = { path: 'new.txt', changeKind: 'added', binary: false, generated: false, lockfile: false,
        occurrences: [], evidence: { state: 'available', unifiedDiff: '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n' } } as const;
    const { createExternalActionAccountHttpBoundary } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
    const receiver = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId: 'alice',
        ...controller, actionId: SESSION_WORKSPACE_RETURN_PREPARE_ACTION_ID_V1, tokenEpoch: 0, requesterInvocation: 'credentials',
        execute: (input) => {
            expect(input).toEqual({ sessionId, machineId: controller.machineId });
            return { returnId: 'recorded-review', sessionId, repositoryRootPath: sourcePath,
                paths: [{ path: file.path, files: [file], conflicts: [] }] };
        } });
    fixture = await createSessionFilesViewFixture({ serverUrl, serverIdentityId, sessionId, machineId: controller.machineId,
        rootPath: copyPath, request: async (url, init) => await receiver.handle(new URL(String(url)), init) ?? new Response(null, { status: 404 }) });
    const serverId = fixture.scope.serverId;
    const correspondence = buildSessionCreationCorrespondence({
        identity: { callerCreationNamespace: 'user', creationKey: 'created' },
        recipe: {
            execution: { machineId: controller.machineId, directory: { kind: 'path', path: copyPath } },
            organization: { folderId: null, tagIds: [] }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            projectFilesOrigin: {
                sourceWorkspace: { v: 2, kind: 'managed', serverId, workspaceId: 'original',
                    managedId: 'ssh-guest', rootPath: sourcePath, controller },
                targetWorkspace: { serverId, machineId: controller.machineId, workspaceId: 'copy', rootPath: copyPath },
            },
        },
    });
    const metadata = { ...fixture.session.metadata!, sessionCreationCorrespondenceV1: correspondence };
    fixture.storage.getState().applySessions([{ ...fixture.session, metadataLayoutVersion: 1,
        metadataVersion: fixture.session.metadataVersion + 1, ownerMetadataView: metadata }]);
    const source = createTestSessionTranscriptSource({ sessionId, serverId, workspacePath: copyPath });
    const files = [scmFileStatusFromChange({ path: file.path, changeKind: file.changeKind, added: 1, removed: 0 })];
    const screen = await fixture.render(<ModalProvider>{wrapWithSessionTranscriptSource(
        <TranscriptTurnChangesCard sessionId={sessionId} serverId={serverId} turnId="turn-return" files={files}
            repositoryRelative fileOpenEnabled />, source,
    )}</ModalProvider>);
    await screen.pressByTestIdAsync('turn-changes-card:turn-return-bring-back');
    await vi.waitFor(() => {
        const failure = screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'project-files-return.failed');
        expect(failure?.props.diagnosticCode).toBeUndefined();
        expect(screen.findByTestId('project-files-return.review'), screen.getTextContent()).not.toBeNull();
    });
    expect(screen.getTextContent()).toContain(file.path);
});
