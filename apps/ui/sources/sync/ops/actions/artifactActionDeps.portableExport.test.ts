import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveActionApprovalRouting } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { isActionEnabledByActionsSettings, normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { LaunchProfileArtifactV1Schema } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import { RoleArtifactV1Schema } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from './actionAccountContext';
import { createUiArtifactAction } from './artifactActionDeps';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { encodeBase64 } from '@/encryption/base64';
import { hashArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import { createPromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { createUiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let account: LazyActionAccountContext | undefined;
afterEach(async () => {
    account?.dispose(); account = undefined;
    await fixture?.dispose(); fixture = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const role = RoleArtifactV1Schema.parse({ name: 'Reviewer', instructions: 'Review the changes.',
    runsAs: { kind: 'session' }, workspaceWrites: 'deny', secondOpinion: 'off', enabled: true });
const profile = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1',
    profile: { id: 'portable-profile', name: 'Review environment', createdAt: 1, updatedAt: 1 } });

it.each([
    { title: 'Review instructions', markdown: '# Review\n\nKeep café ☕ intact.\n', fileName: 'Review instructions.md' },
    { title: 'Empty.MD', markdown: '', fileName: 'Empty.MD' },
])('exports a saved Markdown document, including an empty body ($title)', async ({ title, markdown, fileName }) => {
    fixture = await createPlainArtifactHomeFixture('https://markdown-export.test');
    account = await captureLazyActionAccountContext(fixture.home.id);
    const { artifactId } = await createPromptDocInLibrary({
        store: createUiPromptLibraryArtifactStore(account.workflowArtifacts, account), request: { title, markdown },
    });
    const blobs: Blob[] = [];
    const downloaded: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:markdown'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('document', { body: { appendChild() {} }, createElement: () => {
        const anchor = { download: '', style: {}, remove() {}, click() { downloaded.push(anchor.download); } };
        return anchor;
    } });
    const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ artifactAction: createUiArtifactAction(account) })));
    const result = await execute('artifact.export', { artifactId, destination: 'client' }, {
        surface: 'agent', authority: 'account_automation', serverId: fixture.home.id,
        runtimeAccountId: account.accountId, bypassApprovals: true,
    });
    expect(result).toMatchObject({ ok: true, result: { artifactId, destination: 'client', status: 'saved',
        fileName, sizeBytes: new TextEncoder().encode(markdown).length } });
    expect(downloaded).toEqual([fileName]);
    expect(blobs[0]?.type).toBe('text/markdown;charset=utf-8');
    expect(await blobs[0]?.text()).toBe(markdown);
});

it('downloads admitted binary bytes on the answering client through the agent Action', async () => {
    const bytes = new Uint8Array([0, 255, 128]);
    const reference = { blobId: 'b6a4bb92-8b93-4b18-b8b4-230041388a62', mime: 'application/pdf',
        sizeBytes: bytes.length, sha256: hashArtifactBinaryContent(bytes) };
    const previousBytes = new Uint8Array([42, 0, 127, 255]);
    const previousReference = { ...reference, blobId: 'c6a4bb92-8b93-4b18-b8b4-230041388a62',
        sizeBytes: previousBytes.length, sha256: hashArtifactBinaryContent(previousBytes) };
    fixture = await createPlainArtifactHomeFixture('https://binary-export.test', { handleRequest: async path =>
        path.includes('/blobs/') ? new Response(JSON.stringify(path.endsWith(previousReference.blobId)
            ? { blobId: previousReference.blobId, content: { t: 'plain', v: encodeBase64(previousBytes) } }
            : { blobId: reference.blobId, content: { t: 'plain', v: encodeBase64(bytes) } })) : null });
    fixture.boundary.replaceStoredRow({ id: 'binary', ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ title: 'Report.pdf' }), headerVersion: 1,
        body: encodePlainArtifactStoredContent({ body: reference }), bodyVersion: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        seq: 1, createdAt: 1, updatedAt: 1 });
    account = await captureLazyActionAccountContext(fixture.home.id);
    const blobs: Blob[] = [];
    const downloaded: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:binary'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('document', { body: { appendChild() {} }, createElement: () => {
        const anchor = { download: '', style: {}, remove() {}, click() { downloaded.push(anchor.download); } };
        return anchor;
    } });
    const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ artifactAction: createUiArtifactAction(account) })));
    const input = { artifactId: 'binary', destination: 'client' };
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
        serverId: fixture.home.id, runtimeAccountId: account.accountId, bypassApprovals: true };
    expect(resolveActionExecutionPlacementForInput(getActionSpec('artifact.export'), input, undefined, 'ui')).toBe('client');
    expect(resolveActionApprovalRouting({ actionId: 'artifact.export', spec: getActionSpec('artifact.export'), input,
        context: { ...context, bypassApprovals: false } }).required).toBe(true);
    const result = await execute('artifact.export', input, context);
    expect(result).toMatchObject({ ok: true, result: { artifactId: 'binary', destination: 'client', status: 'saved', fileName: 'Report.pdf', sizeBytes: bytes.length } });
    if (result.ok) expect(ArtifactActionOutputSchemasV1['artifact.export'].safeParse(result.result).success).toBe(true);
    expect(downloaded).toEqual(['Report.pdf']);
    expect(new Uint8Array(await blobs[0]!.arrayBuffer())).toEqual(bytes);
    // The History surface names its exact admitted blob; a current-head read must not replace it.
    expect(await execute('artifact.export', { ...input, reference: previousReference, fileName: 'Earlier.pdf' }, context))
        .toMatchObject({ ok: true, result: { status: 'saved', fileName: 'Earlier.pdf', sizeBytes: previousBytes.length } });
    expect(downloaded).toEqual(['Report.pdf', 'Earlier.pdf']);
    expect(new Uint8Array(await blobs[1]!.arrayBuffer())).toEqual(previousBytes);
    expect(await execute('artifact.export', { ...input, reference: { ...reference, sha256: '0'.repeat(64) } }, context))
        .toMatchObject({ ok: false });
    expect(downloaded).toHaveLength(2);
});

it.each([
    { portable: { kind: 'role' as const, document: role }, fileName: 'Reviewer.role.json', document: role },
    { portable: { kind: 'launch-profile' as const, document: profile }, fileName: 'Review-environment.launch-profile.json', document: profile },
])('exports $portable.kind through admission and the existing platform save owner', async ({ portable, fileName, document }) => {
    fixture = await createPlainArtifactHomeFixture('https://portable-export.test');
    account = await captureLazyActionAccountContext(fixture.home.id);
    // Browser downloads are the OS boundary. The Action schema, policy, Account capture,
    // serialization and real saveWorkflowDocument path remain in the production graph.
    const blobs: Blob[] = [];
    const downloaded: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:portable'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('document', { body: { appendChild() {} }, createElement: () => {
        const anchor = { download: '', style: {}, remove() {}, click() { downloaded.push(anchor.download); } };
        return anchor;
    } });
    let settings = normalizeActionsSettingsV1({ v: 1, actions: { 'artifact.export': { enabled: false } } });
    const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({
        artifactAction: createUiArtifactAction(account),
        isActionEnabled: (id, ctx) => isActionEnabledByActionsSettings(id, settings, ctx),
    })));
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
        serverId: fixture.home.id, runtimeAccountId: account.accountId, bypassApprovals: true };
    expect(await execute('artifact.export', { portable }, context)).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(downloaded).toEqual([]);
    expect(blobs).toEqual([]);
    expect(await execute('artifact.list', {}, context)).toMatchObject({ ok: true });

    settings = normalizeActionsSettingsV1({ v: 1 });
    const spec = getActionSpec('artifact.export');
    expect(resolveActionApprovalRouting({ actionId: 'artifact.export', spec,
        input: { portable }, context: { ...context, bypassApprovals: false } }).required).toBe(true);
    expect(resolveActionExecutionPlacementForInput(spec, { portable }, undefined, 'ui')).toBe('client');
    expect(resolveActionExecutionPlacementForInput(spec, { artifactId: 'binary', path: 'copy.bin' }, undefined, 'ui')).toBe('machine');
    const result = await execute('artifact.export', { portable }, context);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ ok: true, result: { exported: true, fileName } });
    expect(ArtifactActionOutputSchemasV1['artifact.export'].safeParse(result.result).success).toBe(true);
    expect(downloaded).toEqual([fileName]);
    expect(JSON.parse(await blobs[0]!.text())).toEqual(document);
    expect(fixture.boundary.list()).toEqual([]);
});
