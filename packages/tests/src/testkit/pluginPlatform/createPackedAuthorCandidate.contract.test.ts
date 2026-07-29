import { describe, expect, it } from 'vitest';

import type {
  PackedAuthorCandidateInputs,
} from '../../../scripts/plugin-platform/create-packed-author-candidate.mjs';

describe('packed author candidate creator declaration', () => {
  it('accepts the standalone CLI artifact consumed by the implementation', () => {
    const input = {
      runId: 'candidate-contract',
      sdkTarballPath: '/tmp/sdk.tgz',
      cliTarballPath: '/tmp/cli.tgz',
      standaloneCliArtifactPath:
        '/tmp/happier-v0.2.10-darwin-arm64.tar.gz',
    } satisfies PackedAuthorCandidateInputs;

    expect(input.standaloneCliArtifactPath)
      .toContain('happier-v0.2.10');
  });
});
