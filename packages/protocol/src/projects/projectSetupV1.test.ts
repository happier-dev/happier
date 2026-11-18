import { describe, expect, it } from 'vitest';
import { PROJECT_SETUP_ARTIFACT_KIND_V1, projectSharedSetupDigestV1, readAcceptedProjectSetupV1 } from './projectSetupV1.js';
import { ProjectManifestV1Schema } from '../workspaces/projectSetup/projectManifestV1.js';
import { createActionExecuteFailureError } from '../actions/actionExecutionResult.js';

describe('accepted Project setup detail boundary', () => {
  const manifest = ProjectManifestV1Schema.parse({ version: 1,
    workspace: { setup: [{ kind: 'command', command: 'echo accepted' }] } });
  const selection = { sourceId: 'publisher-source', contentRevision: { headerVersion: 1, bodyVersion: 2 },
    digest: projectSharedSetupDigestV1(manifest) };
  const pointer = { artifactId: 'private-copy', headerVersion: 1, bodyVersion: 1 };
  const artifact = { artifactId: pointer.artifactId, header: { kind: PROJECT_SETUP_ARTIFACT_KIND_V1, title: 'Setup' },
    revision: { headerVersion: 1, bodyVersion: 1 },
    body: JSON.stringify({ kind: PROJECT_SETUP_ARTIFACT_KIND_V1, acceptedSharedSetup: { ...selection, manifest } }) };

  it('uses the accepted private body without consulting the publisher', async () => {
    expect(await readAcceptedProjectSetupV1({ setupContent: pointer, setupSelection: selection,
      readArtifact: async artifactId => artifactId === pointer.artifactId ? artifact : null }))
      .toMatchObject({ kind: 'ready', acceptedSharedSetup: { ...selection, manifest } });
  });

  it('refuses mismatched selected detail and tampered accepted declarations', async () => {
    for (const altered of [
      { ...artifact, revision: { ...artifact.revision, bodyVersion: 2 } },
      { ...artifact, body: artifact.body.replace('echo accepted', 'echo tampered') },
      { ...artifact, body: JSON.stringify({ kind: PROJECT_SETUP_ARTIFACT_KIND_V1 }) },
    ]) expect(await readAcceptedProjectSetupV1({ setupContent: pointer, setupSelection: selection,
      readArtifact: async () => altered })).toEqual({ kind: 'unavailable', code: 'project_setup_review_unavailable' });
  });

  it('keeps absence cheap while refusing a dangling selection', async () => {
    const readArtifact = async () => { throw new Error('No detail is selected'); };
    expect(await readAcceptedProjectSetupV1({ readArtifact })).toEqual({ kind: 'ready' });
    expect(await readAcceptedProjectSetupV1({ setupSelection: selection, readArtifact }))
      .toEqual({ kind: 'unavailable', code: 'project_setup_review_unavailable' });
  });

  it('preserves a refused transport cause and propagates cancellation', async () => {
    expect(await readAcceptedProjectSetupV1({ setupContent: pointer,
      readArtifact: async () => { throw createActionExecuteFailureError({ ok: false,
        errorCode: 'artifact_access_forbidden', error: 'Artifact refused', effectAttempted: false }); } }))
      .toMatchObject({ kind: 'unavailable', code: 'artifact_access_forbidden', failureCause: { errorCode: 'artifact_access_forbidden' } });
    const controller = new AbortController();
    const reason = new Error('Cancelled selected detail');
    controller.abort(reason);
    await expect(readAcceptedProjectSetupV1({ setupContent: pointer, signal: controller.signal, readArtifact: async () => artifact }))
      .rejects.toBe(reason);
  });
});
