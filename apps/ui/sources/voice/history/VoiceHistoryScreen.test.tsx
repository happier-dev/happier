import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCapturingLegendListMock,
  createExpoVectorIconsMock,
  createModalModuleMock,
  createDeferred,
  renderScreen,
} from '@/dev/testkit';
import type { Message } from '@/sync/domains/messages/messageTypes';

import {
  createVoiceHistoryConsumer,
  VoiceHistoryOperationSupersededError,
  type VoiceHistoryConsumerDeps,
  type VoiceHistoryProviderSource,
} from './voiceHistoryConsumer';
import { AccountStoredContentClientUpgradeRequiredError } from '@/sync/api/capabilities/accountStoredContentCompatibility';

const legendListMock = createCapturingLegendListMock({ renderItems: true });
const modalMock = createModalModuleMock({ confirmResult: true });

// The canonical list testkit supplies the virtualized list boundary. Mocking
// the app abstraction keeps Vitest from parsing Legend's native distribution.
vi.mock('@/components/ui/lists/virtualized', () => ({
  VirtualizedList: legendListMock.module.LegendList,
}));
vi.mock('@expo/vector-icons', () => createExpoVectorIconsMock());
vi.mock('@/modal', () => modalMock.module);

const OPENAI_SOURCE = Object.freeze({
  pluginId: 'happier.voice.openai',
  contributionId: 'realtime-openai',
});
const XAI_SOURCE = Object.freeze({
  pluginId: 'happier.voice.xai',
  contributionId: 'realtime-grok',
});

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
    meta: {
      happier: {
        kind: 'conversation_turn.v1' as const,
        payload: { v: 1 },
        conversationTurnOriginV1: {
          v: 1 as const,
          channel: 'realtime_conversation' as const,
          modality: 'voice' as const,
          source: input.source,
        },
      },
    },
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
    resolveProviderLabel: (source) => (
      source?.pluginId === XAI_SOURCE.pluginId ? 'Grok Realtime' : 'OpenAI Realtime'
    ),
    deleteSession: vi.fn(async () => ({ success: true })),
    canDeleteSession: () => true,
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
  beforeEach(() => {
    legendListMock.state.reset();
    modalMock.spies.confirm.mockClear();
    modalMock.spies.confirm.mockResolvedValue(true);
    modalMock.spies.alert.mockClear();
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
    const baseConsumer = createVoiceHistoryConsumer(createDeps(messages, {
      discoverHistorySession: async () => await discovery.promise,
      loadOlderMessages,
    }));
    const read = vi.fn(baseConsumer.read);
    const consumer = Object.freeze({ ...baseConsumer, read });
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
    expect(initialText).toContain('OpenAI Realtime');
    expect(initialText).toContain('Grok Realtime');
    const newerRow = screen.findByTestId('voice-history-row-newer');
    expect(newerRow?.props.accessible).toBe(true);
    expect(newerRow?.props.accessibilityRole).toBe('text');
    expect(newerRow?.props.accessibilityLabel).toContain('Grok Realtime');
    expect(newerRow?.props.accessibilityLabel).toContain('A newer response');
    expect(screen.findByTestId('voice-history-search')?.props.accessibilityLabel)
      .toBe('Search Voice History');

    await act(async () => {
      screen.changeTextByTestId('voice-history-search', 'newer');
    });
    expect(screen.getTextContent()).toContain('A newer response');
    expect(screen.getTextContent()).not.toContain('A question about releases');

    await act(async () => {
      screen.changeTextByTestId('voice-history-search', '');
    });
    read.mockClear();
    await screen.pressByTestIdAsync('voice-history-load-older');

    expect(loadOlderMessages).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    const pagedText = screen.getTextContent();
    expect(pagedText.indexOf('The oldest response')).toBeLessThan(
      pagedText.indexOf('A question about releases'),
    );
    expect(screen.findByTestId('voice-history-load-older')).toBeNull();
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

    modalMock.spies.confirm.mockResolvedValueOnce(false);
    await screen.pressByTestIdAsync('voice-history-clear');
    expect(deleteSession).not.toHaveBeenCalled();
    expect(screen.findByTestId('voice-history-export')).not.toBeNull();

    modalMock.spies.confirm.mockResolvedValueOnce(true);
    await screen.pressByTestIdAsync('voice-history-clear');
    expect(modalMock.spies.confirm).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ destructive: true }),
    );
    expect(deleteSession).toHaveBeenCalledWith(
      'voice-history-session',
      { key: 'server-a/account-a' },
    );
    expect(retireLocalSession).toHaveBeenCalledWith('voice-history-session');
    expect(screen.findByTestId('voice-history-empty')).not.toBeNull();
    expect(screen.findByTestId('voice-history-action-message')?.props.children)
      .toBe('Voice History was cleared.');
    expect(screen.findByTestId('voice-history-operation-status')?.props.children?.props.children)
      .toBe('Voice History was cleared.');
    expect(screen.findByTestId('voice-history-export')).toBeNull();
    expect(screen.findByTestId('voice-history-clear')).toBeNull();
  });

  it('tells the user to end Voice before clearing when an active-call clear is refused', async () => {
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
      canDeleteSession: () => false,
    }));
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const screen = await renderScreen(
      <VoiceHistoryScreen consumer={consumer} saveExportArtifact={vi.fn()} />,
    );

    await screen.pressByTestIdAsync('voice-history-clear');

    expect(screen.findByTestId('voice-history-action-message')?.props.children)
      .toBe('End Voice before clearing Voice History.');
    expect(screen.findByTestId('voice-history-operation-status')?.props.children?.props.children)
      .toBe('End Voice before clearing Voice History.');
    expect(screen.getTextContent()).not.toContain('Voice History could not be cleared.');
    expect(deleteSession).not.toHaveBeenCalled();
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

  it('projects the non-retryable stored-content compatibility failure without exposing its error details', async () => {
    const { VoiceHistoryScreen } = await import('./VoiceHistoryScreen');
    const upgradeConsumer = createVoiceHistoryConsumer(createDeps([], {
      discoverHistorySession: async () => {
        throw new AccountStoredContentClientUpgradeRequiredError('server-too-old');
      },
    }));

    const screen = await renderScreen(
      <VoiceHistoryScreen consumer={upgradeConsumer} saveExportArtifact={vi.fn()} />,
    );
    await flushAsyncState();

    expect(screen.findByTestId('voice-history-upgrade-required')).not.toBeNull();
    expect(screen.findByTestId('voice-history-upgrade-required-retry')).toBeNull();
    expect(screen.findByTestId('voice-history-error')).toBeNull();
  });
});
