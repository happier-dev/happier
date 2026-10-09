import { describe, expect, it } from 'vitest';

import { ArtifactOrganizationHeaderV1Schema, resolveArtifactOrganizationHeaderV1 } from './artifactOrganizationV1.js';

describe('personal Artifact organization', () => {
  it('uses valid personal corrections without parsing the overwritten malformed legacy fields', () => {
    const header = { title: 'Retained', folderId: 42, tags: 'broken' };
    expect(resolveArtifactOrganizationHeaderV1({ artifactId: 'retained', header, owned: true,
      artifactHeadersById: { retained: { folderId: null, tags: ['corrected'] } },
    })).toEqual({ folderId: null, tags: ['corrected'] });
    expect(() => resolveArtifactOrganizationHeaderV1({ artifactId: 'retained', header, owned: true,
      artifactHeadersById: { retained: { folderId: null } },
    })).toThrow();
    expect(header).toEqual({ title: 'Retained', folderId: 42, tags: 'broken' });
  });
  it('projects personal fields before owned legacy headers and keeps explicit unplacement', () => {
    const header = { kind: 'role.v1', title: 'Reviewer', folderId: 'legacy', tags: ['review'], future: true };
    expect(resolveArtifactOrganizationHeaderV1({ artifactId: 'role', header, owned: true })).toEqual({ folderId: 'legacy', tags: ['review'] });
    expect(resolveArtifactOrganizationHeaderV1({ artifactId: 'role', header, owned: true,
      artifactHeadersById: { role: { folderId: null } } })).toEqual({ folderId: null, tags: ['review'] });
    expect(header.folderId).toBe('legacy');
  });

  it('never inherits the document owner folder or tags for a shared recipient', () => {
    const header = { kind: 'memory_doc.v1', title: 'Team memory', folderId: 'owners-private-folder', tags: ['owners-private-tag'] };
    expect(resolveArtifactOrganizationHeaderV1({ artifactId: 'memory', header, owned: false })).toEqual({});
    expect(resolveArtifactOrganizationHeaderV1({ artifactId: 'memory', header, owned: false,
      artifactHeadersById: { memory: { folderId: 'my-research', tags: ['ours'] } } })).toEqual({ folderId: 'my-research', tags: ['ours'] });
    expect(header).toEqual({ kind: 'memory_doc.v1', title: 'Team memory', folderId: 'owners-private-folder', tags: ['owners-private-tag'] });
  });

  it('keeps personal organization writes closed and validates known fields', () => {
    expect(ArtifactOrganizationHeaderV1Schema.safeParse({ folderId: null, tags: ['facts'] }).success).toBe(true);
    expect(ArtifactOrganizationHeaderV1Schema.safeParse({ folderId: 'folder', grants: [] }).success).toBe(false);
    expect(ArtifactOrganizationHeaderV1Schema.safeParse({ tags: [42] }).success).toBe(false);
  });
});
