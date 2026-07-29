import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

const { mockListActionSpecs } = vi.hoisted(() => ({
  mockListActionSpecs: vi.fn(() => []),
}));

vi.mock('@happier-dev/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
  return {
    ...actual,
    listActionSpecs: mockListActionSpecs,
  };
});

describe('Happier built-in tool catalog convergence', () => {
  beforeEach(() => {
    vi.resetModules();
    mockListActionSpecs.mockClear();
    mockListActionSpecs.mockReturnValue([]);
  });

  it('does not synthesize execution_run_start as a manual built-in fallback when action specs do not provide it', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');

    const tools = listBuiltInHappierTools({
      surface: 'cli',
      registry: createResolvedContributionRegistry({
        agents: [],
              }),
    });
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('action_execute');
    expect(names).not.toContain('execution_run_start');
  });
});
