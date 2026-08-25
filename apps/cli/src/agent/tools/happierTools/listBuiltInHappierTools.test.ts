import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';

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
        'session.title.set': { enabled: true, disabledSurfaces: ['cli'], disabledPlacements: [] },
      },
    });

    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const names = listBuiltInHappierTools({ surface: 'cli' }).map((tool) => tool.name);

    expect(names).not.toContain('review_start');
    expect(names).not.toContain('change_title');
    expect(names).toContain('subagents_plan_start');
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

  it('keeps only bootstrap tools directly exposed to session agents by default', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const names = listBuiltInHappierTools({ surface: 'session_agent' }).map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      'change_title',
      'action_spec_search',
      'action_spec_get',
      'action_options_resolve',
      'action_execute',
    ]));
    expect(names).not.toContain('review_start');
    expect(names).not.toContain('subagents_plan_start');
    expect(names).not.toContain('subagents_delegate_start');
    expect(names).not.toContain('execution_run_start');
    expect(names).not.toContain('execution_run_get');
    expect(names).not.toContain('execution_run_action');
    expect(names).not.toContain('agents_backends_list');
    expect(names).not.toContain('session_list');
    expect(names).not.toContain('session_transcript_get');
  });

  it('preserves direct action tools by default for external MCP clients and CLI users', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const mcpNames = listBuiltInHappierTools({ surface: 'mcp' }).map((tool) => tool.name);
    const cliNames = listBuiltInHappierTools({ surface: 'cli' }).map((tool) => tool.name);

    expect(mcpNames).toEqual(expect.arrayContaining([
      'review_start',
      'subagents_plan_start',
      'subagents_delegate_start',
      'execution_run_start',
      'agents_backends_list',
    ]));
    expect(cliNames).toEqual(expect.arrayContaining([
      'review_start',
      'subagents_plan_start',
      'subagents_delegate_start',
      'execution_run_start',
      'agents_backends_list',
    ]));
  });

  it('allows action settings to explicitly expose a discoverable-only action as a direct session-agent tool', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'subagents.delegate.start': {
          enabled: true,
          toolExposureModes: { session_agent: 'direct' },
        },
      },
    });

    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const names = listBuiltInHappierTools({ surface: 'session_agent' }).map((tool) => tool.name);

    expect(names).toContain('subagents_delegate_start');
  });

  it('does not expose change_title when session title updates are discoverable-only', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const names = listBuiltInHappierTools({
      surface: 'session_agent',
      actionsSettings: ActionsSettingsV1Schema.parse({
        v: 1,
        actions: {
          'session.title.set': {
            toolExposureModes: { session_agent: 'discoverable_only' },
          },
        },
      }),
    }).map((tool) => tool.name);

    expect(names).not.toContain('change_title');
  });

  it('adds guidance-required direct tools without overriding an explicit discoverable-only preference', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const required = listBuiltInHappierTools({
      surface: 'session_agent',
      requiredDirectActionIds: ['memory.search', 'memory.get_window'],
    }).map((tool) => tool.name);
    expect(required).toEqual(expect.arrayContaining(['memory_search', 'memory_get_window']));

    const explicitlyDiscoverable = listBuiltInHappierTools({
      surface: 'session_agent',
      requiredDirectActionIds: ['memory.search', 'memory.get_window'],
      actionsSettings: ActionsSettingsV1Schema.parse({
        v: 1,
        actions: {
          'memory.search': { toolExposureModes: { session_agent: 'discoverable_only' } },
        },
      }),
    }).map((tool) => tool.name);
    expect(explicitlyDiscoverable).not.toContain('memory_search');
    expect(explicitlyDiscoverable).toContain('memory_get_window');
  });
});
