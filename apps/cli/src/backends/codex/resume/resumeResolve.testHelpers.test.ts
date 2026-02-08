import { describe, expect, it } from 'vitest';

import { withResumeEnv } from './resumeResolve.testHelpers';

describe('withResumeEnv', () => {
  it('keeps unspecified tracked env vars unchanged', async () => {
    const previous = {
      HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
      HAPPIER_CODEX_RESUME_MCP_SERVER_BIN: process.env.HAPPIER_CODEX_RESUME_MCP_SERVER_BIN,
      HAPPIER_CODEX_RESUME_BIN: process.env.HAPPIER_CODEX_RESUME_BIN,
    };

    process.env.HAPPIER_HOME_DIR = '/tmp/original-home';
    process.env.HAPPIER_CODEX_RESUME_MCP_SERVER_BIN = '/tmp/original-mcp';
    process.env.HAPPIER_CODEX_RESUME_BIN = '/tmp/original-bin';

    try {
      await withResumeEnv({ HAPPIER_HOME_DIR: '/tmp/override-home' }, async () => {
        expect(process.env.HAPPIER_HOME_DIR).toBe('/tmp/override-home');
        expect(process.env.HAPPIER_CODEX_RESUME_MCP_SERVER_BIN).toBe('/tmp/original-mcp');
        expect(process.env.HAPPIER_CODEX_RESUME_BIN).toBe('/tmp/original-bin');
      });
    } finally {
      if (previous.HAPPIER_HOME_DIR === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = previous.HAPPIER_HOME_DIR;

      if (previous.HAPPIER_CODEX_RESUME_MCP_SERVER_BIN === undefined) delete process.env.HAPPIER_CODEX_RESUME_MCP_SERVER_BIN;
      else process.env.HAPPIER_CODEX_RESUME_MCP_SERVER_BIN = previous.HAPPIER_CODEX_RESUME_MCP_SERVER_BIN;

      if (previous.HAPPIER_CODEX_RESUME_BIN === undefined) delete process.env.HAPPIER_CODEX_RESUME_BIN;
      else process.env.HAPPIER_CODEX_RESUME_BIN = previous.HAPPIER_CODEX_RESUME_BIN;
    }
  });
});
