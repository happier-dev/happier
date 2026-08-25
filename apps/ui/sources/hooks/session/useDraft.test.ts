import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDraft } from './useDraft';
import { TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT } from '@/components/ui/forms/largeTextInputPolicy';
import { flushHookEffects, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let isFocused = true;
let onHarnessLayoutEffect: (() => void) | null = null;
let sessionsById: Record<string, {
  draft: string | null;
  metadata?: any;
  metadataLayoutVersion?: number;
  ownerMetadataView?: any;
}>;
const writeExistingSessionDraftSpy = vi.fn();
const flushSessionDraftSpy = vi.fn(async (_input: unknown) => ({ status: 'clean' as const }));
const patchSessionMetadataWithRetrySpy = vi.fn();
const platformState = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' | 'android' }));
const activeServerAccountScope = Object.freeze({ serverId: 'server-test', accountId: 'account-test' });
const sessionDraftListeners = new Set<() => void>();

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => isFocused,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        get OS() {
                            return platformState.os;
                        },
                        select: (value: Record<string, unknown>) => value[platformState.os] ?? value.native ?? value.default ?? value.web,
                    },
                    AppState: {
                        addEventListener: () => ({ remove: () => {} }),
                    },
                }
    );
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
    getState: () => ({
      sessions: sessionsById,
    }),
  },
});
});

vi.mock('@/sync/store/hooks', () => ({
  useActiveServerAccountScope: () => activeServerAccountScope,
}));

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', () => ({
  flushSessionDraft: (input: unknown) => flushSessionDraftSpy(input),
  getSessionDraftSnapshot: (_scope: unknown, address: { sessionId: string }) => {
    const text = sessionsById[address.sessionId]?.draft;
    return typeof text === 'string'
      ? { document: { composer: { text: { value: text } } } }
      : null;
  },
  subscribeSessionDraft: (_scope: unknown, _address: unknown, listener: () => void) => {
    sessionDraftListeners.add(listener);
    return () => sessionDraftListeners.delete(listener);
  },
  writeExistingSessionDraft: (input: { sessionId: string; patch: { text?: string } }) => {
    writeExistingSessionDraftSpy(input.sessionId, input.patch.text?.trim() ? input.patch.text : null);
    sessionsById = {
      ...sessionsById,
      [input.sessionId]: {
        ...(sessionsById[input.sessionId] ?? { draft: null }),
        draft: input.patch.text?.trim() ? input.patch.text : null,
      },
    };
  },
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    patchSessionMetadataWithRetry: (...args: any[]) => patchSessionMetadataWithRetrySpy(...args),
  },
}));

function installFakeVisibilityDocument() {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const listenersByEvent = new Map<string, Set<() => void>>();
  let visibilityState: DocumentVisibilityState = 'visible';

  const fakeDocument = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: (eventName: string, listener: () => void) => {
      const listeners = listenersByEvent.get(eventName) ?? new Set<() => void>();
      listeners.add(listener);
      listenersByEvent.set(eventName, listeners);
    },
    removeEventListener: (eventName: string, listener: () => void) => {
      listenersByEvent.get(eventName)?.delete(listener);
    },
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: fakeDocument,
  });

  return {
    dispatch: (eventName: string) => {
      for (const listener of listenersByEvent.get(eventName) ?? []) {
        listener();
      }
    },
    setVisibilityState: (nextVisibilityState: DocumentVisibilityState) => {
      visibilityState = nextVisibilityState;
    },
    restore: () => {
      if (previousDescriptor) {
        Object.defineProperty(globalThis, 'document', previousDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'document');
      }
    },
  };
}

function installFakeWindowLifecycleEvents() {
  const previousAddEventListenerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
  const previousRemoveEventListenerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener');
  const listenersByEvent = new Map<string, Set<() => void>>();

  Object.defineProperty(globalThis, 'addEventListener', {
    configurable: true,
    value: (eventName: string, listener: () => void) => {
      const listeners = listenersByEvent.get(eventName) ?? new Set<() => void>();
      listeners.add(listener);
      listenersByEvent.set(eventName, listeners);
    },
  });
  Object.defineProperty(globalThis, 'removeEventListener', {
    configurable: true,
    value: (eventName: string, listener: () => void) => {
      listenersByEvent.get(eventName)?.delete(listener);
    },
  });

  return {
    dispatch: (eventName: string) => {
      for (const listener of listenersByEvent.get(eventName) ?? []) {
        listener();
      }
    },
    restore: () => {
      if (previousAddEventListenerDescriptor) {
        Object.defineProperty(globalThis, 'addEventListener', previousAddEventListenerDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'addEventListener');
      }
      if (previousRemoveEventListenerDescriptor) {
        Object.defineProperty(globalThis, 'removeEventListener', previousRemoveEventListenerDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'removeEventListener');
      }
    },
  };
}

type HarnessState = Readonly<{
  sessionId: string;
  setSessionId: (id: string) => void;
  value: string;
  setValue: (next: string) => void;
  clearDraft: () => void;
  clearDraftForSessionIfCurrentValueMatches: (snapshot: Readonly<{ sessionId: string; text: string }>) => boolean;
  clearDraftIfCurrentValueMatches: (expectedValue: string) => boolean;
  setDraftValue: (nextValueOrUpdater: string | ((currentValue: string) => string)) => void;
  restoreDraftForSessionIfCurrentValueMatches?: (
    snapshot: Readonly<{ sessionId: string; text: string }>,
    expectedCurrentValue: string,
  ) => boolean;
  restoreDraft: (draft: string) => void;
  restoreComposerSnapshot: (snapshot: Readonly<{ sessionId: string; text: string }>) => void;
  rerender: () => void;
}>;

async function renderHarness(params: { initialSessionId: string }): Promise<{
  getCurrent: () => HarnessState;
  unmount: () => void;
}> {
  let current: HarnessState | null = null;

  function Harness() {
    const [sessionId, setSessionId] = React.useState(params.initialSessionId);
    const [value, setValue] = React.useState('');
    const [, setTick] = React.useState(0);
    const {
      clearDraft,
      clearDraftForSessionIfCurrentValueMatches,
      clearDraftIfCurrentValueMatches,
      setDraftValue,
      restoreDraftForSessionIfCurrentValueMatches,
      restoreDraft,
      restoreComposerSnapshot,
    } = useDraft(sessionId, value, setValue, { autoSaveInterval: 60_000 });
    React.useLayoutEffect(() => {
      onHarnessLayoutEffect?.();
    });
    current = {
      sessionId,
      setSessionId,
      value,
      setValue,
      clearDraft,
      clearDraftForSessionIfCurrentValueMatches,
      clearDraftIfCurrentValueMatches,
      setDraftValue,
      restoreDraftForSessionIfCurrentValueMatches,
      restoreDraft,
      restoreComposerSnapshot,
      rerender: () => setTick((tick) => tick + 1),
    };
    return null;
  }

  let root: renderer.ReactTestRenderer | null = null;
  root = (await renderScreen(React.createElement(Harness))).tree;

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
    onHarnessLayoutEffect = null;
    platformState.os = 'web';
    sessionsById = {
      s1: { draft: 'draft-1', metadata: {} },
      s2: { draft: null, metadata: {} },
      s3: { draft: 'draft-3', metadata: {} },
    };
    writeExistingSessionDraftSpy.mockReset();
    flushSessionDraftSpy.mockClear();
    patchSessionMetadataWithRetrySpy.mockReset();
    sessionDraftListeners.clear();
  });

  it('publishes a large web draft locally while debouncing its remote flush', async () => {
    vi.useFakeTimers();
    try {
      const harness = await renderHarness({ initialSessionId: 's2' });
      writeExistingSessionDraftSpy.mockClear();
      const largeDraft = `x${'y'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT)}`;

      await act(async () => {
        harness.getCurrent().setValue(largeDraft);
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      expect(writeExistingSessionDraftSpy).toHaveBeenCalledWith('s2', largeDraft);
      expect(flushSessionDraftSpy).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(writeExistingSessionDraftSpy).toHaveBeenCalledWith('s2', largeDraft);
      expect(flushSessionDraftSpy).toHaveBeenCalled();
      harness.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes a large native draft locally while debouncing its remote flush', async () => {
    platformState.os = 'ios';
    vi.useFakeTimers();
    try {
      const harness = await renderHarness({ initialSessionId: 's2' });
      writeExistingSessionDraftSpy.mockClear();
      const largeDraft = `x${'y'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT)}`;

      await act(async () => {
        harness.getCurrent().setValue(largeDraft);
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      expect(writeExistingSessionDraftSpy).toHaveBeenCalledWith('s2', largeDraft);
      expect(flushSessionDraftSpy).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(writeExistingSessionDraftSpy).toHaveBeenCalledWith('s2', largeDraft);
      expect(flushSessionDraftSpy).toHaveBeenCalled();
      harness.unmount();
    } finally {
      vi.useRealTimers();
      platformState.os = 'web';
    }
  });

  it('publishes composer edits to the local canonical replica in the input event', async () => {
    const harness = await renderHarness({ initialSessionId: 's2' });
    writeExistingSessionDraftSpy.mockClear();

    act(() => {
      harness.getCurrent().setDraftValue('hello world hello world');
      expect(writeExistingSessionDraftSpy).toHaveBeenCalledWith('s2', 'hello world hello world');
    });

    expect(harness.getCurrent().value).toBe('hello world hello world');
    harness.unmount();
  });

  it('flushes a cleared draft to the remote repository in the clear event', async () => {
    const harness = await renderHarness({ initialSessionId: 's1' });
    flushSessionDraftSpy.mockClear();

    act(() => {
      harness.getCurrent().clearDraft();
      expect(flushSessionDraftSpy).toHaveBeenCalledWith(expect.objectContaining({
        address: { kind: 'session', sessionId: 's1' },
      }));
    });

    harness.unmount();
  });

  it('clears the composer value when switching to a session with no stored draft', async () => {
    const harness = await renderHarness({ initialSessionId: 's1' });
    expect(harness.getCurrent().value).toBe('draft-1');

    await act(async () => {
      harness.getCurrent().setValue('typed-1');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });
    flushSessionDraftSpy.mockClear();

    await act(async () => {
      harness.getCurrent().setSessionId('s2');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().value).toBe('');
    expect(flushSessionDraftSpy).toHaveBeenCalledWith(expect.objectContaining({
      address: { kind: 'session', sessionId: 's1' },
    }));
    harness.unmount();
  });

  it('loads the new session draft when switching sessions even if the current value is non-empty', async () => {
    const harness = await renderHarness({ initialSessionId: 's1' });
    expect(harness.getCurrent().value).toBe('draft-1');

    await act(async () => {
      harness.getCurrent().setValue('typed-1');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      harness.getCurrent().setSessionId('s3');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().value).toBe('draft-3');
    harness.unmount();
  });

  it('clears the composer value when switching sessions even if the screen is not focused (prevent draft leakage)', async () => {
    isFocused = false;
    const harness = await renderHarness({ initialSessionId: 's1' });

    await act(async () => {
      harness.getCurrent().setValue('typed-1');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      harness.getCurrent().setSessionId('s2');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

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
    expect(writeExistingSessionDraftSpy).toHaveBeenCalledWith('s_child', 'restored fork prompt');
    expect(patchSessionMetadataWithRetrySpy).toHaveBeenCalledWith(
      's_child',
      expect.any(Function),
    );
    harness.unmount();
  });

  it('hydrates a layout-v1 initial prompt from the owner view without falling back to shared metadata', async () => {
    sessionsById = {
      s_child: {
        draft: null,
        metadataLayoutVersion: 1,
        metadata: {
          v: 1,
          summary: {
            text: 'Shared title',
            updatedAt: 1,
          },
          forkInitialPromptV1: {
            v: 1,
            text: 'must not be read from shared metadata',
            createdAtMs: 1,
          },
        },
        ownerMetadataView: {
          forkInitialPromptV1: {
            v: 1,
            text: 'private restored fork prompt',
            createdAtMs: 2,
          },
        },
      },
    };

    const harness = await renderHarness({ initialSessionId: 's_child' });

    expect(harness.getCurrent().value).toBe('private restored fork prompt');
    expect(writeExistingSessionDraftSpy).toHaveBeenCalledWith('s_child', 'private restored fork prompt');
    harness.unmount();
  });

  it('hydrates sessionInitialPromptV1 replace mode into an empty composer and clears the metadata field', async () => {
    sessionsById = {
      s_target: {
        draft: null,
        metadata: {
          sessionInitialPromptV1: {
            v: 1,
            text: 'selected transcript messages',
            mode: 'replace',
            createdAtMs: 1,
            sourceSessionId: 's_source',
          },
        },
      },
    };

    const harness = await renderHarness({ initialSessionId: 's_target' });

    expect(harness.getCurrent().value).toBe('selected transcript messages');
    expect(writeExistingSessionDraftSpy).toHaveBeenCalledWith('s_target', 'selected transcript messages');
    expect(patchSessionMetadataWithRetrySpy).toHaveBeenCalledWith('s_target', expect.any(Function));
    harness.unmount();
  });

  it('does not re-append sessionInitialPromptV1 while waiting for the metadata clear to sync back', async () => {
    const metadata = {
      sessionInitialPromptV1: {
        v: 1,
        text: 'selected transcript messages',
        mode: 'append',
        createdAtMs: 1,
      },
    };
    sessionsById = {
      s_target: {
        draft: 'existing destination draft',
        metadata,
      },
    };

    const harness = await renderHarness({ initialSessionId: 's_target' });
    expect(harness.getCurrent().value).toBe('existing destination draft\n\nselected transcript messages');

    sessionsById = {
      s_target: {
        draft: 'existing destination draft\n\nselected transcript messages',
        metadata,
      },
    };

    await act(async () => {
      harness.getCurrent().rerender();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().value).toBe('existing destination draft\n\nselected transcript messages');
    harness.unmount();
  });

  it('appends sessionInitialPromptV1 to an existing stored draft', async () => {
    sessionsById = {
      s_target: {
        draft: 'existing destination draft',
        metadata: {
          sessionInitialPromptV1: {
            v: 1,
            text: 'selected transcript messages',
            mode: 'append',
            createdAtMs: 1,
          },
        },
      },
    };

    const harness = await renderHarness({ initialSessionId: 's_target' });

    expect(harness.getCurrent().value).toBe('existing destination draft\n\nselected transcript messages');
    expect(writeExistingSessionDraftSpy).toHaveBeenCalledWith('s_target', 'existing destination draft\n\nselected transcript messages');
    expect(patchSessionMetadataWithRetrySpy).toHaveBeenCalledWith('s_target', expect.any(Function));
    harness.unmount();
  });

  it('applies forkInitialPromptV1 before appending sessionInitialPromptV1', async () => {
    sessionsById = {
      s_child: {
        draft: null,
        metadata: {
          forkInitialPromptV1: {
            v: 1,
            text: 'fork seed',
            createdAtMs: 1,
          },
          sessionInitialPromptV1: {
            v: 1,
            text: 'selected transcript messages',
            mode: 'append',
            createdAtMs: 2,
          },
        },
      },
    };

    const harness = await renderHarness({ initialSessionId: 's_child' });

    expect(harness.getCurrent().value).toBe('fork seed\n\nselected transcript messages');
    expect(writeExistingSessionDraftSpy).toHaveBeenCalledWith('s_child', 'fork seed\n\nselected transcript messages');
    expect(patchSessionMetadataWithRetrySpy).toHaveBeenCalledWith('s_child', expect.any(Function));
    harness.unmount();
  });

  it('appends sessionInitialPromptV1 to the immediate canonical local edit', async () => {
    sessionsById = {
      s_target: { draft: 'existing destination draft', metadata: {} },
    };

    const harness = await renderHarness({ initialSessionId: 's_target' });
    expect(harness.getCurrent().value).toBe('existing destination draft');

    await act(async () => {
      harness.getCurrent().setValue('unsaved local edit');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    sessionsById = {
      s_target: {
        draft: 'unsaved local edit',
        metadata: {
          sessionInitialPromptV1: {
            v: 1,
            text: 'selected transcript messages',
            mode: 'append',
            createdAtMs: 1,
          },
        },
      },
    };

    await act(async () => {
      harness.getCurrent().rerender();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().value).toBe('unsaved local edit\n\nselected transcript messages');
    expect(patchSessionMetadataWithRetrySpy).toHaveBeenCalledWith('s_target', expect.any(Function));
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
      for (const listener of sessionDraftListeners) listener();
    });

        expect(harness.getCurrent().value).toBe('rollback restored prompt');
        harness.unmount();
    });

    it('normalizes session ids before reading and clearing drafts', async () => {
        const harness = await renderHarness({ initialSessionId: '  s1  ' });
        expect(harness.getCurrent().value).toBe('draft-1');
        flushSessionDraftSpy.mockClear();

        await act(async () => {
            harness.getCurrent().clearDraft();
        });

        expect(writeExistingSessionDraftSpy).toHaveBeenCalledWith('s1', null);
        expect(flushSessionDraftSpy).toHaveBeenCalledWith(expect.objectContaining({
          address: { kind: 'session', sessionId: 's1' },
        }));
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
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    // Simulate autosave committing the latest text so there are no unsaved local edits.
    sessionsById = {
      s1: { draft: 'draft-1 edited', metadata: {} },
    };
    await act(async () => {
      harness.getCurrent().rerender();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    sessionsById = {
      s1: { draft: 'rollback target prompt', metadata: {} },
    };

    await act(async () => {
      harness.getCurrent().rerender();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().value).toBe('rollback target prompt');
    harness.unmount();
  });

  it('does not adopt a repository snapshot superseded before its passive hydration effect runs', async () => {
    sessionsById = {
      s2: { draft: 'hello world', metadata: {} },
    };
    const harness = await renderHarness({ initialSessionId: 's2' });
    expect(harness.getCurrent().value).toBe('hello world');

    sessionsById = {
      s2: { draft: 'hello wo', metadata: {} },
    };
    onHarnessLayoutEffect = () => {
      onHarnessLayoutEffect = null;
      sessionsById = {
        s2: { draft: 'hello world', metadata: {} },
      };
    };

    await act(async () => {
      harness.getCurrent().rerender();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().value).toBe('hello world');
    expect(sessionsById.s2?.draft).toBe('hello world');
    harness.unmount();
  });

  it('does not restore the previous draft after clearDraft clears the composer', async () => {
    sessionsById = {
      s1: { draft: 'draft-1', metadata: {} },
    };

    const harness = await renderHarness({ initialSessionId: 's1' });
    expect(harness.getCurrent().value).toBe('draft-1');

    await act(async () => {
      harness.getCurrent().clearDraft();
      harness.getCurrent().setValue('');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(sessionsById.s1?.draft).toBeNull();
    expect(harness.getCurrent().value).toBe('');
    harness.unmount();
  });

  it('does not let a pre-handoff passive save resurrect text after compare-clear', async () => {
    sessionsById = {
      s1: { draft: null, metadata: {} },
    };

    const harness = await renderHarness({ initialSessionId: 's1' });
    onHarnessLayoutEffect = () => {
      onHarnessLayoutEffect = null;
      expect(harness.getCurrent().clearDraftForSessionIfCurrentValueMatches({
        sessionId: 's1',
        text: 'submitted prompt',
      })).toBe(true);
    };

    await act(async () => {
      harness.getCurrent().setDraftValue('submitted prompt');
    });
    await flushHookEffects({ cycles: 2, turns: 2 });

    expect(harness.getCurrent().value).toBe('');
    expect(sessionsById.s1?.draft).toBeNull();
    harness.unmount();
  });

  it('clears the active draft only when the current value still matches the submitted snapshot', async () => {
    const harness = await renderHarness({ initialSessionId: 's1' });
    expect(harness.getCurrent().value).toBe('draft-1');

    await act(async () => {
      harness.getCurrent().setValue('draft typed after send started');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    let cleared = true;
    await act(async () => {
      cleared = harness.getCurrent().clearDraftIfCurrentValueMatches('draft-1');
    });

    expect(cleared).toBe(false);
    expect(harness.getCurrent().value).toBe('draft typed after send started');
    expect(sessionsById.s1?.draft).toBe('draft typed after send started');
    harness.unmount();
  });

  it('does not clear a synchronous draft update before the next render', async () => {
    const harness = await renderHarness({ initialSessionId: 's1' });
    expect(harness.getCurrent().value).toBe('draft-1');

    let cleared = true;
    await act(async () => {
      const current = harness.getCurrent();
      current.setDraftValue('draft typed during async send');
      cleared = current.clearDraftForSessionIfCurrentValueMatches({
        sessionId: 's1',
        text: 'draft-1',
      });
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(cleared).toBe(false);
    expect(harness.getCurrent().value).toBe('draft typed during async send');
    harness.unmount();
  });

  it('clears an inactive session draft only when that session draft still matches the snapshot', async () => {
    const harness = await renderHarness({ initialSessionId: 's1' });
    await act(async () => {
      harness.getCurrent().setSessionId('s3');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    let cleared = false;
    await act(async () => {
      cleared = harness.getCurrent().clearDraftForSessionIfCurrentValueMatches({
        sessionId: 's1',
        text: 'draft-1',
      });
    });

    expect(cleared).toBe(true);
    expect(sessionsById.s1?.draft).toBeNull();
    expect(harness.getCurrent().value).toBe('draft-3');
    harness.unmount();
  });

  it('restores a composer snapshot to the owning session without leaking into the current session', async () => {
    const harness = await renderHarness({ initialSessionId: 's1' });
    await act(async () => {
      harness.getCurrent().setSessionId('s3');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      harness.getCurrent().restoreComposerSnapshot({
        sessionId: 's1',
        text: 'restored failed command',
      });
    });

    expect(sessionsById.s1?.draft).toBe('restored failed command');
    expect(harness.getCurrent().value).toBe('draft-3');
    harness.unmount();
  });

  it('restores a failed outbound handoff only while the active composer is still empty', async () => {
    const harness = await renderHarness({ initialSessionId: 's1' });
    expect(harness.getCurrent().value).toBe('draft-1');

    await act(async () => {
      harness.getCurrent().clearDraftForSessionIfCurrentValueMatches({
        sessionId: 's1',
        text: 'draft-1',
      });
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().value).toBe('');
    expect(typeof harness.getCurrent().restoreDraftForSessionIfCurrentValueMatches).toBe('function');

    let restored = false;
    await act(async () => {
      restored = harness.getCurrent().restoreDraftForSessionIfCurrentValueMatches?.({
        sessionId: 's1',
        text: 'draft-1',
      }, '') ?? false;
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(restored).toBe(true);
    expect(harness.getCurrent().value).toBe('draft-1');
    expect(sessionsById.s1?.draft).toBe('draft-1');

    await act(async () => {
      harness.getCurrent().setValue('new draft');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      restored = harness.getCurrent().restoreDraftForSessionIfCurrentValueMatches?.({
        sessionId: 's1',
        text: 'draft-1',
      }, '') ?? false;
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(restored).toBe(false);
    expect(harness.getCurrent().value).toBe('new draft');
    expect(sessionsById.s1?.draft).toBe('new draft');
    harness.unmount();
  });

  it('flushes non-empty web edits when the document is hidden', async () => {
    const fakeVisibilityDocument = installFakeVisibilityDocument();
    const harness = await renderHarness({ initialSessionId: 's1' });

    try {
      expect(harness.getCurrent().value).toBe('draft-1');
      writeExistingSessionDraftSpy.mockClear();
      flushSessionDraftSpy.mockClear();

      await act(async () => {
        harness.getCurrent().setValue('draft-1 edited before background');
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      expect(sessionsById.s1?.draft).toBe('draft-1 edited before background');
      expect(flushSessionDraftSpy).not.toHaveBeenCalled();

      fakeVisibilityDocument.setVisibilityState('hidden');
      await act(async () => {
        fakeVisibilityDocument.dispatch('visibilitychange');
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      expect(sessionsById.s1?.draft).toBe('draft-1 edited before background');
      expect(writeExistingSessionDraftSpy).toHaveBeenCalledWith('s1', 'draft-1 edited before background');
      expect(flushSessionDraftSpy).toHaveBeenCalled();
    } finally {
      harness.unmount();
      fakeVisibilityDocument.restore();
    }
  });

  it('flushes non-empty web edits when the browser window blurs while the document stays visible', async () => {
    vi.useFakeTimers();
    const fakeVisibilityDocument = installFakeVisibilityDocument();
    const fakeWindowLifecycle = installFakeWindowLifecycleEvents();
    const harness = await renderHarness({ initialSessionId: 's1' });

    try {
      expect(harness.getCurrent().value).toBe('draft-1');
      writeExistingSessionDraftSpy.mockClear();
      flushSessionDraftSpy.mockClear();

      await act(async () => {
        harness.getCurrent().setValue('draft-1 edited before window blur');
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      expect(writeExistingSessionDraftSpy).toHaveBeenCalledWith('s1', 'draft-1 edited before window blur');
      expect(sessionsById.s1?.draft).toBe('draft-1 edited before window blur');
      expect(flushSessionDraftSpy).not.toHaveBeenCalled();

      fakeVisibilityDocument.setVisibilityState('visible');
      await act(async () => {
        fakeWindowLifecycle.dispatch('blur');
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      expect(sessionsById.s1?.draft).toBe('draft-1 edited before window blur');
      expect(writeExistingSessionDraftSpy).toHaveBeenCalledWith('s1', 'draft-1 edited before window blur');
      expect(flushSessionDraftSpy).toHaveBeenCalled();
    } finally {
      harness.unmount();
      fakeWindowLifecycle.restore();
      fakeVisibilityDocument.restore();
      vi.useRealTimers();
    }
  });

  it('does not re-adopt a stale saved draft while the user clears the composer', async () => {
    sessionsById = {
      s1: { draft: null, metadata: {} },
    };

    const harness = await renderHarness({ initialSessionId: 's1' });
    expect(harness.getCurrent().value).toBe('');

    await act(async () => {
      harness.getCurrent().setValue('expanded prompt text');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(sessionsById.s1?.draft).toBe('expanded prompt text');

    await act(async () => {
      harness.getCurrent().setValue('');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().value).toBe('');
    expect(sessionsById.s1?.draft).toBeNull();
    harness.unmount();
  });
});
