import { describe, expect, it } from 'vitest';

import { createRetainedConnectedServicesMaterialization } from './materializer';

describe('connected service materialization helpers', () => {
  it('does not attach cleanup callbacks for retained connected-service homes', () => {
    const materialization = createRetainedConnectedServicesMaterialization({
      rootDir: '/tmp/happier/connected-services/homes/openai-codex/profile/codex',
      env: { CODEX_HOME: '/tmp/happier/connected-services/homes/openai-codex/profile/codex/codex-home' },
    });

    expect(materialization).toEqual({
      targetMaterializedRoot: '/tmp/happier/connected-services/homes/openai-codex/profile/codex',
      env: { CODEX_HOME: '/tmp/happier/connected-services/homes/openai-codex/profile/codex/codex-home' },
      cleanupOnFailure: null,
      cleanupOnExit: null,
    });
  });
});
