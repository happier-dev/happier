import { describe, expect, it } from 'vitest';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

const cursorStub: ProviderUnderTest = {
  id: 'cursor_acp_stub', enableEnvVar: 'HAPPIER_E2E_PROVIDER_CURSOR_ACP_STUB', protocol: 'acp', traceProvider: 'cursor',
  scenarioRegistry: { v: 1, tiers: { smoke: [], extended: ['cursor_acp_stub_captured_lifecycle_replay'] } },
  cli: { subcommand: 'cursor' },
};

describe('Cursor captured replay scenario', () => {
  it('is a deterministic extended resume scenario', () => {
    const scenario = scenarioCatalog.cursor_acp_stub_captured_lifecycle_replay?.(cursorStub);
    expect(scenario).toMatchObject({ id: 'cursor_acp_stub_captured_lifecycle_replay', tier: 'extended' });
    expect(scenario?.resume).toMatchObject({ metadataKey: 'cursorSessionId', freshSession: true });
  });

  it('uses an executable ACP fixture command', async () => {
    const fixturePath = resolve(
      process.cwd(),
      'fixtures/cli-backends/cursor_acp_stub/cursor-acp-stub-provider.mjs',
    );
    const fixtureStat = await stat(fixturePath);
    expect(fixtureStat.mode & 0o111).not.toBe(0);
  });
});
