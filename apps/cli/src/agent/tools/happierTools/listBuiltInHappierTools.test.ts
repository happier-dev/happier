import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = process.env;

describe('listBuiltInHappierTools', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  });

  it('filters action-backed tools dynamically using current MCP action settings', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['mcp'], disabledPlacements: [] },
      },
    });

    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const names = listBuiltInHappierTools().map((tool) => tool.name);

    expect(names).not.toContain('review_start');
    expect(names).toContain('subagents_plan_start');
    expect(names).toContain('change_title');
  });
});
