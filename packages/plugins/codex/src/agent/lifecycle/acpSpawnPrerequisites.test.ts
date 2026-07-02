import { describe, expect, it } from 'vitest';

import { resolveCodexAcpSpawnPrerequisiteFailure } from './acpSpawnPrerequisites.js';

describe('Codex ACP spawn prerequisite policy', () => {
  it('surfaces command resolution failures without replacing the resolver diagnostic', () => {
    expect(
      resolveCodexAcpSpawnPrerequisiteFailure({
        resolveErrorMessage: '/tmp/missing-codex-acp does not exist',
      }),
    ).toEqual({
      ok: false,
      reasonCode: 'codex_acp_unavailable',
      errorMessage: '/tmp/missing-codex-acp does not exist',
    });
  });

  it('uses the installable remediation message for default codex-acp PATH misses', () => {
    const result = resolveCodexAcpSpawnPrerequisiteFailure({
      command: 'codex-acp',
      availabilityErrorMessage: 'codex-acp was not found on PATH.',
    });

    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'codex_acp_unavailable',
    });
    expect(result.errorMessage).toContain('codex-acp could not be resolved');
    expect(result.errorMessage).toContain('Installables');
    expect(result.errorMessage).toContain('app-server');
  });

  it('preserves custom command availability diagnostics', () => {
    expect(
      resolveCodexAcpSpawnPrerequisiteFailure({
        command: '/tmp/codex-acp',
        availabilityErrorMessage: '/tmp/codex-acp is not executable.',
      }),
    ).toEqual({
      ok: false,
      reasonCode: 'codex_acp_unavailable',
      errorMessage: 'Codex ACP is enabled, but /tmp/codex-acp is not executable.',
    });
  });
});
