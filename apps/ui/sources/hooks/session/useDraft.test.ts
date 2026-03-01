import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDraft } from './useDraft';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let isFocused = true;
let sessionsById: Record<string, { draft: string | null }>;
const updateSessionDraftSpy = vi.fn();

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

type HarnessState = Readonly<{
  sessionId: string;
  setSessionId: (id: string) => void;
  value: string;
  setValue: (next: string) => void;
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
    useDraft(sessionId, value, setValue, { autoSaveInterval: 60_000 });
    current = { sessionId, setSessionId, value, setValue };
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
      s1: { draft: 'draft-1' },
      s2: { draft: null },
      s3: { draft: 'draft-3' },
    };
    updateSessionDraftSpy.mockReset();
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
});
