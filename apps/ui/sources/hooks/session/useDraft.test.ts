import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDraft, type SessionDraftTextSnapshot } from './useDraft';
import { TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT } from '@/components/ui/forms/largeTextInputPolicy';
import { flushHookEffects, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let isFocused = true;
let sessionsById: Record<string, { draft: string | null; metadata?: any }>;
const updateSessionDraftSpy = vi.fn();
const patchSessionMetadataWithRetrySpy = vi.fn();
const platformState = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' | 'android' }));
const draftRepositoryHarness = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  let mutationCounter = 0;
  const mutationIds = new Map<string, string>();
  const snapshots = new Map<string, { stored: string; mutationId: string; value: unknown }>();
  return {
    scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
    flush: vi.fn(async () => ({ status: 'clean' as const })),
    getMutationId(sessionId: string) {
      return mutationIds.get(sessionId) ?? 'missing';
    },
    nextMutationId(sessionId: string) {
      const id = `mutation-${++mutationCounter}`;
      mutationIds.set(sessionId, id);
      return id;
    },
    cacheSnapshot(sessionId: string, stored: string, mutationId: string, create: () => unknown) {
      const prior = snapshots.get(sessionId);
      if (prior?.stored === stored && prior.mutationId === mutationId) return prior.value;
      const value = create();
      snapshots.set(sessionId, { stored, mutationId, value });
      return value;
    },
    notify(sessionId: string) {
      for (const listener of listeners.get(sessionId) ?? []) listener();
    },
    reset() {
      listeners.clear();
      mutationIds.clear();
      snapshots.clear();
      mutationCounter = 0;
      this.flush.mockClear();
    },
    subscribe(sessionId: string, listener: () => void) {
      const scoped = listeners.get(sessionId) ?? new Set<() => void>();
      scoped.add(listener);
      listeners.set(sessionId, scoped);
      return () => scoped.delete(listener);
    },
  };
});

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
  useActiveServerAccountScope: () => draftRepositoryHarness.scope,
});
});

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', () => ({
  subscribeSessionDraft: (_scope: unknown, address: { sessionId: string }, listener: () => void) =>
    draftRepositoryHarness.subscribe(address.sessionId, listener),
  getSessionDraftSnapshot: (_scope: unknown, address: { sessionId: string }) => {
    const stored = sessionsById[address.sessionId]?.draft;
    if (stored == null) return null;
    const mutationId = draftRepositoryHarness.getMutationId(address.sessionId);
    return draftRepositoryHarness.cacheSnapshot(address.sessionId, stored, mutationId, () => ({
      address: { kind: 'session', sessionId: address.sessionId },
      document: {
        v: 1,
        address: { kind: 'session', sessionId: address.sessionId },
        composer: {
          text: { mutationId, value: stored },
          mentions: { mutationId: 'mentions', value: [] },
          attachments: { mutationId: 'attachments', value: [] },
        },
        target: {
          kind: 'session',
          routing: {
            recipient: { mutationId: 'recipient', value: null },
            agentContinuation: { mutationId: 'continuation', value: null },
            executionRunDelivery: { mutationId: 'delivery', value: null },
          },
        },
        extensions: {},
      },
      status: 'clean',
      conflict: null,
      createdAt: 1,
      updatedAt: 1,
      materialized: stored.trim().length > 0,
      localSupplement: {},
    }));
  },
  writeExistingSessionDraft: ({ sessionId, patch }: { sessionId: string; patch: { text?: string } }) => {
    if (patch.text === undefined) return;
    const stored = patch.text.length > 0 ? patch.text : null;
    draftRepositoryHarness.nextMutationId(sessionId);
    updateSessionDraftSpy(sessionId, stored);
    sessionsById = {
      ...sessionsById,
      [sessionId]: { ...(sessionsById[sessionId] ?? { draft: null }), draft: stored },
    };
    draftRepositoryHarness.notify(sessionId);
  },
  flushSessionDraft: draftRepositoryHarness.flush,
  captureSessionDraftCurrentness: ({ address }: { address: { sessionId: string } }) => ({
    address,
    mutationIds: { 'composer.text': draftRepositoryHarness.getMutationId(address.sessionId) },
  }),
  clearSessionDraftCurrentness: async ({ address, currentness }: {
    address: { sessionId: string };
    currentness: { mutationIds: Record<string, string> };
  }) => {
    if (currentness.mutationIds['composer.text'] !== draftRepositoryHarness.getMutationId(address.sessionId)) return false;
    draftRepositoryHarness.nextMutationId(address.sessionId);
    updateSessionDraftSpy(address.sessionId, null);
    sessionsById = {
      ...sessionsById,
      [address.sessionId]: { ...(sessionsById[address.sessionId] ?? { draft: null }), draft: null },
    };
    draftRepositoryHarness.notify(address.sessionId);
    return true;
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
  clearDraftIfCurrentValueMatches?: (expectedValue: string) => boolean;
  clearDraftForSessionIfCurrentValueMatches?: (snapshot: Readonly<{ sessionId: string; text: string }>) => boolean;
  setDraftValue?: (nextValueOrUpdater: string | ((currentValue: string) => string)) => void;
  restoreDraftForSessionIfCurrentValueMatches?: (
    snapshot: Readonly<{ sessionId: string; text: string }>,
    expectedCurrentValue: string,
  ) => boolean;
  restoreDraft?: (draft: string) => void;
  restoreComposerSnapshot?: (snapshot: Readonly<{ sessionId: string; text: string }>) => void;
  captureDraftForOutboundHandoff?: () => SessionDraftTextSnapshot | null;
  clearDraftCurrentness?: (snapshot: SessionDraftTextSnapshot) => boolean;
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
    const draftApi = useDraft(sessionId, value, setValue, { autoSaveInterval: 60_000 });
    current = {
      sessionId,
      setSessionId,
      value,
      setValue,
      clearDraft: draftApi.clearDraft,
      clearDraftIfCurrentValueMatches: 'clearDraftIfCurrentValueMatches' in draftApi
        ? draftApi.clearDraftIfCurrentValueMatches
        : undefined,
      clearDraftForSessionIfCurrentValueMatches: 'clearDraftForSessionIfCurrentValueMatches' in draftApi
        ? draftApi.clearDraftForSessionIfCurrentValueMatches
        : undefined,
      setDraftValue: 'setDraftValue' in draftApi
        ? draftApi.setDraftValue
        : undefined,
      restoreDraftForSessionIfCurrentValueMatches: 'restoreDraftForSessionIfCurrentValueMatches' in draftApi
        ? draftApi.restoreDraftForSessionIfCurrentValueMatches
        : undefined,
      restoreDraft: 'restoreDraft' in draftApi
        ? draftApi.restoreDraft
        : undefined,
      restoreComposerSnapshot: 'restoreComposerSnapshot' in draftApi
        ? draftApi.restoreComposerSnapshot
        : undefined,
      captureDraftForOutboundHandoff: draftApi.captureDraftForOutboundHandoff,
      clearDraftCurrentness: draftApi.clearDraftCurrentness,
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
    platformState.os = 'web';
    sessionsById = {
      s1: { draft: 'draft-1', metadata: {} },
      s2: { draft: null, metadata: {} },
      s3: { draft: 'draft-3', metadata: {} },
    };
    updateSessionDraftSpy.mockReset();
    patchSessionMetadataWithRetrySpy.mockReset();
    draftRepositoryHarness.reset();
  });

  it('publishes a large web edit to the local canonical replica immediately while debouncing remote flush', async () => {
    vi.useFakeTimers();
    try {
      const harness = await renderHarness({ initialSessionId: 's2' });
      updateSessionDraftSpy.mockClear();
      draftRepositoryHarness.flush.mockClear();
      const largeDraft = `x${'y'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT)}`;

      await act(async () => {
        harness.getCurrent().setValue(largeDraft);
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      expect(updateSessionDraftSpy).toHaveBeenCalledWith('s2', largeDraft);
      expect(draftRepositoryHarness.flush).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(updateSessionDraftSpy).toHaveBeenCalledWith('s2', largeDraft);
      harness.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes a large native edit to the local canonical replica immediately while debouncing remote flush', async () => {
    platformState.os = 'ios';
    vi.useFakeTimers();
    try {
      const harness = await renderHarness({ initialSessionId: 's2' });
      updateSessionDraftSpy.mockClear();
      draftRepositoryHarness.flush.mockClear();
      const largeDraft = `x${'y'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT)}`;

      await act(async () => {
        harness.getCurrent().setValue(largeDraft);
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      expect(updateSessionDraftSpy).toHaveBeenCalledWith('s2', largeDraft);
      expect(draftRepositoryHarness.flush).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(updateSessionDraftSpy).toHaveBeenCalledWith('s2', largeDraft);
      harness.unmount();
    } finally {
      vi.useRealTimers();
      platformState.os = 'web';
    }
  });

  it('clears the composer value when switching to a session with no stored draft', async () => {
    const harness = await renderHarness({ initialSessionId: 's1' });
    expect(harness.getCurrent().value).toBe('draft-1');

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
    expect(updateSessionDraftSpy).toHaveBeenCalledWith('s_target', 'selected transcript messages');
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
    expect(updateSessionDraftSpy).toHaveBeenCalledWith('s_target', 'existing destination draft\n\nselected transcript messages');
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
    expect(updateSessionDraftSpy).toHaveBeenCalledWith('s_child', 'fork seed\n\nselected transcript messages');
    expect(patchSessionMetadataWithRetrySpy).toHaveBeenCalledWith('s_child', expect.any(Function));
    harness.unmount();
  });

  it('appends sessionInitialPromptV1 to the immediate canonical local edit without losing it', async () => {
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
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

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

  it('clears the text draft on acknowledgement only when the composer still matches the submitted snapshot', async () => {
    sessionsById = {
      s1: { draft: null, metadata: {} },
    };

    const harness = await renderHarness({ initialSessionId: 's1' });
    await act(async () => {
      harness.getCurrent().setValue('submitted prompt');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      const cleared = harness.getCurrent().clearDraftIfCurrentValueMatches?.('submitted prompt');
      expect(cleared).toBe(true);
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().value).toBe('');
    expect(sessionsById.s1?.draft).toBeNull();
    harness.unmount();
  });

  it('preserves a newer draft when send acknowledgement resolves after the user edits again', async () => {
    sessionsById = {
      s1: { draft: null, metadata: {} },
    };

    const harness = await renderHarness({ initialSessionId: 's1' });
    await act(async () => {
      harness.getCurrent().setValue('submitted prompt');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      harness.getCurrent().setValue('new draft while send is pending');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      const cleared = harness.getCurrent().clearDraftIfCurrentValueMatches?.('submitted prompt');
      expect(cleared).toBe(false);
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().value).toBe('new draft while send is pending');
    expect(sessionsById.s1?.draft).toBe('new draft while send is pending');
    harness.unmount();
  });

  it('flushes non-empty web edits when the document is hidden', async () => {
    const fakeVisibilityDocument = installFakeVisibilityDocument();
    const harness = await renderHarness({ initialSessionId: 's1' });

    try {
      expect(harness.getCurrent().value).toBe('draft-1');
      updateSessionDraftSpy.mockClear();
      draftRepositoryHarness.flush.mockClear();

      await act(async () => {
        harness.getCurrent().setValue('draft-1 edited before background');
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      expect(sessionsById.s1?.draft).toBe('draft-1 edited before background');
      expect(draftRepositoryHarness.flush).not.toHaveBeenCalled();

      fakeVisibilityDocument.setVisibilityState('hidden');
      await act(async () => {
        fakeVisibilityDocument.dispatch('visibilitychange');
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      expect(sessionsById.s1?.draft).toBe('draft-1 edited before background');
      expect(updateSessionDraftSpy).toHaveBeenCalledWith('s1', 'draft-1 edited before background');
    } finally {
      harness.unmount();
      fakeVisibilityDocument.restore();
    }
  });

  it('flushes debounced large web edits when the browser window blurs while the document stays visible', async () => {
    vi.useFakeTimers();
    const fakeVisibilityDocument = installFakeVisibilityDocument();
    const fakeWindowLifecycle = installFakeWindowLifecycleEvents();
    const harness = await renderHarness({ initialSessionId: 's2' });

    try {
      const largeDraft = `x${'y'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT)}`;
      updateSessionDraftSpy.mockClear();
      draftRepositoryHarness.flush.mockClear();

      await act(async () => {
        harness.getCurrent().setValue(largeDraft);
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      expect(updateSessionDraftSpy).toHaveBeenCalledWith('s2', largeDraft);
      expect(sessionsById.s2?.draft).toBe(largeDraft);
      expect(draftRepositoryHarness.flush).not.toHaveBeenCalled();

      fakeVisibilityDocument.setVisibilityState('visible');
      await act(async () => {
        fakeWindowLifecycle.dispatch('blur');
      });
      await flushHookEffects({ cycles: 1, turns: 1 });

      expect(sessionsById.s2?.draft).toBe(largeDraft);
      expect(updateSessionDraftSpy).toHaveBeenCalledWith('s2', largeDraft);
    } finally {
      harness.unmount();
      fakeWindowLifecycle.restore();
      fakeVisibilityDocument.restore();
      vi.useRealTimers();
    }
  });

  it('does not clear a synchronous draft update before the next render', async () => {
    sessionsById = {
      s1: { draft: 'draft-1', metadata: {} },
    };

    const harness = await renderHarness({ initialSessionId: 's1' });
    expect(harness.getCurrent().value).toBe('draft-1');
    expect(typeof harness.getCurrent().setDraftValue).toBe('function');

    let cleared = true;
    await act(async () => {
      const current = harness.getCurrent();
      current.setDraftValue?.('draft typed during async send');
      cleared = current.clearDraftForSessionIfCurrentValueMatches?.({
        sessionId: 's1',
        text: 'draft-1',
      }) ?? true;
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(cleared).toBe(false);
    expect(harness.getCurrent().value).toBe('draft typed during async send');
    harness.unmount();
  });

  it('restores a failed outbound handoff only when the composer still matches the cleared value', async () => {
    sessionsById = {
      s1: { draft: null, metadata: {} },
    };

    const harness = await renderHarness({ initialSessionId: 's1' });
    await act(async () => {
      harness.getCurrent().setValue('submitted prompt');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      const cleared = harness.getCurrent().clearDraftForSessionIfCurrentValueMatches?.({
        sessionId: 's1',
        text: 'submitted prompt',
      });
      expect(cleared).toBe(true);
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      const restored = harness.getCurrent().restoreDraftForSessionIfCurrentValueMatches?.({
        sessionId: 's1',
        text: 'submitted prompt',
      }, '');
      expect(restored).toBe(true);
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().value).toBe('submitted prompt');
    expect(sessionsById.s1?.draft).toBe('submitted prompt');

    await act(async () => {
      harness.getCurrent().setValue('new draft');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      const restored = harness.getCurrent().restoreDraftForSessionIfCurrentValueMatches?.({
        sessionId: 's1',
        text: 'submitted prompt',
      }, '');
      expect(restored).toBe(false);
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().value).toBe('new draft');
    expect(sessionsById.s1?.draft).toBe('new draft');
    harness.unmount();
  });

  it('does not mutate the visible composer or copy visible text when an old session acknowledgement resolves after a session switch', async () => {
    sessionsById = {
      s1: { draft: null, metadata: {} },
      s2: { draft: null, metadata: {} },
    };

    const harness = await renderHarness({ initialSessionId: 's1' });
    await act(async () => {
      harness.getCurrent().setValue('submitted in s1');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      harness.getCurrent().setSessionId('s2');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      harness.getCurrent().setValue('visible s2 draft');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      const cleared = harness.getCurrent().clearDraftForSessionIfCurrentValueMatches?.({
        sessionId: 's1',
        text: 'submitted in s1',
      });
      expect(cleared).toBe(true);
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().sessionId).toBe('s2');
    expect(harness.getCurrent().value).toBe('visible s2 draft');
    expect(sessionsById.s1?.draft).toBeNull();
    expect(sessionsById.s2?.draft).toBe('visible s2 draft');
    expect(updateSessionDraftSpy).not.toHaveBeenCalledWith('s1', 'visible s2 draft');
    harness.unmount();
  });

  it('restores text and persisted draft state after a failed clear-like command', async () => {
    sessionsById = {
      s1: { draft: null, metadata: {} },
    };

    const harness = await renderHarness({ initialSessionId: 's1' });
    await act(async () => {
      harness.getCurrent().setValue('/h.review Review this');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      harness.getCurrent().clearDraft();
      harness.getCurrent().setValue('');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });
    expect(sessionsById.s1?.draft).toBeNull();

    await act(async () => {
      harness.getCurrent().restoreDraft?.('/h.review Review this');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().value).toBe('/h.review Review this');
    expect(sessionsById.s1?.draft).toBe('/h.review Review this');
    harness.unmount();
  });

  it('restores an old session draft without mutating the visible composer after a session switch', async () => {
    sessionsById = {
      s1: { draft: null, metadata: {} },
      s2: { draft: null, metadata: {} },
    };

    const harness = await renderHarness({ initialSessionId: 's1' });
    await act(async () => {
      harness.getCurrent().setValue('/h.review Review this');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      harness.getCurrent().clearDraft();
      harness.getCurrent().setValue('');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });
    expect(sessionsById.s1?.draft).toBeNull();

    await act(async () => {
      harness.getCurrent().setSessionId('s2');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      harness.getCurrent().setValue('visible s2 draft');
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      harness.getCurrent().restoreComposerSnapshot?.({
        sessionId: 's1',
        text: '/h.review Review this',
      });
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().sessionId).toBe('s2');
    expect(harness.getCurrent().value).toBe('visible s2 draft');
    expect(sessionsById.s1?.draft).toBe('/h.review Review this');
    expect(sessionsById.s2?.draft).toBe('visible s2 draft');
    harness.unmount();
  });

  it('preserves the canonical draft when outbound handoff fails before currentness is cleared', async () => {
    sessionsById = { s1: { draft: 'submitted prompt', metadata: {} } };
    const harness = await renderHarness({ initialSessionId: 's1' });
    const snapshot = harness.getCurrent().captureDraftForOutboundHandoff?.();

    // A failed handoff never invokes the success-only currentness clear.
    expect(snapshot?.text).toBe('submitted prompt');
    expect(sessionsById.s1?.draft).toBe('submitted prompt');
    expect(harness.getCurrent().value).toBe('submitted prompt');
    harness.unmount();
  });

  it('does not clear an A to B to A edit whose mutation token is newer than the submitted snapshot', async () => {
    sessionsById = { s1: { draft: 'A', metadata: {} } };
    const harness = await renderHarness({ initialSessionId: 's1' });
    const snapshot = harness.getCurrent().captureDraftForOutboundHandoff?.();
    expect(snapshot).toBeTruthy();

    await act(async () => harness.getCurrent().setValue('B'));
    await flushHookEffects({ cycles: 1, turns: 1 });
    await act(async () => harness.getCurrent().setValue('A'));
    await flushHookEffects({ cycles: 1, turns: 1 });

    await act(async () => {
      if (snapshot) harness.getCurrent().clearDraftCurrentness?.(snapshot);
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(harness.getCurrent().value).toBe('A');
    expect(sessionsById.s1?.draft).toBe('A');
    harness.unmount();
  });
});
