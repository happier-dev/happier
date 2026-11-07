import { describe, expect, it } from 'vitest';

import { ArtifactOrganizationHeaderV1Schema, resolveArtifactOrganizationHeaderV1 } from './artifactOrganizationV1.js';

describe('personal Artifact organization', () => {
  it('keeps deleted legacy membership unfiled across folder id reuse while preserving tags and explicit new placement', () => {
    const header = { folderId: 'reused', tags: ['legacy'] };
    const organization = { deletedLegacyFolderIds: ['reused'] };
    expect(resolveArtifactOrganizationHeaderV1({ artifactId: 'legacy', header, owned: true, organization }))
      .toEqual({ folderId: null, tags: ['legacy'] });
    expect(resolveArtifactOrganizationHeaderV1({ artifactId: 'legacy', header, owned: true,
      organization: { ...organization, artifactHeadersById: { legacy: { folderId: 'reused' } } },
    })).toEqual({ folderId: 'reused', tags: ['legacy'] });
    expect(resolveArtifactOrganizationHeaderV1({ artifactId: 'other', header: { folderId: 'untouched', tags: ['keep'] },
      owned: true, organization })).toEqual({ folderId: 'untouched', tags: ['keep'] });
    expect(header).toEqual({ folderId: 'reused', tags: ['legacy'] });
  });

  it('uses valid personal corrections without parsing the overwritten malformed legacy fields', () => {
    const header = { title: 'Retained', folderId: 42, tags: 'broken' };
    expect(resolveArtifactOrganizationHeaderV1({ artifactId: 'retained', header, owned: true,
      organization: { artifactHeadersById: { retained: { folderId: null, tags: ['corrected'] } } },
    })).toEqual({ folderId: null, tags: ['corrected'] });
    expect(() => resolveArtifactOrganizationHeaderV1({ artifactId: 'retained', header, owned: true,
      organization: { artifactHeadersById: { retained: { folderId: null } } },
    })).toThrow();
    expect(header).toEqual({ title: 'Retained', folderId: 42, tags: 'broken' });
  });
  it('projects personal fields before owned legacy headers and keeps explicit unplacement', () => {
    const header = { kind: 'role.v1', title: 'Reviewer', folderId: 'legacy', tags: ['review'], future: true };
    expect(resolveArtifactOrganizationHeaderV1({ artifactId: 'role', header, owned: true })).toEqual({ folderId: 'legacy', tags: ['review'] });
    expect(resolveArtifactOrganizationHeaderV1({ artifactId: 'role', header, owned: true,
      organization: { artifactHeadersById: { role: { folderId: null } } } })).toEqual({ folderId: null, tags: ['review'] });
    expect(header.folderId).toBe('legacy');
  });

  it('never inherits the document owner folder or tags for a shared recipient', () => {
    const header = { kind: 'memory_doc.v1', title: 'Team memory', folderId: 'owners-private-folder', tags: ['owners-private-tag'] };
    expect(resolveArtifactOrganizationHeaderV1({ artifactId: 'memory', header, owned: false })).toEqual({});
    expect(resolveArtifactOrganizationHeaderV1({ artifactId: 'memory', header, owned: false,
      organization: { artifactHeadersById: { memory: { folderId: 'my-research', tags: ['ours'] } } } })).toEqual({ folderId: 'my-research', tags: ['ours'] });
    expect(header).toEqual({ kind: 'memory_doc.v1', title: 'Team memory', folderId: 'owners-private-folder', tags: ['owners-private-tag'] });
  });

  it('keeps personal organization writes closed and validates known fields', () => {
    expect(ArtifactOrganizationHeaderV1Schema.safeParse({ folderId: null, tags: ['facts'] }).success).toBe(true);
    expect(ArtifactOrganizationHeaderV1Schema.safeParse({ folderId: 'folder', grants: [] }).success).toBe(false);
    expect(ArtifactOrganizationHeaderV1Schema.safeParse({ tags: [42] }).success).toBe(false);
  });
});
