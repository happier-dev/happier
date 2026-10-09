import { describe, expect, it } from 'vitest';

import {
  PromptArtifactRefV1Schema,
  PromptArtifactRefV1StoredSchema,
  PromptDocArtifactRefV1Schema,
} from './promptArtifactRefsV1.js';

describe('PromptArtifactRefV1Schema', () => {
  it('retains a valid Home qualifier and refuses malformed qualifiers at the canonical reference owner', () => {
    expect(PromptArtifactRefV1Schema.parse({ kind: 'doc', artifactId: 'doc', serverId: 'home' }))
      .toEqual({ kind: 'doc', artifactId: 'doc', serverId: 'home' });
    expect(PromptArtifactRefV1Schema.safeParse({ kind: 'doc', artifactId: 'doc', serverId: 12 }).success).toBe(false);
    expect(PromptArtifactRefV1Schema.safeParse({ kind: 'doc', artifactId: 'doc', serverId: '' }).success).toBe(false);
  });
  it('projects known stored reference fields while refusing additive fields in authored references', () => {
    const docParsed = PromptArtifactRefV1StoredSchema.parse({
      kind: 'doc',
      artifactId: 'doc_1',
      futureRefField: 'keep-me',
    });
    const bundleParsed = PromptArtifactRefV1StoredSchema.parse({
      kind: 'bundle',
      artifactId: 'bundle_1',
      futureRefField: 'keep-me',
    });

    expect(docParsed).toEqual({
      kind: 'doc',
      artifactId: 'doc_1',
    });
    expect(PromptArtifactRefV1Schema.safeParse({ kind: 'doc', artifactId: 'doc_1', futureRefField: 'keep-me' }).success).toBe(false);
    expect(bundleParsed).toEqual({
      kind: 'bundle',
      artifactId: 'bundle_1',
    });
  });

  it('keeps prompt invocation targets doc-only', () => {
    expect(PromptDocArtifactRefV1Schema.safeParse({
      kind: 'doc',
      artifactId: 'doc_1',
    }).success).toBe(true);

    expect(PromptDocArtifactRefV1Schema.safeParse({
      kind: 'bundle',
      artifactId: 'bundle_1',
    }).success).toBe(false);
  });

  it('exports the shared artifact ref schemas from the protocol root entrypoint', async () => {
    const Protocol = await import('../../index.js');
    expect(Protocol.PromptArtifactRefV1Schema).toBe(PromptArtifactRefV1Schema);
    expect(Protocol.PromptDocArtifactRefV1Schema).toBe(PromptDocArtifactRefV1Schema);
  });
});
