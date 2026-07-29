import { describe, expect, it } from 'vitest';

import * as Protocol from '../../index.js';
import {
  PromptArtifactRefV1Schema,
  PromptDocArtifactRefV1Schema,
} from './promptArtifactRefsV1.js';

describe('PromptArtifactRefV1Schema', () => {
  it('parses doc and bundle prompt artifact refs and preserves additive fields', () => {
    const docParsed = PromptArtifactRefV1Schema.parse({
      kind: 'doc',
      artifactId: 'doc_1',
      futureRefField: 'keep-me',
    });
    const bundleParsed = PromptArtifactRefV1Schema.parse({
      kind: 'bundle',
      artifactId: 'bundle_1',
      futureRefField: 'keep-me',
    });

    expect(docParsed).toEqual({
      kind: 'doc',
      artifactId: 'doc_1',
      futureRefField: 'keep-me',
    });
    expect(bundleParsed).toEqual({
      kind: 'bundle',
      artifactId: 'bundle_1',
      futureRefField: 'keep-me',
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

  it('exports the shared artifact ref schemas from the protocol root entrypoint', () => {
    expect(Protocol.PromptArtifactRefV1Schema).toBe(PromptArtifactRefV1Schema);
    expect(Protocol.PromptDocArtifactRefV1Schema).toBe(PromptDocArtifactRefV1Schema);
  });
});
