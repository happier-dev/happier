import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = process.env;

describe('listBuiltInHappierTools', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  });

  it('filters action-backed tools dynamically using current CLI action settings', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['cli'], disabledPlacements: [] },
      },
    });

    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const names = listBuiltInHappierTools({ surface: 'cli' }).map((tool) => tool.name);

    expect(names).not.toContain('review_start');
    expect(names).toContain('subagents_plan_start');
    expect(names).toContain('change_title');
  });

  it('does not expose MCP-only discovery tools on the CLI surface', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const names = listBuiltInHappierTools({ surface: 'cli' }).map((tool) => tool.name);

    expect(names).not.toContain('action_spec_search');
    expect(names).not.toContain('action_spec_get');
    expect(names).not.toContain('action_options_resolve');
    expect(names).toContain('action_execute');
    expect(names).toContain('review_start');
  });
});
