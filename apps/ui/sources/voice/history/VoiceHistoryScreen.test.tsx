import { waitForTestEvent } from '@/dev/testkit';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

import {
  createDeferred,
  createSessionFixture,
  renderScreen as renderHistoryScreen,
  standardCleanup,
} from '@/dev/testkit';
import type { Message } from "@happier-dev/session-core/messages";
import { buildRealtimeConversationTurnMeta } from '@/voice/transcript/VoiceTranscriptProjector';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { resolveVoiceHistoryProviderLabel } from './defaultVoiceHistoryConsumer';
import { tLoose } from '@/text';

import {
  createVoiceHistoryConsumer,
  VoiceHistoryOperationSupersededError,
  type VoiceHistoryConsumerDeps,
  type VoiceHistoryProviderSource,
} from './voiceHistoryConsumer';
import {
  clearMountedSessionRealtimeTranscriptConsumers,
  readMountedSessionRealtimeTranscriptConsumerSessionIds,
  readMountedSessionTranscriptConsumerSessionIdsForRetention,
} from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { planSessionTranscriptEviction } from '@/sync/engine/sessions/sessionTranscriptRetention';

const { legendListMock } = await vi.hoisted(async () => {
  const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
  return {
    legendListMock: createCapturingLegendListMock({ renderItems: true }),
  };
});

// Exercise the web dialog at the React Native SDK boundary; Happier's modal
// manager, provider, dialog and translation owners remain real.
vi.mock('react-native', async () => (
  await import('@/dev/testkit/mocks/reactNative')
).createReactNativeWebMock());

// Keep Happier's backend selection and prop normalization real; only the
// third-party list renderer is replaced at the native library boundary.
vi.mock('@legendapp/list/react-native', async (importOriginal) => ({
  ...await importOriginal<typeof import('@legendapp/list/react-native')>(),
  ...legendListMock.module,
}));
vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});
// The History page is a settings page: its header reads the current route.
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await vi.importActual<typeof import('@/dev/testkit/mocks/router')>(
    '@/dev/testkit/mocks/router',
  );
  return createExpoRouterMock({ pathname: '/settings/voice-history' }).module;
});

const OPENAI_SOURCE = Object.freeze({
  pluginId: 'happier.voice.openai',
  contributionId: 'realtime-openai',
});
const XAI_SOURCE = Object.freeze({
  pluginId: 'happier.voice.xai',
  contributionId: 'realtime-grok',
});
const providerRegistry = createDefaultVoiceProviderRegistry();
const readProviderLabel = (source: VoiceHistoryProviderSource | null) =>
  resolveVoiceHistoryProviderLabel(providerRegistry, source, tLoose) ?? source?.contributionId ?? 'Voice provider';

async function renderScreen(...args: Parameters<typeof renderHistoryScreen>) {
  const { ModalProvider } = await import('@/modal');
  return await renderHistoryScreen(args[0], {
    ...args[1],
    wrapper: ({ children }) => <ModalProvider>{children}</ModalProvider>,
  });
}

async function answerClearDialog(screen: Awaited<ReturnType<typeof renderScreen>>, confirm = true) {
  const { WebAlertModal } = await import('@/modal/components/WebAlertModal');
  await act(async () => {
    screen.pressByTestId('voice-history-clear');
    await Promise.resolve();
  });
  expect(screen.findByType(WebAlertModal).props.config)
    .toMatchObject({ type: 'confirm', destructive: true });
  expect(screen.findHostByTestId('web-modal-confirm')).not.toBeNull();
  await screen.pressByTestIdAsync(confirm ? 'web-modal-confirm' : 'web-modal-cancel');
  await flushAsyncState();
  await waitForTestEvent(screen.subscribe, () => expect(screen.findAllByType(WebAlertModal)).toHaveLength(0));
}

function voiceMessage(input: Readonly<{
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  source: VoiceHistoryProviderSource;
}>): Message {
  const common = {
    id: input.id,
    localId: null,
    createdAt: input.createdAt,
    text: input.text,
    meta: buildRealtimeConversationTurnMeta(input.source),
  };
  return input.role === 'user'
    ? { ...common, kind: 'user-text' }
    : { ...common, kind: 'agent-text' };
}

function createDeps(
  messages: Message[],
  overrides: Partial<VoiceHistoryConsumerDeps> = {},
): VoiceHistoryConsumerDeps {
  return {
    readScopeKey: () => 'server-a/account-a',
    captureScope: vi.fn(async () => ({ key: 'server-a/account-a' })),
    discoverHistorySession: vi.fn(async () => 'voice-history-session'),
    refreshSessionMessages: vi.fn(async () => undefined),
    loadOlderMessages: vi.fn(async () => ({
      loaded: 0,
      hasMore: false,
      status: 'no_more' as const,
    })),
    readMessages: () => messages,
    readMessagesRevision: () => 0,
    subscribeHistorySources: () => () => {},
    resolveProviderLabel: readProviderLabel,
    deleteSession: vi.fn(async () => ({ success: true })),
    retireLocalSession: vi.fn(),
    runCarrierOperation: async (operation) => await operation(),
    now: () => new Date('2026-07-29T12:34:56.000Z'),
    ...overrides,
  };
}

async function flushAsyncState(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('VoiceHistoryScreen', () => {
  let dom: JSDOM;
  let account: Awaited<ReturnType<typeof import('@/voice/settings/panels/voiceSettingsAccountTestHarness').createVoiceSettingsAccountTestHarness>>;
  beforeEach(async () => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://history.test' });
    for (const key of ['window', 'document', 'HTMLElement', 'Node', 'CustomEvent', 'MutationObserver'] as const) {
      vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
    }
    const { requireReactDOM } = await import('@/utils/web/reactDomCjs');
    const reactDom: typeof import('react-dom') = requireReactDOM();
    // React Test Renderer cannot paint a React DOM portal. Only that third-party
    // renderer boundary is adapted; the actual dialog and Radix SDK remain live.
    vi.spyOn(reactDom, 'createPortal').mockImplementation(children =>
      React.createElement(React.Fragment, null, children) as unknown as React.ReactPortal);
    clearMountedSessionRealtimeTranscriptConsumers();
    legendListMock.state.reset();
    const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
  });
  afterEach(() => {
    standardCleanup();
    account?.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    dom?.window.close();
  });

  it('honors the History clear Action policy after the person confirms the destructive dialog', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    account.replaceSettings(settingsParse({ actionsSettingsV1: { v: 1,
      actions: { 'ui.voice_global.history.clear': { disabledSurfaces: ['ui'] } } } }));
      const deleteSession = vi.fn(async () => ({ success: true as const }));
      const consumer = createVoiceHistoryConsumer(createDeps([], { deleteSession }));
      const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
      const screen = await renderScreen(<VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />);
      await waitForTestEvent(screen.subscribe, () => expect(screen.findByTestId('voice-history-clear')).not.toBeNull());
      await answerClearDialog(screen);
      expect(deleteSession).not.toHaveBeenCalled();
      expect(consumer.read().sessionId).toBe('voice-history-session');
  });

  it('routes and retains the discovered carrier only while History is mounted', async () => {
    const consumer = createVoiceHistoryConsumer(createDeps([]));
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const screen = await renderScreen(
      <VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />,
    );

    await flushAsyncState();
    expect(readMountedSessionRealtimeTranscriptConsumerSessionIds())
      .toEqual(['voice-history-session']);
    expect(readMountedSessionTranscriptConsumerSessionIdsForRetention())
      .toEqual(['voice-history-session']);
    const plan = () => planSessionTranscriptEviction({
      hydratedSessionIds: ['ordinary-session', 'voice-history-session'],
      protectedSessionIds: new Set(readMountedSessionTranscriptConsumerSessionIdsForRetention()),
      lastViewedAtBySessionId: {},
      idleSinceAtBySessionId: new Map([
        ['ordinary-session', 0],
        ['voice-history-session', 0],
      ]),
      nowMs: 1,
      recentKeepCount: 0,
      graceMs: 0,
    });
    expect(plan().evictSessionIds).toEqual(['ordinary-session']);

    await screen.unmount();
    expect(readMountedSessionRealtimeTranscriptConsumerSessionIds()).toEqual([]);
    expect(readMountedSessionTranscriptConsumerSessionIdsForRetention()).toEqual([]);
    expect(plan().evictSessionIds).toEqual(['ordinary-session', 'voice-history-session']);
  });

  it('keeps transcript controls available for multiple ordinary Voice conversations', async () => {
    const consumer = createVoiceHistoryConsumer(createDeps([
      voiceMessage({ id: 'question', role: 'user', text: 'My conversation', createdAt: 1, source: OPENAI_SOURCE }),
    ], { discoverHistorySession: async () => ['first-conversation', 'second-conversation'] }));
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const screen = await renderScreen(<VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />);
    await waitForTestEvent(screen.subscribe, () => expect(screen.findByTestId('voice-history-search')).not.toBeNull());
    expect(screen.findByTestId('voice-history-export')).not.toBeNull();
    expect(readMountedSessionRealtimeTranscriptConsumerSessionIds()).toEqual(['first-conversation', 'second-conversation']);
  });

  it('does not apply a search that the shared Action policy refuses', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const consumer = createVoiceHistoryConsumer(createDeps([
      voiceMessage({ id: 'kept', role: 'user', text: 'Release planned', createdAt: 1, source: OPENAI_SOURCE }),
      voiceMessage({ id: 'other', role: 'assistant', text: 'Another topic', createdAt: 2, source: OPENAI_SOURCE }),
    ]));
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const screen = await renderScreen(<VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />);
    await waitForTestEvent(screen.subscribe, () => expect(screen.findByTestId('voice-history-row-other')).not.toBeNull());
    account.replaceSettings(settingsParse({ ...account.settings, actionsSettingsV1: { v: 1,
      actions: { 'ui.voice_global.history.search': { disabledSurfaces: ['ui'] } } } }));
    await act(async () => { screen.findByTestId('voice-history-search')!.props.onChangeText('Release'); });
    await waitForTestEvent(screen.subscribe, () => expect(screen.findByTestId('voice-history-action-message')).not.toBeNull());
    expect(screen.findByTestId('voice-history-row-other')).not.toBeNull();
    expect(screen.findByTestId('voice-history-row-kept')).not.toBeNull();
  });

  it('loads canonical rows in chronology, searches loaded text, and pages older history', async () => {
    const discovery = createDeferred<string | null>();
    const messages: Message[] = [
      voiceMessage({
        id: 'newer',
        role: 'assistant',
        text: 'A newer response',
        createdAt: 300,
        source: XAI_SOURCE,
      }),
      voiceMessage({
        id: 'middle',
        role: 'user',
        text: 'A question about releases',
        createdAt: 200,
        source: OPENAI_SOURCE,
      }),
    ];
    const loadOlderMessages = vi.fn(async () => {
      messages.push(voiceMessage({
        id: 'older',
        role: 'assistant',
        text: 'The oldest response',
        createdAt: 100,
        source: OPENAI_SOURCE,
      }));
      return { loaded: 1, hasMore: false, status: 'no_more' as const };
    });
    const resolveProviderLabel = vi.fn(readProviderLabel);
    const consumer = createVoiceHistoryConsumer(createDeps(messages, {
      discoverHistorySession: async () => await discovery.promise,
      loadOlderMessages,
      resolveProviderLabel,
    }));
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const screen = await renderScreen(
      <VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />,
    );

    expect(screen.findByTestId('voice-history-loading')).not.toBeNull();

    await act(async () => {
      discovery.resolve('voice-history-session');
      await discovery.promise;
    });

    const initialText = screen.getTextContent();
    expect(initialText.indexOf('A question about releases')).toBeLessThan(
      initialText.indexOf('A newer response'),
    );
    expect(initialText).toContain(readProviderLabel(OPENAI_SOURCE));
    expect(initialText).toContain(readProviderLabel(XAI_SOURCE));
    const newerRow = screen.findByTestId('voice-history-row-newer');
    expect(newerRow?.props.accessible).toBe(true);
    expect(newerRow?.props.accessibilityRole).toBe('text');
    expect(newerRow?.props.accessibilityLabel).toContain(readProviderLabel(XAI_SOURCE));
    expect(newerRow?.props.accessibilityLabel).toContain('A newer response');
    expect(screen.findByTestId('voice-history-search')?.props.accessibilityLabel)
      .toBe('Search voice history');
    expect(initialText).toContain('Read-only: decrypt the previous page of voice history on this device.');
    expect(initialText).toContain('Loading older messages does not change or lock voice history on any device.');

    await act(async () => {
      screen.changeTextByTestId('voice-history-search', 'newer');
    });
    expect(screen.getTextContent()).toContain('A newer response');
    expect(screen.getTextContent()).not.toContain('A question about releases');

    await act(async () => {
      screen.changeTextByTestId('voice-history-search', '');
    });
    resolveProviderLabel.mockClear();
    await screen.pressByTestIdAsync('voice-history-load-older');

    expect(loadOlderMessages).toHaveBeenCalledTimes(1);
    // The enlarged slice is projected exactly once for the three loaded rows.
    // Deriving the rendered snapshot from the consumer must not re-project on
    // each render the surrounding operation state causes.
    expect(resolveProviderLabel).toHaveBeenCalledTimes(3);
    const pagedText = screen.getTextContent();
    expect(pagedText.indexOf('The oldest response')).toBeLessThan(
      pagedText.indexOf('A question about releases'),
    );
    expect(screen.findByTestId('voice-history-load-older')).toBeNull();
  });

  it('renders a voice turn that lands while History is already open', async () => {
    const messages: Message[] = [
      voiceMessage({
        id: 'existing',
        role: 'user',
        text: 'A question already in history',
        createdAt: 100,
        source: OPENAI_SOURCE,
      }),
    ];
    let messagesRevision = 1;
    const listeners = new Set<() => void>();
    const consumer = createVoiceHistoryConsumer(createDeps(messages, {
      readMessages: () => [...messages],
      readMessagesRevision: () => messagesRevision,
      subscribeHistorySources: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    }));
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const screen = await renderScreen(
      <VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />,
    );
    await flushAsyncState();

    expect(screen.getTextContent()).toContain('A question already in history');
    expect(screen.getTextContent()).not.toContain('The live answer');
    expect(listeners.size).toBeGreaterThan(0);

    // The canonical message owner commits a new voice turn. No interaction, no
    // remount, no poll: the open screen observes it.
    await act(async () => {
      messages.push(voiceMessage({
        id: 'live',
        role: 'assistant',
        text: 'The live answer',
        createdAt: 200,
        source: OPENAI_SOURCE,
      }));
      messagesRevision += 1;
      for (const listener of [...listeners]) listener();
    });

    expect(screen.getTextContent()).toContain('The live answer');

    // A remote authoritative correction updates the existing durable row while
    // the full transcript consumer remains mounted. History must render that
    // correction without polling, remounting, or creating another projection.
    await act(async () => {
      messages[1] = voiceMessage({
        id: 'live',
        role: 'assistant',
        text: 'The corrected live answer',
        createdAt: 200,
        source: OPENAI_SOURCE,
      });
      messagesRevision += 1;
      for (const listener of [...listeners]) listener();
    });

    expect(screen.getTextContent()).toContain('The corrected live answer');
    expect(screen.getTextContent()).not.toContain('The live answer');
  });

  it('keeps the latest reachable search query when an older-page load completes', async () => {
    const page = createDeferred<{
      loaded: number;
      hasMore: boolean;
      status: 'no_more';
    }>();
    const messages: Message[] = [
      voiceMessage({
        id: 'old-query',
        role: 'assistant',
        text: 'An older release note',
        createdAt: 100,
        source: OPENAI_SOURCE,
      }),
      voiceMessage({
        id: 'latest-query',
        role: 'assistant',
        text: 'The latest deployment status',
        createdAt: 200,
        source: XAI_SOURCE,
      }),
    ];
    const consumer = createVoiceHistoryConsumer(createDeps(messages, {
      loadOlderMessages: async () => await page.promise,
    }));
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const screen = await renderScreen(
      <VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />,
    );

    await act(async () => {
      screen.changeTextByTestId('voice-history-search', 'older');
    });
    await act(async () => {
      screen.pressByTestId('voice-history-load-older');
      await Promise.resolve();
    });
    await act(async () => {
      screen.changeTextByTestId('voice-history-search', 'latest');
    });
    expect(screen.getTextContent()).toContain('The latest deployment status');
    expect(screen.getTextContent()).not.toContain('An older release note');

    await act(async () => {
      page.resolve({ loaded: 0, hasMore: false, status: 'no_more' });
      await page.promise;
      await Promise.resolve();
    });

    expect(screen.getTextContent()).toContain('The latest deployment status');
    expect(screen.getTextContent()).not.toContain('An older release note');
  });

  it('keeps the latest reachable search query when an export completes', async () => {
    const page = createDeferred<{
      loaded: number;
      hasMore: boolean;
      status: 'no_more';
    }>();
    const messages: Message[] = [
      voiceMessage({
        id: 'old-query',
        role: 'assistant',
        text: 'An older release note',
        createdAt: 100,
        source: OPENAI_SOURCE,
      }),
      voiceMessage({
        id: 'latest-query',
        role: 'assistant',
        text: 'The latest deployment status',
        createdAt: 200,
        source: XAI_SOURCE,
      }),
    ];
    const saveExportArtifact = vi.fn(async () => undefined);
    const consumer = createVoiceHistoryConsumer(createDeps(messages, {
      loadOlderMessages: async () => await page.promise,
    }));
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const screen = await renderScreen(
      <VoiceHistoryScreen consumer={consumer} saveExportArtifact={saveExportArtifact} />,
    );

    await act(async () => {
      screen.changeTextByTestId('voice-history-search', 'older');
    });
    await act(async () => {
      screen.pressByTestId('voice-history-export');
      await Promise.resolve();
    });
    await act(async () => {
      screen.changeTextByTestId('voice-history-search', 'latest');
    });
    expect(screen.getTextContent()).toContain('The latest deployment status');
    expect(screen.getTextContent()).not.toContain('An older release note');

    await act(async () => {
      page.resolve({ loaded: 0, hasMore: false, status: 'no_more' });
      await page.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveExportArtifact).toHaveBeenCalledTimes(1);
    expect(screen.getTextContent()).toContain('The latest deployment status');
    expect(screen.getTextContent()).not.toContain('An older release note');
  });

  it('keeps paging, export, and clear under one mutually exclusive screen operation', async () => {
    const page = createDeferred<{
      loaded: number;
      hasMore: boolean;
      status: 'no_more';
    }>();
    const saveExportArtifact = vi.fn(async () => undefined);
    const loadOlderMessages = vi.fn(async () => await page.promise);
    const deleteSession = vi.fn(async () => ({ success: true }));
    const consumer = createVoiceHistoryConsumer(createDeps(
      [voiceMessage({
        id: 'one',
        role: 'assistant',
        text: 'Keep every operation attributable',
        createdAt: 100,
        source: OPENAI_SOURCE,
      })],
      { loadOlderMessages, deleteSession },
    ));
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const screen = await renderScreen(
      <VoiceHistoryScreen consumer={consumer} saveExportArtifact={saveExportArtifact} />,
    );

    await act(async () => {
      screen.pressByTestId('voice-history-load-older');
      await Promise.resolve();
    });

    expect(screen.findByTestId('voice-history-load-older')?.props.disabled).toBe(true);
    expect(screen.findByTestId('voice-history-export')?.props.disabled).toBe(true);
    expect(screen.findByTestId('voice-history-clear')?.props.disabled).toBe(true);

    // The callbacks share the same immediate ref-backed owner as their visual
    // disabled state, so even a stale host press cannot supersede paging.
    await act(async () => {
      screen.pressByTestId('voice-history-export');
      screen.pressByTestId('voice-history-clear');
      await Promise.resolve();
    });
    expect(saveExportArtifact).not.toHaveBeenCalled();
    expect(screen.findHostByTestId('web-modal-confirm')).toBeNull();
    expect(deleteSession).not.toHaveBeenCalled();

    await act(async () => {
      page.resolve({ loaded: 0, hasMore: false, status: 'no_more' });
      await page.promise;
      await Promise.resolve();
    });

    expect(screen.findByTestId('voice-history-export')?.props.disabled).toBe(false);
    expect(screen.findByTestId('voice-history-clear')?.props.disabled).toBe(false);

    await act(async () => {
      screen.pressByTestId('voice-history-clear');
      await Promise.resolve();
    });

    expect(screen.findByTestId('voice-history-export')?.props.disabled).toBe(true);
    expect(screen.findByTestId('voice-history-clear')?.props.disabled).toBe(true);
    expect(screen.findHostByTestId('web-modal-confirm')).not.toBeNull();
    await act(async () => {
      screen.pressByTestId('voice-history-export');
      await Promise.resolve();
    });
    expect(saveExportArtifact).not.toHaveBeenCalled();

    await screen.pressByTestIdAsync('web-modal-cancel');
    await flushAsyncState();
    expect(screen.findByTestId('voice-history-export')?.props.disabled).toBe(false);
    expect(screen.findByTestId('voice-history-clear')?.props.disabled).toBe(false);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('exports the bounded canonical artifact and clears the whole carrier only after destructive confirmation', async () => {
    const messages: Message[] = [
      voiceMessage({
        id: 'one',
        role: 'assistant',
        text: 'Export me',
        createdAt: 100,
        source: OPENAI_SOURCE,
      }),
    ];
    const deleteSession = vi.fn(async () => ({ success: true }));
    const retireLocalSession = vi.fn();
    const saveExportArtifact = vi.fn(async () => undefined);
    const consumer = createVoiceHistoryConsumer(createDeps(messages, {
      deleteSession,
      retireLocalSession,
    }));
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const screen = await renderScreen(
      <VoiceHistoryScreen consumer={consumer} saveExportArtifact={saveExportArtifact} />,
    );

    await screen.pressByTestIdAsync('voice-history-export');
    expect(saveExportArtifact).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: 'application/json',
      range: 'all',
      rowCount: 1,
    }));

    await answerClearDialog(screen, false);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(screen.findByTestId('voice-history-export')).not.toBeNull();

    await answerClearDialog(screen);
    expect(deleteSession).toHaveBeenCalledWith(
      'voice-history-session',
      { key: 'server-a/account-a' },
    );
    expect(retireLocalSession).toHaveBeenCalledWith(
      'voice-history-session',
      { key: 'server-a/account-a' },
    );
    expect(screen.findByTestId('voice-history-empty')).not.toBeNull();
    expect(screen.findByTestId('voice-history-action-message')?.props.children)
      .toBe('Voice history was cleared.');
    expect(screen.findByTestId('voice-history-operation-status')?.props.children?.props.children)
      .toBe('Voice history was cleared.');
    expect(readMountedSessionRealtimeTranscriptConsumerSessionIds()).toEqual([]);
    expect(readMountedSessionTranscriptConsumerSessionIdsForRetention()).toEqual([]);
    expect(screen.findByTestId('voice-history-export')).toBeNull();
    expect(screen.findByTestId('voice-history-clear')).toBeNull();
  });

  it('keeps the current History view when a stale clear safely does nothing', async () => {
    const messages: Message[] = [
      voiceMessage({
        id: 'one',
        role: 'assistant',
        text: 'Keep this filtered result',
        createdAt: 100,
        source: OPENAI_SOURCE,
      }),
    ];
    const actualConsumer = createVoiceHistoryConsumer(createDeps(messages));
    const consumer = {
      ...actualConsumer,
      clear: vi.fn(async () => ({ cleared: false as const })),
    };
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const screen = await renderScreen(
      <VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />,
    );
    await flushAsyncState();

    await act(async () => {
      screen.changeTextByTestId('voice-history-search', 'filtered');
    });
    await answerClearDialog(screen);

    expect(consumer.clear).toHaveBeenCalledTimes(1);
    expect(screen.findByTestId('voice-history-search')?.props.value).toBe('filtered');
    expect(screen.findByTestId('voice-history-row-one')).not.toBeNull();
    expect(screen.findByTestId('voice-history-action-message')).toBeNull();
    expect(screen.findByTestId('voice-history-operation-status')?.props.children?.props.children)
      .toBe('');
  });

  it('clears an active carrier through the same delete-wins flow', async () => {
    const messages: Message[] = [
      voiceMessage({
        id: 'one',
        role: 'assistant',
        text: 'Keep me during the active call',
        createdAt: 100,
        source: OPENAI_SOURCE,
      }),
    ];
    const deleteSession = vi.fn(async () => ({ success: true }));
    const consumer = createVoiceHistoryConsumer(createDeps(messages, {
      deleteSession,
    }));
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const screen = await renderScreen(
      <VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />,
    );

    await answerClearDialog(screen);

    expect(screen.findByTestId('voice-history-action-message')?.props.children)
      .toBe('Voice history was cleared.');
    expect(screen.findByTestId('voice-history-operation-status')?.props.children?.props.children)
      .toBe('Voice history was cleared.');
    expect(screen.getTextContent()).not.toContain('Voice history could not be cleared.');
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  it('announces loading, failure and recovery states through one persistent status region', async () => {
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const discovery = createDeferred<string | null>();
    const consumer = createVoiceHistoryConsumer(createDeps(
      [voiceMessage({
        id: 'one',
        role: 'assistant',
        text: 'Announce me',
        createdAt: 100,
        source: OPENAI_SOURCE,
      })],
      {
        discoverHistorySession: () => discovery.promise,
        loadOlderMessages: vi.fn(async () => ({
          loaded: 0,
          hasMore: true,
          status: 'retryable_error' as const,
        })),
      },
    ));
    const screen = await renderScreen(
      <VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />,
    );
    const readStatus = () => screen
      .findByTestId('voice-history-operation-status')
      ?.props.children?.props.children;

    expect(screen.findByTestId('voice-history-loading')).not.toBeNull();
    expect(readStatus()).toBe('Loading voice history…');

    discovery.resolve('voice-history-session');
    await flushAsyncState();

    // The live region outlives the transition into a silent state. A region that
    // mounts with its message already inside it is not announced at all, so it
    // has to be here, empty, BEFORE the next message exists.
    expect(screen.findByTestId('voice-history-operation-status')).not.toBeNull();
    expect(readStatus()).toBe('');

    // ...and the already-mounted region is what carries the next message, so it
    // is a real announcer and not a permanently empty placeholder.
    await screen.pressByTestIdAsync('voice-history-load-older');

    expect(readStatus()).toBe('Older voice history could not be loaded.');
    await screen.unmount();

    const errorScreen = await renderScreen(
      <VoiceHistoryScreen
        consumer={createVoiceHistoryConsumer(createDeps([], {
          captureScope: async () => {
            throw new Error('network unavailable');
          },
        }))}
        saveExportArtifact={vi.fn()}
      />,
    );
    await flushAsyncState();

    expect(errorScreen.findByTestId('voice-history-error')).not.toBeNull();
    expect(errorScreen.findByTestId('voice-history-operation-status')?.props.children?.props.children)
      .toBe(
        'Voice history is unavailable. Happier could not load the encrypted'
        + ' history for this account. Check your connection and try again.',
      );
    await errorScreen.unmount();

    const supersededScreen = await renderScreen(
      <VoiceHistoryScreen
        consumer={createVoiceHistoryConsumer(createDeps([], {
          captureScope: async () => {
            throw new VoiceHistoryOperationSupersededError();
          },
        }))}
        saveExportArtifact={vi.fn()}
      />,
    );
    await flushAsyncState();

    expect(supersededScreen.findByTestId('voice-history-superseded')).not.toBeNull();
    expect(supersededScreen.findByTestId('voice-history-operation-status')?.props.children?.props.children)
      .toBe(
        'The active account changed. This voice history request was stopped'
        + ' before it could use a different account. Reload to continue safely.',
      );
  });

  it('reports a failed older-page load instead of presenting it as a successful no-op', async () => {
    const messages: Message[] = [
      voiceMessage({
        id: 'newest',
        role: 'assistant',
        text: 'Newest answer',
        createdAt: 300,
        source: OPENAI_SOURCE,
      }),
    ];
    let attempt = 0;
    const consumer = createVoiceHistoryConsumer(createDeps(messages, {
      loadOlderMessages: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          return { loaded: 0, hasMore: true, status: 'retryable_error' as const };
        }
        messages.push(voiceMessage({
          id: 'older',
          role: 'user',
          text: 'Older question',
          createdAt: 100,
          source: OPENAI_SOURCE,
        }));
        return { loaded: 1, hasMore: false, status: 'no_more' as const };
      }),
    }));
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const screen = await renderScreen(
      <VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />,
    );

    await screen.pressByTestIdAsync('voice-history-load-older');

    expect(screen.findByTestId('voice-history-action-message')?.props.children)
      .toBe('Older voice history could not be loaded.');
    expect(screen.findByTestId('voice-history-operation-status')?.props.children?.props.children)
      .toBe('Older voice history could not be loaded.');
    expect(screen.findByTestId('voice-history-row-older')).toBeNull();

    // Rows and the older cursor survived the failure, so the retry works.
    await screen.pressByTestIdAsync('voice-history-load-older');

    expect(screen.findByTestId('voice-history-row-older')).not.toBeNull();
    expect(screen.findByTestId('voice-history-action-message')).toBeNull();
  });

  it('renders distinct empty, error, and superseded recovery states', async () => {
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const emptyConsumer = createVoiceHistoryConsumer(createDeps([], {
      discoverHistorySession: async () => null,
    }));
    const emptyScreen = await renderScreen(
      <VoiceHistoryScreen consumer={emptyConsumer} saveExportArtifact={vi.fn()} />,
    );
    await flushAsyncState();
    expect(emptyScreen.findByTestId('voice-history-empty')).not.toBeNull();
    await emptyScreen.unmount();

    const errorConsumer = createVoiceHistoryConsumer(createDeps([], {
      captureScope: async () => {
        throw new Error('network unavailable');
      },
    }));
    const errorScreen = await renderScreen(
      <VoiceHistoryScreen consumer={errorConsumer} saveExportArtifact={vi.fn()} />,
    );
    await flushAsyncState();
    expect(errorScreen.findByTestId('voice-history-error')).not.toBeNull();
    await errorScreen.unmount();

    const supersededConsumer = createVoiceHistoryConsumer(createDeps([], {
      captureScope: async () => {
        throw new VoiceHistoryOperationSupersededError();
      },
    }));
    const supersededScreen = await renderScreen(
      <VoiceHistoryScreen consumer={supersededConsumer} saveExportArtifact={vi.fn()} />,
    );
    await flushAsyncState();
    expect(supersededScreen.findByTestId('voice-history-superseded')).not.toBeNull();
  });

  describe('retained-input recovery entry', () => {
    const CARRIER_ID = 'voice-carrier-session';
    const blockedCarrier = (serverId: string, counts: { pendingCount: number; pendingBlockedCount: number }) =>
      createSessionFixture({
        id: CARRIER_ID, serverId, active: true, activeAt: Date.now(),
        ...counts,
        pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
        metadata: { ...createSessionFixture().metadata!, name: 'Voice conversation (system)',
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
      });
    const seedCarrier = async (counts = { pendingCount: 3, pendingBlockedCount: 3 }) => {
      const { storage } = await import('@/sync/domains/state/storage');
      const session = blockedCarrier(account.scope.serverId, counts);
      await act(async () => storage.setState(state => ({ sessions: { ...state.sessions, [session.id]: session } })));
      return session;
    };
    const dropCarrier = async () => {
      const { storage } = await import('@/sync/domains/state/storage');
      await act(async () => storage.setState(state => {
        const { [CARRIER_ID]: _removed, ...sessions } = state.sessions;
        return { sessions };
      }));
    };
    afterEach(dropCarrier);

    it('flags retained input above the transcript tools and opens the carrier through the mounted workspace', async () => {
      await seedCarrier();
      const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
      const open = vi.fn(async () => ({ ok: true as const }));
      const unregister = registerMountedWorkspaceAction(open as never);
      try {
        const consumer = createVoiceHistoryConsumer(createDeps([voiceMessage({
          id: 'm1', role: 'user', text: 'Check the deploy', createdAt: 1, source: OPENAI_SOURCE })]));
        const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
        const screen = await renderScreen(<VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />);
        await waitForTestEvent(screen.subscribe, () => expect(screen.findByTestId('voice-history-recovery')).not.toBeNull());
        // A search that matches nothing hides every transcript row, never the recovery entry.
        await act(async () => { screen.findByTestId('voice-history-search')!.props.onChangeText('zzz-no-match'); });
        await flushAsyncState();
        expect(screen.findByTestId('voice-history-no-results')).not.toBeNull();
        await screen.pressByTestIdAsync('voice-history-recovery');
        await flushAsyncState();
        expect(open).toHaveBeenCalledWith(expect.objectContaining({
          actionId: 'workspace.tabs.open',
          input: { href: `/session/${CARRIER_ID}?serverId=${account.scope.serverId}` },
        }));
      } finally { unregister(); }
    });

    it('stays visible on an empty History, and leaves when the block is cleared', async () => {
      const session = await seedCarrier();
      const consumer = createVoiceHistoryConsumer(createDeps([], { discoverHistorySession: async () => null }));
      const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
      const screen = await renderScreen(<VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />);
      await waitForTestEvent(screen.subscribe, () => expect(screen.findByTestId('voice-history-empty')).not.toBeNull());
      expect(screen.findByTestId('voice-history-recovery')).not.toBeNull();
      const { storage } = await import('@/sync/domains/state/storage');
      await act(async () => storage.setState(state => ({ sessions: { ...state.sessions,
        [session.id]: { ...session, pendingCount: 0, pendingBlockedCount: 0 } } })));
      expect(screen.findByTestId('voice-history-recovery')).toBeNull();
    });

    it('is absent when the carrier holds no blocked input', async () => {
      await seedCarrier({ pendingCount: 0, pendingBlockedCount: 0 });
      const consumer = createVoiceHistoryConsumer(createDeps([]));
      const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
      const screen = await renderScreen(<VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />);
      await waitForTestEvent(screen.subscribe, () => expect(screen.findByTestId('voice-history-export')).not.toBeNull());
      expect(screen.findByTestId('voice-history-recovery')).toBeNull();
    });
  });

  it('uses ordinary error recovery for a server refusal without exposing its details', async () => {
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const upgradeConsumer = createVoiceHistoryConsumer(createDeps([], {
      discoverHistorySession: async () => {
        throw Object.assign(new Error('private server response'), { code: 'client-upgrade-required' });
      },
    }));

    const screen = await renderScreen(
      <VoiceHistoryScreen consumer={upgradeConsumer} saveExportArtifact={vi.fn()} />,
    );
    await flushAsyncState();

    expect(screen.findByTestId('voice-history-error')).not.toBeNull();
    expect(screen.findByTestId('voice-history-error-action')).not.toBeNull();
  });

  it('drops the previous Account rows as soon as the server-account scope changes, before the new Account read resolves', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const readScopeKey = () => {
      const scope = storage.getState().profileScope ?? null;
      return scope ? `${scope.serverId}/${scope.accountId}` : null;
    };
    const accountBDiscovery = createDeferred<string | null>();
    const accountBDiscoveryStarted = createDeferred<void>();
    let discoveries = 0;
    const consumer = createVoiceHistoryConsumer(createDeps(
      [voiceMessage({
        id: 'account-a',
        role: 'assistant',
        text: 'Account A private answer',
        createdAt: 100,
        source: OPENAI_SOURCE,
      })],
      {
        readScopeKey,
        captureScope: vi.fn(async () => {
          const key = readScopeKey();
          return key ? { key } : null;
        }),
        discoverHistorySession: vi.fn(async () => {
          discoveries += 1;
          // Account B's read is deliberately still in flight while the
          // assertions below run: nothing may keep Account A on screen
          // while the switch is only partially applied.
          if (discoveries === 2) accountBDiscoveryStarted.resolve();
          return discoveries === 1
            ? 'voice-history-session-a'
            : await accountBDiscovery.promise;
        }),
      },
    ));
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    let accountB: typeof account | undefined;

    try {
      const screen = await renderScreen(
        <VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />,
      );
      await flushAsyncState();
      expect(screen.getTextContent()).toContain('Account A private answer');
      expect(screen.findByTestId('voice-history-row-account-a')).not.toBeNull();
      expect(readMountedSessionRealtimeTranscriptConsumerSessionIds())
        .toEqual(['voice-history-session-a']);

      // Replace the actual authenticated Account, not only its display scope.
      await act(async () => {
        const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        accountB = await createVoiceSettingsAccountTestHarness(settingsParse({}), {
          accountId: 'account-b',
        });
      });

      expect(screen.findByTestId('voice-history-row-account-a')).toBeNull();
      expect(screen.getTextContent()).not.toContain('Account A private answer');
      expect(screen.findByTestId('voice-history-loading')).not.toBeNull();
      expect(readMountedSessionRealtimeTranscriptConsumerSessionIds()).toEqual([]);
      expect(readMountedSessionTranscriptConsumerSessionIdsForRetention()).toEqual([]);
      await accountBDiscoveryStarted.promise;
      expect(discoveries).toBe(2);

      await act(async () => {
        accountBDiscovery.resolve(null);
        await accountBDiscovery.promise;
      });
      await flushAsyncState();
      expect(screen.findByTestId('voice-history-empty')).not.toBeNull();
      expect(screen.getTextContent()).not.toContain('Account A private answer');
    } finally {
      accountBDiscovery.resolve(null);
      await act(async () => {
        accountB?.dispose();
      });
    }
  });
});
