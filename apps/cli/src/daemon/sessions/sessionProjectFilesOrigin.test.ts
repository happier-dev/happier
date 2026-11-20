import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionMetadataTuplePatchV1Schema, V2SessionByIdResponseSchema } from '@happier-dev/protocol';
import { buildSessionCreationCorrespondence, type SessionProjectFilesOriginV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { SessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { persistSessionProjectFilesOrigin, retainImplicitManagedProjectFilesOrigin, withSessionProjectFilesOrigin } from './sessionProjectFilesOrigin';

// Home HTTP is the boundary. The owner-envelope codec, metadata tuple mutation,
// stored recipe and copied-base codec are real.
vi.mock('axios');
afterEach(() => vi.restoreAllMocks());

const credentials = { token: 'project-files-owner', encryption: null };
const originalPolicy = { v: 1 as const, selection: 'git_worktree' as const, extraIncludePatterns: ['.env.example'], extraIgnorePatterns: ['private/**'] };
const originalPolicyDigest = computeWorkspaceSyncPolicyDigest(originalPolicy);
const correspondence = () => buildSessionCreationCorrespondence({
  identity: { callerCreationNamespace: 'owner', creationKey: 'copied-base' },
  recipe: { execution: { machineId: 'controller', directory: { kind: 'path', path: '/source/project' } },
    organization: { folderId: null, tagIds: [] },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
});
const origin = (sourceRoot = 'C:\\Users\\person\\project'): SessionProjectFilesOriginV1 => ({
  sourceWorkspace: { serverId: 'home', workspaceId: 'source', machineId: 'original', rootPath: sourceRoot },
  targetWorkspace: { v: 2, kind: 'managed', serverId: 'home', workspaceId: 'actual-native-workspace',
    managedId: 'sandbox', controller: { machineId: 'controller', installationId: 'installation' }, rootPath: '/guest/project' },
  ...{ contentPolicyDigest: originalPolicyDigest },
});

function createHome() {
  const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
    metadata: createTestMetadata({ sessionCreationCorrespondenceV1: correspondence() }), agentState: null });
  let raw = createSessionRecordFixture({ id: 'same-session', encryptionMode: 'plain', metadataLayoutVersion: 1,
    metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
    metadataVersion: 1, agentState: null, agentStateVersion: 0, share: null });
  V2SessionByIdResponseSchema.parse({ session: raw });
  vi.mocked(axios.get).mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v2/sessions/same-session') return { status: 200, data: { session: raw } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    return { status: 404, data: {} };
  });
  vi.mocked(axios.patch).mockImplementation(async (_url, body) => {
    const patch = SessionMetadataTuplePatchV1Schema.parse(body);
    if (patch.mode !== 'owner') throw new Error('Expected existing owner tuple');
    raw = { ...raw, metadata: patch.sharedMetadata.ciphertext, ownerMetadata: patch.ownerMetadata,
      metadataVersion: raw.metadataVersion + 1, agentState: patch.agentState.ciphertext, agentStateVersion: raw.agentStateVersion + 1 };
    return { status: 200, data: { success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: raw.metadataVersion }, agentState: { version: raw.agentStateVersion } } };
  });
  return () => raw;
}

describe('native copied Project files retained by the existing Session recipe owner', () => {
  it('retains the actual endpoints of an implicit managed Copy once in the owner recipe', async () => {
    const serverId = 'srv_implicit_copy';
    await seedTestServerProfile({ id: serverId, homeId: serverId, serverUrl: 'https://implicit-copy.invalid' });
    createHome();
    const rows: unknown[] = [];
    vi.mocked(axios.post).mockImplementation(createProjectAccountRowsHttpBoundary(rows));
    const managedCreation = { homeId: serverId, managedId: 'sandbox',
      controller: { machineId: 'controller', installationId: 'installation' } };
    const recipe = { ...correspondence().recipe, managedCreation, projectFiles: { kind: 'copy_once' as const } };
    const workspace = { hostRoot: '/actual/git-root', targetRoot: '/guest/materialized-root' };
    try {
      const origin = await retainImplicitManagedProjectFilesOrigin({ credentials, recipe, workspace });
      const retry = await retainImplicitManagedProjectFilesOrigin({ credentials, recipe, workspace });
      if (!origin) throw new Error('The attached birth recipe owns the placed copy');
      const retained = await persistSessionProjectFilesOrigin({ credentials, sessionId: 'same-session', origin });
      expect(retained.origin).toEqual(retry);
      expect(retained.origin).toMatchObject({
        sourceWorkspace: { serverId, machineId: 'controller', rootPath: workspace.hostRoot },
        targetWorkspace: { v: 2, kind: 'managed', serverId, managedId: 'sandbox', controller: managedCreation.controller, rootPath: workspace.targetRoot },
      });
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { kind: 'workspace-ref', serverId, id: retained.origin.sourceWorkspace.workspaceId } }),
        expect.objectContaining({ key: { kind: 'workspace-ref', serverId, id: retained.origin.targetWorkspace.workspaceId } }),
      ]));
      expect(retained.origin.baseline).toBeUndefined();
    } finally { withdrawActiveProjectAccountRowsSnapshot(); }
  });

  it('includes the actual native address and original source in the existing birth correspondence', () => {
    const contentPolicyDigest = originalPolicyDigest;
    const retained = withSessionProjectFilesOrigin(correspondence(), { ...origin(), ...{ contentPolicyDigest }, baseline: { entries: [] } });
    expect(retained.recipe.projectFilesOrigin?.targetWorkspace).toEqual(origin().targetWorkspace);
    expect(retained.recipe.projectFilesOrigin?.sourceWorkspace).toEqual(origin().sourceWorkspace);
    expect(retained.recipe.projectFilesOrigin?.baseline).toBeUndefined();
    expect(retained.recipe.projectFilesOrigin).toMatchObject({ contentPolicyDigest });
  });

  it('recovers the original endpoints after the same Session restarts, without reinterpreting the source on its controller', async () => {
    const readRaw = createHome();
    const initial = await persistSessionProjectFilesOrigin({ credentials, sessionId: 'same-session', origin: origin() });
    expect(initial.origin).toEqual(origin());
    // The child parses the shared envelope before combining it with owner metadata.
    expect(SessionSharedMetadataV1Schema.parse(initial.snapshot.metadata)).toEqual(JSON.parse(readRaw().metadata));
    expect(initial.snapshot).toMatchObject({
      ownerMetadata: { system: { sessionCreationCorrespondenceV1: { recipe: { projectFilesOrigin: origin() } } } },
      ownerMetadataEnvelope: readRaw().ownerMetadata,
    });
    // A new call has no daemon registry or in-memory recipe from the first call.
    const recovered = await persistSessionProjectFilesOrigin({ credentials, sessionId: 'same-session', origin: origin('C:\\other-host\\project') });
    expect(recovered.origin).toEqual(initial.origin);
    expect(recovered.origin.sourceWorkspace.rootPath).toBe('C:\\Users\\person\\project');
    expect(recovered.origin.baseline).toBeUndefined();
    const envelope = readRaw().ownerMetadata;
    expect(JSON.stringify(envelope)).toContain('actual-native-workspace');
    expect(JSON.stringify(envelope)).not.toContain('"machineId":"sandbox"');
  });

  it('surfaces a metadata write refusal before launch instead of pretending the base was retained', async () => {
    createHome();
    vi.mocked(axios.patch).mockResolvedValue({ status: 403, data: { error: 'forbidden' } });
    await expect(persistSessionProjectFilesOrigin({ credentials, sessionId: 'same-session', origin: origin() }))
      .rejects.toMatchObject({ response: { status: 403 } });
  });
});
