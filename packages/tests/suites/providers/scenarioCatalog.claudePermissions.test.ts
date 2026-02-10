import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

function claudeProviderStub(): ProviderUnderTest {
  return {
    id: 'claude',
    enableEnvVar: 'HAPPIER_E2E_PROVIDER_CLAUDE',
    protocol: 'claude',
    traceProvider: 'claude',
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: [] } },
    cli: { subcommand: 'claude' },
  };
}

describe('scenarioCatalog (claude permissions)', () => {
  it('does not require permission-request fixtures for outside-workspace write surface scenario', () => {
    const scenario = scenarioCatalog.permission_surface_outside_workspace(claudeProviderStub());
    const keys = (scenario.requiredAnyFixtureKeys ?? []).flat();
    expect(keys.some((key) => key.includes('/permission-request/'))).toBe(false);
    expect(keys.some((key) => key.includes('/tool-call/Write') || key.includes('/tool-call/Edit'))).toBe(true);
    expect(keys.some((key) => key.includes('/tool-result/Write') || key.includes('/tool-result/Edit'))).toBe(true);
  });

  it('pins allowed tools to Write/Edit for the outside-workspace scenario', () => {
    const scenario = scenarioCatalog.permission_surface_outside_workspace(claudeProviderStub());
    const messageMeta = scenario.messageMeta && typeof scenario.messageMeta === 'object'
      ? (scenario.messageMeta as Record<string, unknown>)
      : {};
    const allowedTools = Array.isArray(messageMeta.allowedTools) ? messageMeta.allowedTools : [];
    expect(allowedTools).toContain('Write');
    expect(allowedTools).toContain('Edit');
  });

  it('does not fail deny scenario when no permission-request fixture is surfaced', async () => {
    const scenario = scenarioCatalog.permission_deny_outside_workspace(claudeProviderStub());
    expect(typeof scenario.setup).toBe('function');
    expect(typeof scenario.prompt).toBe('function');
    expect(typeof scenario.verify).toBe('function');

    const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-claude-deny-'));
    await scenario.setup?.({ workspaceDir });
    const prompt = scenario.prompt?.({ workspaceDir }) ?? '';
    const pathLine = prompt.split('\n').find((line) => line.startsWith('- Absolute path: '));
    const outsidePath = pathLine?.replace('- Absolute path: ', '').trim() ?? '';
    expect(outsidePath.length).toBeGreaterThan(0);

    await mkdir(join(workspaceDir, 'outside-seed'), { recursive: true });
    await writeFile(outsidePath, 'OUTSIDE_CLAUDE_DENIED_E2E\n', 'utf8');

    await expect(
      scenario.verify?.({
        workspaceDir,
        fixtures: {
          examples: {
            'claude/claude/tool-call/Write': [{ payload: { input: { file_path: outsidePath } } }],
          },
        },
        traceEvents: [],
        baseUrl: 'http://127.0.0.1',
        token: 'token',
        sessionId: 'session',
        resumeSessionId: null,
        secret: new Uint8Array(),
        resumeId: null,
      }),
    ).resolves.toBeUndefined();
  });
});
