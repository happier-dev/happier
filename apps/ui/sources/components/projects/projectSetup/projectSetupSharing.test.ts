import { describe, expect, it } from 'vitest';
import { projectSharedSetupDigestV1 } from '@happier-dev/protocol/projects/projectSetupV1';
import { ProjectSharedSetupChangeV1Schema } from '@happier-dev/protocol/projects/projectSetupChangeV1';
import { createActionExecutorBoundaryFixture, createUiActionExecutorBoundary } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createProjectManifestActionClient } from './projectManifestActionClient';
import { createProjectSetupSharing, selectProjectSetupShareManifest } from './projectSetupSharing';
import { createProjectSharedSetupReview } from './projectSharedSetupReview';
import type { ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

const workspace = { serverId: 'home', workspaceId: 'checkout', machineId: 'machine', rootPath: '/repo' };
const manifest: ProjectManifestV1 = { version: 1, toolchain: { kind: 'host' },
  environmentVariables: [{ name: 'TOKEN', kind: 'secret', required: true }],
  scripts: { build: { source: { kind: 'command', command: 'build with literal-secret' } },
    test: { source: { kind: 'command', command: 'test' } } },
  services: { web: { source: { kind: 'command', command: 'serve' } } } };
const selection = { sections: ['environmentVariables'] as const, scripts: ['build'], services: [] };
const publication = { artifactId: 'saved-draft', revision: { headerVersion: 1, bodyVersion: 1 } };
const inspect = { definition: { basis: { kind: 'absent' }, document: null },
  detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
  effectiveDefinition: { effectiveManifest: manifest, origins: [] } };
function client(overrides: Parameters<typeof createActionExecutorBoundaryFixture>[0]) {
  return createProjectManifestActionClient({ workspace, expectedAccountId: 'alice', execute:
    createFrontDoorActionExecute(createUiActionExecutorBoundary(createActionExecutorBoundaryFixture(overrides), 'alice')) });
}

describe('Project setup share and selected review', () => {
  it('exports only the chosen closed declarations and retains literal command bytes for explicit review', () => {
    expect(selectProjectSetupShareManifest(manifest, selection)).toEqual({ version: 1,
      environmentVariables: manifest.environmentVariables, scripts: { build: manifest.scripts!.build } });
    expect(manifest.scripts!.test).toBeDefined();
  });

  it('requires warning acknowledgement and retries attachment with the saved protected draft', async () => {
    const calls: Array<{ kind: string; input: unknown }> = [];
    let attempts = 0;
    const owner = createProjectSetupSharing({ client: client({
      projectDefinitionAction: async ({ input }) => { calls.push({ kind: 'inspect', input }); return inspect; },
      artifactAction: async ({ actionId, input }) => { calls.push({ kind: actionId, input }); return publication; },
      projectSourcesUpdate: async input => { calls.push({ kind: 'attach', input });
        if (++attempts === 1) return { ok: false, error: 'source_conflict' };
        return { ok: true, source: { id: 'source', name: 'Shared', revision: 3, audience: [], createdByAccountId: 'alice' }, canManage: true };
      },
    }) });
    expect(calls).toEqual([]);
    await owner.load();
    owner.select(selection);
    expect(owner.export()).toEqual({ kind: 'warningRequired' });
    expect(await owner.publish({ sourceId: 'source', expectedRevision: 1, title: 'Reviewed setup' })).toEqual({ kind: 'warningRequired' });
    owner.acknowledgeWarning(true);
    expect(owner.export()).toMatchObject({ kind: 'ready', bytes: expect.stringContaining('literal-secret') });
    const first = await owner.publish({ sourceId: 'source', expectedRevision: 1, title: 'Reviewed setup' });
    expect(first).toMatchObject({ kind: 'savedNotAttached', publication, code: 'source_conflict' });
    const retry = await owner.publish({ sourceId: 'source', expectedRevision: 2, title: 'Reviewed setup' });
    expect(retry).toMatchObject({ kind: 'attached', publication, source: { revision: 3 } });
    expect(calls.filter(call => call.kind === 'artifact.create')).toEqual([{ kind: 'artifact.create', input: {
      header: { kind: 'project_setup.v1', title: 'Reviewed setup' },
      body: JSON.stringify({ kind: 'project_setup.v1', manifest: selectProjectSetupShareManifest(manifest, selection) }),
    } }]);
    expect(calls.filter(call => call.kind === 'attach').map(call => call.input)).toEqual([1, 2].map(expectedRevision => ({
      serverId: 'home', sourceId: 'source', expectedRevision, patch: { attachment: { kind: 'attach', attachment: {
        purpose: 'setup', ref: { kind: 'doc', serverId: 'home', artifactId: publication.artifactId }, contentRevision: publication.revision,
      } } },
    })));
    owner.select({ sections: [], scripts: ['test'], services: [] });
    expect(owner.export()).toEqual({ kind: 'warningRequired' });
    expect(owner.getSnapshot().publication).toBeNull();
  });

  it('refuses an unavailable effective projection instead of exporting repository fallback bytes', async () => {
    const { effectiveDefinition: _effective, ...withoutProjection } = inspect;
    const owner = createProjectSetupSharing({ client: client({ projectDefinitionAction: async () => withoutProjection }) });
    await owner.load();
    owner.acknowledgeWarning(true);
    expect(owner.export()).toEqual({ kind: 'unavailable', code: 'project_setup_review_unavailable' });
  });

  it('reviews only on explicit demand and preserves exact selected revision for existing-checkout acceptance', async () => {
    const requests: unknown[] = [];
    const change = ProjectSharedSetupChangeV1Schema.parse({ kind: 'changed', selection: { sourceId: 'source', digest: projectSharedSetupDigestV1(manifest), contentRevision: { headerVersion: 2, bodyVersion: 4 } },
      before: { effectiveManifest: null, origins: [] }, after: inspect.effectiveDefinition,
      setupReadiness: { kind: 'notRequired', reviewedEffectDigest: 'empty' } });
    const owner = createProjectSharedSetupReview({ client: client({ projectDefinitionAction: async ({ input }) => {
      requests.push(input); return { ...inspect, sharedSetupChange: change };
    } }), projectRef: { serverId: 'home', projectKey: 'project' }, expectedRevision: 7, sourceId: 'source' });
    expect(requests).toEqual([]);
    await owner.refresh();
    expect(owner.getSnapshot()).toMatchObject({ kind: 'ready', change, request: { expectedRevision: 7, review: change } });
    expect(requests).toEqual([{ workspace, read: { kind: 'editor' }, reviewSharedSetup: { sourceId: 'source' } }]);
    const before = owner.getSnapshot();
    await owner.refresh();
    const refreshed = owner.getSnapshot();
    if (before.kind !== 'ready' || refreshed.kind !== 'ready') throw new Error('Expected reviewed content');
    expect(refreshed.change).toBe(before.change);
    expect(refreshed.request).toBe(before.request);
  });
});
