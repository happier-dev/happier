import { describe, expect, it } from 'vitest';
import { admitProjectSourceAttachmentV1 } from './projectSourceAttachmentAdmissionV1.js';

describe('Source attachment Artifact admission', () => {
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
