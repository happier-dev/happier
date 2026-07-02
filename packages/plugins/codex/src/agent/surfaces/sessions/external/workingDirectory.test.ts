import { describe, expect, it } from 'vitest';

import { resolveCodexExternalSessionWorkingDirectoryStoreKey } from './workingDirectory.js';

describe('Codex external session working-directory policy', () => {
  it('builds the Codex rollout store key for an external session', () => {
    const source = { kind: 'codexHome', home: 'user' } as const;

    expect(resolveCodexExternalSessionWorkingDirectoryStoreKey({
      source,
      remoteSessionId: ' session-1 ',
    })).toEqual({
      providerId: 'codex',
      source,
      remoteSessionId: ' session-1 ',
    });
  });
});
