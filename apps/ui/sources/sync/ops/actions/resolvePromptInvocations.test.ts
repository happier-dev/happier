import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted<{ current: unknown }>(() => ({ current: null }));

vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({ storage: { getState: () => state.current } });
});

vi.mock('@/sync/domains/input/slashCommands/expandPromptTemplateInvocation', () => ({
  expandPromptTemplateInvocation: vi.fn(),
}));

import {
  listPromptInvocationsForActions,
  resolvePromptInvocationForActions,
} from './resolvePromptInvocations';

describe('listPromptInvocationsForActions', () => {
  beforeEach(() => {
    state.current = null;
  });

  it('returns the complete settings-bounded inventory when no caller limit is requested', () => {
    const entries = Array.from({ length: 501 }, (_, index) => ({
      id: `prompt-${index}`,
      token: `/prompt-${index}`,
      title: `Prompt ${index}`,
      target: { kind: 'doc' as const, artifactId: `artifact-${index}` },
      behavior: 'insert' as const,
      allowArgs: false,
      availableIn: 'global' as const,
    }));
    state.current = { settings: { promptInvocationsV1: { v: 1, entries } } };

    const result = listPromptInvocationsForActions({});

    expect(result.coverage).toBe('complete');
    expect(result.items).toHaveLength(501);
    expect(result.items.at(-1)?.id).toBe('prompt-500');
  });

  it('marks an explicitly limited projection as truncated', () => {
    state.current = {
      settings: {
        promptInvocationsV1: {
          v: 1,
          entries: [0, 1].map((index) => ({
            id: `prompt-${index}`,
            token: `/prompt-${index}`,
            title: `Prompt ${index}`,
            target: { kind: 'doc' as const, artifactId: `artifact-${index}` },
          })),
        },
      },
    };

    expect(listPromptInvocationsForActions({ limit: 1 })).toMatchObject({
      coverage: 'truncated',
      items: [{ id: 'prompt-0' }],
    });
  });

  it('does not turn an unreadable settings value into authoritative deletion', async () => {
    state.current = { settings: { promptInvocationsV1: { v: 1, entries: 'unreadable' } } };

    expect(listPromptInvocationsForActions({})).toEqual({
      items: [],
      coverage: 'unavailable',
    });
    await expect(resolvePromptInvocationForActions({ invocationId: 'prompt-1' })).resolves.toEqual({
      status: 'unavailable',
      invocationId: 'prompt-1',
    });
  });
});
