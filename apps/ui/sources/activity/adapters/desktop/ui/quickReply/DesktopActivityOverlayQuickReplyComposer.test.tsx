// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  flushHookEffects,
  invokeTestInstanceHandler,
  renderScreen,
} from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/components/ui/text/Text', async () => {
  const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
  return createUiTextModuleMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The route's shape: the draft is held above the composer and handed back on every change. */
async function renderComposer(onSend: (message: string) => Promise<boolean>) {
  const { DesktopActivityOverlayQuickReplyComposer } =
    await import('./DesktopActivityOverlayQuickReplyComposer');
  const drafts: string[] = [];
  function Host() {
    const [draft, setDraft] = React.useState('');
    drafts.push(draft);
    return (
      <DesktopActivityOverlayQuickReplyComposer
        visualMode="notch_integrated"
        phrases={['Continue']}
        draft={draft}
        onDraftChange={setDraft}
        onSend={onSend}
      />
    );
  }
  const screen = await renderScreen(<Host />);
  await flushHookEffects();
  const type = async (text: string) => {
    await act(async () => {
      invokeTestInstanceHandler(
        screen.findByTestId('desktop-activity-overlay-quick-reply-input'),
        'onChangeText',
        text,
      );
    });
  };
  const send = async () => {
    await act(async () => {
      screen.pressByTestId('desktop-activity-overlay-quick-reply-send');
    });
  };
  return { screen, type, send, draft: () => drafts.at(-1) };
}

describe('DesktopActivityOverlayQuickReplyComposer', () => {
  it('keeps what was typed while a reply was being sent', async () => {
    const pending = deferred<boolean>();
    const onSend = vi.fn(() => pending.promise);
    const composer = await renderComposer(onSend);

    await composer.type('Quarantine it');
    await composer.send();
    expect(onSend).toHaveBeenCalledWith('Quarantine it');

    await composer.type('And file a bug for the wait');
    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    await flushHookEffects();

    expect(composer.draft()).toBe('And file a bug for the wait');
  });

  it('clears the reply that went out', async () => {
    const composer = await renderComposer(async () => true);
    await composer.type('Quarantine it');
    await composer.send();
    await flushHookEffects();
    expect(composer.draft()).toBe('');
  });

  it('sends once while a send is in flight', async () => {
    const pending = deferred<boolean>();
    const onSend = vi.fn(() => pending.promise);
    const composer = await renderComposer(onSend);

    await composer.type('Quarantine it');
    await composer.send();
    await composer.send();
    await act(async () => {
      invokeTestInstanceHandler(
        composer.screen.findByTestId(
          'desktop-activity-overlay-quick-reply-input',
        ),
        'onSubmitEditing',
        {},
      );
    });
    expect(onSend).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
  });
});
