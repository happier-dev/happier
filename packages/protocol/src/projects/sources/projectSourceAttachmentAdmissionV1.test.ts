import { describe, expect, it } from 'vitest';
import { admitProjectSourceAttachmentV1, prepareProjectSourceUpdateV1 } from './projectSourceAttachmentAdmissionV1.js';
import { ProjectSourcesReadOutputV1Schema } from './projectSourceV1.js';

describe('Source attachment Artifact admission', () => {
  it('prepares the selected setup once for the proposed audience and owner before publication', async () => {
    const reads: unknown[] = [];
    const patch = { owner: { kind: 'team' as const, teamId: 'team-a' }, audience: [] };
    const attachment = { purpose: 'setup' as const, ref: { kind: 'doc' as const, artifactId: 'setup' },
      contentRevision: { headerVersion: 1, bodyVersion: 1 } };
    const result = await prepareProjectSourceUpdateV1({ input: { serverId: 'home', sourceId: 'source', expectedRevision: 1,
      patch: { ...patch, attachment: { kind: 'attach', attachment } } },
      readSource: async () => { throw new Error('New setup publication already selects its only content'); },
      readArtifact: async (ref, options) => { reads.push({ ref, options }); return { artifactId: ref.artifactId, header: { kind: 'project_setup.v1' } }; },
    });
    expect(result).toEqual({ ok: true });
    expect(reads).toEqual([{ ref: { kind: 'doc', artifactId: 'setup', serverId: 'home' },
      options: { projectSourceId: 'source', projectSourcePatch: patch } }]);
  });

  it('prepares retained setup on an audience move while excluding setup detached in the same edit', async () => {
    const attachment = { purpose: 'setup' as const, ref: { kind: 'doc' as const, artifactId: 'setup' },
      contentRevision: { headerVersion: 1, bodyVersion: 1 } };
    const source = ProjectSourcesReadOutputV1Schema.parse({ ok: true, canManage: true,
      source: { id: 'source', revision: 1, name: 'App', audience: [], createdByAccountId: 'owner', attachments: [attachment] } });
    const reads: unknown[] = [];
    const readArtifact = async (ref: { artifactId: string }, options?: unknown) => {
      reads.push(options); return { artifactId: ref.artifactId, header: { kind: 'project_setup.v1' } };
    };
    const input = { serverId: 'home', sourceId: 'source', expectedRevision: 1, patch: { audience: [] } };
    expect(await prepareProjectSourceUpdateV1({ input, readSource: async () => source, readArtifact })).toEqual({ ok: true });
    expect(reads).toEqual([{ projectSourceId: 'source', projectSourcePatch: { audience: [] } }]);
    reads.length = 0;
    expect(await prepareProjectSourceUpdateV1({ input: { ...input, patch: { ...input.patch,
      attachment: { kind: 'detach', purpose: 'setup', ref: attachment.ref } } }, readSource: async () => source, readArtifact })).toEqual({ ok: true });
    expect(reads).toEqual([]);
  });

  it('reads the exact qualified dashboard as the actor and refuses a context document', async () => {
    const refs: unknown[] = [];
    const attachment = { purpose: 'dashboard' as const, ref: { kind: 'doc' as const, artifactId: 'layout', serverId: 'home-b' } };
    await expect(admitProjectSourceAttachmentV1({
      attachment, sourceServerId: 'home-a',
      readArtifact: async ref => { refs.push(ref); return { artifactId: 'layout', header: { kind: 'prompt_doc.v2' } }; },
    })).resolves.toEqual({ ok: false, error: 'artifact_wrong_kind' });
    expect(refs).toEqual([{ kind: 'doc', artifactId: 'layout', serverId: 'home-b' }]);
  });

  it('refuses substituted and unreadable Artifacts without producing attachment authority', async () => {
    const attachment = { purpose: 'dashboard' as const, ref: { kind: 'doc' as const, artifactId: 'layout' } };
    for (const readArtifact of [
      async () => null,
      async () => ({ artifactId: 'other', header: { kind: 'widget-area-layout.v1' } }),
      async () => { throw new Error('locked'); },
    ]) {
      await expect(admitProjectSourceAttachmentV1({ attachment, sourceServerId: 'home-a', readArtifact }))
        .resolves.toEqual({ ok: false, error: 'artifact_unavailable' });
    }
  });

  it('admits dashboard and memory references independently without content or grant writes', async () => {
    await expect(admitProjectSourceAttachmentV1({
      attachment: { purpose: 'dashboard', ref: { kind: 'doc', artifactId: 'layout' } }, sourceServerId: 'home-a',
      readArtifact: async ref => ({ artifactId: ref.artifactId, header: { kind: 'widget-area-layout.v1' } }),
    })).resolves.toEqual({ ok: true });
    await expect(admitProjectSourceAttachmentV1({
      attachment: { purpose: 'context', entry: { id: 'memory', ref: { kind: 'doc', artifactId: 'memory' }, enabled: true, placement: 'system_append' } },
      sourceServerId: 'home-a', readArtifact: async ref => ({ artifactId: ref.artifactId, header: { kind: 'memory_doc.v1' } }),
    })).resolves.toEqual({ ok: true });
  });
});
