import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDraft } from './useDraft';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let isFocused = true;
let sessionsById: Record<string, { draft: string | null; metadata?: any }>;
const updateSessionDraftSpy = vi.fn();
const patchSessionMetadataWithRetrySpy = vi.fn();

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => isFocused,
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: () => ({ remove: () => {} }),
  },
}));

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => ({
      sessions: sessionsById,
      updateSessionDraft: (sessionId: string, draft: string | null) => {
        updateSessionDraftSpy(sessionId, draft);
        sessionsById = {
          ...sessionsById,
          [sessionId]: {
            ...(sessionsById[sessionId] ?? { draft: null }),
            draft,
          },
        };
      },
    }),
  },
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    patchSessionMetadataWithRetry: (...args: any[]) => patchSessionMetadataWithRetrySpy(...args),
  },
}));

type HarnessState = Readonly<{
  sessionId: string;
  setSessionId: (id: string) => void;
  value: string;
  setValue: (next: string) => void;
  rerender: () => void;
}>;

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function renderHarness(params: { initialSessionId: string }): Promise<{
  getCurrent: () => HarnessState;
  unmount: () => void;
}> {
  let current: HarnessState | null = null;

  function Harness() {
    const [sessionId, setSessionId] = React.useState(params.initialSessionId);
    const [value, setValue] = React.useState('');
    const [, setTick] = React.useState(0);
    useDraft(sessionId, value, setValue, { autoSaveInterval: 60_000 });
    current = { sessionId, setSessionId, value, setValue, rerender: () => setTick((tick) => tick + 1) };
    return null;
  }

  let root: renderer.ReactTestRenderer | null = null;
  await act(async () => {
    root = renderer.create(React.createElement(Harness));
    await flushAsync();
  });

  return {
    getCurrent: () => {
      if (!current) throw new Error('Harness did not render');
      return current;
    },
    unmount: () => {
      if (!root) return;
      act(() => root!.unmount());
    },
  };
}

describe('useDraft', () => {
  beforeEach(() => {
    isFocused = true;
    sessionsById = {
      s1: { draft: 'draft-1', metadata: {} },
      s2: { draft: null, metadata: {} },
      s3: { draft: 'draft-3', metadata: {} },
    };
    updateSessionDraftSpy.mockReset();
    patchSessionMetadataWithRetrySpy.mockReset();
  });

  it('clears the composer value when switching to a session with no stored draft', async () => {
    const harness = await renderHarness({ initialSessionId: 's1' });
    expect(harness.getCurrent().value).toBe('draft-1');

    await act(async () => {
      harness.getCurrent().setValue('typed-1');
      await flushAsync();
    });

    await act(async () => {
      harness.getCurrent().setSessionId('s2');
      await flushAsync();
    });

    expect(harness.getCurrent().value).toBe('');
    harness.unmount();
  });

  it('loads the new session draft when switching sessions even if the current value is non-empty', async () => {
    const harness = await renderHarness({ initialSessionId: 's1' });
    expect(harness.getCurrent().value).toBe('draft-1');

    await act(async () => {
      harness.getCurrent().setValue('typed-1');
      await flushAsync();
    });

    await act(async () => {
      harness.getCurrent().setSessionId('s3');
      await flushAsync();
    });

    expect(harness.getCurrent().value).toBe('draft-3');
    harness.unmount();
  });

  it('clears the composer value when switching sessions even if the screen is not focused (prevent draft leakage)', async () => {
    isFocused = false;
    const harness = await renderHarness({ initialSessionId: 's1' });

    await act(async () => {
      harness.getCurrent().setValue('typed-1');
      await flushAsync();
    });

    await act(async () => {
      harness.getCurrent().setSessionId('s2');
      await flushAsync();
    });

    expect(harness.getCurrent().value).toBe('');
    harness.unmount();
  });

  it('hydrates forkInitialPromptV1 into the draft when no saved draft exists', async () => {
    sessionsById = {
      s_child: {
        draft: null,
        metadata: {
          forkInitialPromptV1: {
            v: 1,
            text: 'restored fork prompt',
            createdAtMs: 1,
          },
        },
      },
    };

    const harness = await renderHarness({ initialSessionId: 's_child' });

    expect(harness.getCurrent().value).toBe('restored fork prompt');
    expect(updateSessionDraftSpy).toHaveBeenCalledWith('s_child', 'restored fork prompt');
    expect(patchSessionMetadataWithRetrySpy).toHaveBeenCalledWith(
      's_child',
      expect.any(Function),
    );
    harness.unmount();
  });

  it('clears forkInitialPromptV1 even when a saved draft already exists', async () => {
    sessionsById = {
      s_child: {
        draft: 'persisted fork draft',
        metadata: {
          forkInitialPromptV1: {
            v: 1,
            text: 'persisted fork draft',
            createdAtMs: 1,
          },
        },
      },
    };

    const harness = await renderHarness({ initialSessionId: 's_child' });

    expect(harness.getCurrent().value).toBe('persisted fork draft');
    expect(patchSessionMetadataWithRetrySpy).toHaveBeenCalledWith(
      's_child',
      expect.any(Function),
    );
    harness.unmount();
  });

  it('hydrates the composer when the current session draft changes externally while focused', async () => {
    sessionsById = {
      s1: { draft: null, metadata: {} },
    };

    const harness = await renderHarness({ initialSessionId: 's1' });
    expect(harness.getCurrent().value).toBe('');

    sessionsById = {
      ...sessionsById,
      s1: { draft: 'rollback restored prompt', metadata: {} },
    };

    await act(async () => {
      harness.getCurrent().rerender();
      await flushAsync();
    });

    expect(harness.getCurrent().value).toBe('rollback restored prompt');
    harness.unmount();
  });

  it('replaces the composer when an external draft update arrives and there are no unsaved local edits', async () => {
    sessionsById = {
      s1: { draft: 'draft-1', metadata: {} },
    };

    const harness = await renderHarness({ initialSessionId: 's1' });
    expect(harness.getCurrent().value).toBe('draft-1');

    await act(async () => {
      harness.getCurrent().setValue('draft-1 edited');
      await flushAsync();
    });

    // Simulate autosave committing the latest text so there are no unsaved local edits.
    sessionsById = {
      s1: { draft: 'draft-1 edited', metadata: {} },
    };
    await act(async () => {
      harness.getCurrent().rerender();
      await flushAsync();
    });

    sessionsById = {
      s1: { draft: 'rollback target prompt', metadata: {} },
    };

    await act(async () => {
      harness.getCurrent().rerender();
      await flushAsync();
    });

    expect(harness.getCurrent().value).toBe('rollback target prompt');
    harness.unmount();
  });
});
