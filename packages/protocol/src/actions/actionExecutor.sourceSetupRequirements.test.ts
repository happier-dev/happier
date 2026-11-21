import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { PROJECT_SOURCE_SETUP_REQUIREMENTS_ACTION_ID_V1 } from './specs/projectSourcesActionIdsV1.js';

describe('Source setup requirements Action', () => {
  it('uses the Source parent for protected content and preserves the difference between absent and unreadable setup', async () => {
    const artifactId = '11111111-1111-4111-8111-111111111111';
    const sourceId = 'repository';
    const revision = { headerVersion: 1, bodyVersion: 2 };
    let state: 'published' | 'unpublished' | 'stale' | 'denied' = 'published';
    const artifactRequests: unknown[] = [];
    const executor = createActionExecutor({
      projectSourcesRead: async () => state === 'denied' ? { ok: false, error: 'source_access_denied' } : {
        ok: true, canManage: false,
        source: { id: sourceId, name: 'Repository', revision: 1, createdByAccountId: 'owner', audience: [],
          attachments: state === 'unpublished' ? [] : [
            { purpose: 'setup', ref: { kind: 'doc', artifactId }, contentRevision: revision },
          ] },
      },
      artifactAction: async request => {
        artifactRequests.push({ input: request.input, readOnly: 'readOnly' in request && request.readOnly });
        return { artifact: { artifactId, ownerAccountId: 'owner', access: 'view', publicAudience: 'none',
          seq: 1, createdAt: 1, updatedAt: 1, header: { kind: 'project_setup.v1' },
          revision: state === 'stale' ? { ...revision, bodyVersion: 3 } : revision,
          body: JSON.stringify({ kind: 'project_setup.v1', manifest: { version: 1,
            environmentVariables: [{ name: 'API_TOKEN', kind: 'secret', required: true }],
          } }),
        } };
      },
    });
    const read = () => executor.execute(PROJECT_SOURCE_SETUP_REQUIREMENTS_ACTION_ID_V1, { serverId: 'home', sourceId },
      { surface: 'ui', authority: 'present_user', runtimeAccountId: 'reader', expectedAccountId: 'reader',
        serverId: 'home', serverIdentityId: 'home', actionCaller: { kind: 'host' } });

    expect(await read()).toEqual({ ok: true, result: { kind: 'published', names: ['API_TOKEN'],
      provenance: { layer: 'shared', sourceId, contentRevision: revision } } });
    state = 'unpublished';
    expect(await read()).toEqual({ ok: true, result: { kind: 'unpublished' } });
    state = 'stale';
    expect(await read()).toMatchObject({ ok: false, errorCode: 'project_setup_review_unavailable' });
    state = 'denied';
    expect(await read()).toMatchObject({ ok: false, errorCode: 'source_access_denied' });
    expect(artifactRequests).toEqual(Array(2).fill({ input: { artifactId, projectSourceId: sourceId }, readOnly: true }));
  });
});
