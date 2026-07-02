import { describe, expect, it, vi } from 'vitest';

import type { PluginContextV1 } from '@happier-dev/plugin-sdk';

import { createOpenCodeBackendEngine } from './engine.js';

function createPluginContextFixture(): PluginContextV1 {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    exec: {
      run: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: '{}', stderr: '' })),
      systemTools: {
        resolve: vi.fn(),
      },
    },
  } as unknown as PluginContextV1;
}

describe('createOpenCodeBackendEngine session surfaces', () => {
  it('exposes plugin-owned external-session, handoff, and fork surfaces', () => {
    const engine = createOpenCodeBackendEngine(createPluginContextFixture());

    expect(engine.externalSessionSurface).toMatchObject({
      resolveSource: expect.any(Function),
      listCandidates: expect.any(Function),
      pageTranscript: expect.any(Function),
      readAfterTranscript: expect.any(Function),
      resolveLinkIdentity: expect.any(Function),
      resolveLinkedIdentity: expect.any(Function),
      resolveTakeoverLaunch: expect.any(Function),
    });
    expect(engine.handoffSurface).toMatchObject({
      exportBundle: expect.any(Function),
      importBundle: expect.any(Function),
    });
    expect(engine.forkSurface).toMatchObject({
      resolveReplayChildLaunch: expect.any(Function),
    });
  });
});
