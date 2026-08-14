import { afterEach, describe, expect, it, vi } from 'vitest';

const setupMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('./test-setup', () => ({
  setup: setupMock,
}));

import globalSetup from './test-setup.unit';

describe('CLI shared deps test setup', () => {
  const originalSkipBuild = process.env.HAPPIER_CLI_TEST_SKIP_BUILD;

  afterEach(() => {
    if (typeof originalSkipBuild === 'string') {
      process.env.HAPPIER_CLI_TEST_SKIP_BUILD = originalSkipBuild;
    } else {
      delete process.env.HAPPIER_CLI_TEST_SKIP_BUILD;
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses source-only setup without publishing workspace output', async () => {
    await globalSetup();

    expect(setupMock).toHaveBeenCalledWith({ buildMode: 'none' });
  });
});
