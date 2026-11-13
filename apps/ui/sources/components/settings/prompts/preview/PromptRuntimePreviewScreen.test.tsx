import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const selectionModal = vi.hoisted(() => ({
  result: undefined as { sessionId: string; serverId: string } | undefined,
}));
const sessionPromptPreviewMock = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View' });
  },
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
  },
});

vi.mock('@/components/ui/lists/ItemList', () => ({
  ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: ({ children, ...props }: any) => React.createElement('ItemGroup', props, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('./openPromptRuntimePreviewSessionSelectionModal', () => ({
  openPromptRuntimePreviewSessionSelectionModal: vi.fn(async () => selectionModal.result),
}));
vi.mock('@/sync/ops/sessionPromptPreview', () => ({
  sessionPromptPreview: (params: unknown) => sessionPromptPreviewMock(params),
}));

describe('PromptRuntimePreviewScreen', () => {
  beforeEach(() => {
    selectionModal.result = undefined;
    sessionPromptPreviewMock.mockReset();
  });

  it('renders the exact runner payload after selecting a live session', async () => {
    sessionPromptPreviewMock.mockResolvedValue({
      ok: true,
      sessionId: 'session-123456789',
      text: 'Exact rendered prompt text',
      blocks: [{ id: 'coding.base', scope: 'coding', chars: 26 }],
      launchForm: 'retained',
      providerNotes: ['Provider appends a second rendering.'],
    });
    const { PromptRuntimePreviewScreen } = await import('./PromptRuntimePreviewScreen');
    const screen = await renderSettingsView(React.createElement(PromptRuntimePreviewScreen));

    expect(screen.findRowByTitle('promptLibrary.runtimePreviewSession')).toBeTruthy();
    expect(screen.findRowByTitle('promptLibrary.runtimePreviewAwaitingSession')).toBeTruthy();

    selectionModal.result = { sessionId: 'session-123456789', serverId: 'server-a' };
    await React.act(async () => {
      await screen.findRowByTitle('promptLibrary.runtimePreviewSession')?.props.onPress?.();
    });

    expect(screen.findRowByTitle('promptLibrary.runtimePreviewSession')?.props.subtitle)
      .toBe('session-123456789');
    expect(sessionPromptPreviewMock).toHaveBeenCalledWith({ sessionId: 'session-123456789', serverId: 'server-a' });
    expect(screen.findRowByTitle('promptLibrary.runtimePreviewRenderedText')?.props.subtitle)
      .toBe('Exact rendered prompt text');
    expect(screen.findRowByTitle('coding.base')?.props.subtitle)
      .toEqual({
        key: 'promptLibrary.runtimePreviewBlockDetails',
        params: { scope: 'coding', chars: '26' },
      });
    expect(screen.findRowByTitle('promptLibrary.runtimePreviewLaunchForm')?.props.subtitle)
      .toBe('promptLibrary.runtimePreviewLaunchFormRetained');
    expect(screen.findRowByTitle('Provider appends a second rendering.')).toBeTruthy();
  });

  it('shows a recoverable error when the live runner cannot render a preview', async () => {
    sessionPromptPreviewMock.mockRejectedValue(new Error('runner unavailable'));
    const { PromptRuntimePreviewScreen } = await import('./PromptRuntimePreviewScreen');
    const screen = await renderSettingsView(React.createElement(PromptRuntimePreviewScreen));
    selectionModal.result = { sessionId: 'session-1', serverId: 'server-a' };

    await React.act(async () => {
      await screen.findRowByTitle('promptLibrary.runtimePreviewSession')?.props.onPress?.();
    });

    expect(screen.findRowByTitle('promptLibrary.runtimePreviewError')).toBeTruthy();
  });

  it('offers only sessions with a live runner', async () => {
    const { selectLivePromptPreviewSessions } = await import('./PromptRuntimePreviewSessionSelectionModal');
    expect(selectLivePromptPreviewSessions([
      { id: 'live', active: true, presence: 'online' },
      { id: 'offline', active: true, presence: 1_000 },
      { id: 'inactive', active: false, presence: 'online' },
    ])).toEqual([{ id: 'live', active: true, presence: 'online' }]);
  });
});
