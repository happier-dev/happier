import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';

import { storage } from '@/sync/domains/state/storage';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import {
  KeyboardShortcutProvider,
  useKeyboardShortcutHandlers,
} from '@/keyboard/KeyboardShortcutProvider';
import type { TranscriptRowShellItem } from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';

import { TranscriptMessageCursorHost } from './TranscriptMessageCursorHost';
import {
  readTranscriptMessageCursor,
  registerTranscriptMessageCursorActions,
  useTranscriptMessageCursorFocused,
} from './transcriptMessageCursorStore';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);

const initialSettings = storage.getState().settings;
const address = { serverId: 'home', sessionId: 's1' };
const message = (
  id: string,
  kind: Message['kind'],
  extra: Record<string, unknown> = {},
) =>
  ({
    id,
    kind,
    localId: null,
    createdAt: 1,
    text: id,
    seq: Number(id.slice(1)),
    ...extra,
  }) as unknown as Message;
const messagesById: Record<string, Message> = {
  m1: message('m1', 'user-text'),
  m2: message('m2', 'agent-text'),
  m3: message('m3', 'tool-call', { tool: { id: 't3' } }),
  m4: message('m4', 'agent-text', { isThinking: true }),
  m5: message('m5', 'agent-text'),
};
const items = ['m1', 'm2', 'm3', 'm4', 'm5'].map((messageId) => ({
  kind: 'message',
  id: messageId,
  messageId,
})) as unknown as TranscriptRowShellItem[];

function key(
  init: Partial<KeyboardEvent>,
  target: EventTarget | null = null,
): KeyboardEvent {
  return {
    key: '',
    code: '',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    target,
    ...init,
  } as unknown as KeyboardEvent;
}
// The browser window is the keyboard boundary: the real provider registers its listeners on it.
function installKeyboardWindow() {
  const listeners = new Set<(event: KeyboardEvent) => void>();
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
      if (type === 'keydown') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
      if (type === 'keydown') listeners.delete(listener);
    },
    dispatchEvent: (event: KeyboardEvent) => {
      for (const listener of [...listeners]) listener(event);
      return true;
    },
  });
}
const textarea = {
  tagName: 'TEXTAREA',
  closest: () => null,
} as unknown as EventTarget;

const renders: Record<string, number> = {};
function Row(props: { messageId: string; copy: () => void }) {
  const focused = useTranscriptMessageCursorFocused(address, props.messageId);
  renders[props.messageId] = (renders[props.messageId] ?? 0) + 1;
  React.useEffect(
    () =>
      focused
        ? registerTranscriptMessageCursorActions(props.messageId, {
            list: () => [
              {
                id: 'copy',
                commandId: 'transcript.message.copy',
                title: 'Copy',
                run: props.copy,
              },
            ],
          })
        : undefined,
    [focused, props.copy, props.messageId],
  );
  return null;
}
function Composer(props: { onFocus: () => void }) {
  useKeyboardShortcutHandlers(
    React.useMemo(() => ({ 'composer.focus': props.onFocus }), [props.onFocus]),
  );
  return null;
}

describe('TranscriptMessageCursorHost', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    installKeyboardWindow();
    storage.setState({
      settings: {
        ...initialSettings,
        keyboardShortcutsV2Enabled: true,
        keyboardSingleKeyShortcutsEnabled: false,
        keyboardShortcutOverridesV1: {},
        keyboardShortcutDisabledCommandIdsV1: [],
      },
    });
    for (const id of Object.keys(renders)) delete renders[id];
  });
  afterEach(() => {
    standardCleanup();
    storage.setState({ settings: initialSettings });
    vi.unstubAllGlobals();
  });

  it('enters from the composer, moves across user and agent messages, runs the focused row action and returns', async () => {
    const jumps: string[] = [];
    const jumpToTarget = vi.fn(
      async (
        target: { routeMessageId?: string },
        options?: { landingCue?: boolean; align?: { kind: string } },
      ) => {
        jumps.push(
          `${target.routeMessageId}:${options?.align?.kind}:${options?.landingCue}`,
        );
        return { status: 'scrolled' } as never;
      },
    );
    const copy = vi.fn();
    const composerFocus = vi.fn();
    const screen = await renderScreen(
      <KeyboardShortcutProvider handlers={{}}>
        <Composer onFocus={composerFocus} />
        <TranscriptMessageCursorHost
          address={address}
          items={items}
          messagesById={messagesById}
          jumpToTarget={jumpToTarget}
        />
        {['m1', 'm2', 'm5'].map((id) => (
          <Row key={id} messageId={id} copy={copy} />
        ))}
      </KeyboardShortcutProvider>,
    );
    const dispatch = async (event: KeyboardEvent) => {
      await act(async () => {
        window.dispatchEvent(event);
      });
      return event;
    };

    // Plain arrows in the composer stay with it (prompt history); nothing holds the cursor yet.
    await dispatch(key({ key: 'ArrowUp', code: 'ArrowUp' }, textarea));
    expect(readTranscriptMessageCursor()).toBeNull();

    const enter = await dispatch(
      key({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true }, textarea),
    );
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(readTranscriptMessageCursor()?.messageId).toBe('m5');
    expect(jumps).toEqual(['m5:center:false']);

    const settled = { ...renders };
    // Up skips the tool row and the thinking block; only the row it leaves and the row it lands on render.
    await dispatch(key({ key: 'ArrowUp', code: 'ArrowUp' }));
    expect(readTranscriptMessageCursor()?.messageId).toBe('m2');
    expect(renders.m1).toBe(settled.m1);
    expect(renders.m2).toBe(settled.m2 + 1);
    expect(renders.m5).toBe(settled.m5 + 1);
    await dispatch(key({ key: 'ArrowUp', code: 'ArrowUp' }));
    await dispatch(key({ key: 'ArrowUp', code: 'ArrowUp' }));
    expect(readTranscriptMessageCursor()?.messageId).toBe('m1');
    await dispatch(key({ key: 'ArrowDown', code: 'ArrowDown' }));
    expect(readTranscriptMessageCursor()?.messageId).toBe('m2');

    // The focused message owns its letters even with single-key shortcuts off.
    await dispatch(key({ key: 'c', code: 'KeyC' }));
    expect(copy).toHaveBeenCalledTimes(1);

    await dispatch(key({ key: 'Escape', code: 'Escape' }));
    expect(readTranscriptMessageCursor()).toBeNull();
    expect(composerFocus).toHaveBeenCalledTimes(1);

    // Without a cursor the letter is not consumed: it types into the composer (type-to-focus) instead.
    const letter = await dispatch(key({ key: 'c', code: 'KeyC' }));
    expect(letter.preventDefault).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledTimes(1);
    expect(composerFocus).toHaveBeenCalledTimes(2);

    await dispatch(
      key({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true }, textarea),
    );
    await dispatch(key({ key: 'ArrowDown', code: 'ArrowDown', metaKey: true }));
    expect(readTranscriptMessageCursor()).toBeNull();
    expect(composerFocus).toHaveBeenCalledTimes(3);
    await screen.unmount();
  });

  it('releases the cursor when its transcript unmounts', async () => {
    const jumpToTarget = vi.fn(async () => ({ status: 'scrolled' }) as never);
    const screen = await renderScreen(
      <KeyboardShortcutProvider handlers={{}}>
        <TranscriptMessageCursorHost
          address={address}
          items={items}
          messagesById={messagesById}
          jumpToTarget={jumpToTarget}
        />
      </KeyboardShortcutProvider>,
    );
    await act(async () => {
      window.dispatchEvent(
        key({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true }, textarea),
      );
    });
    expect(readTranscriptMessageCursor()?.messageId).toBe('m5');
    await screen.unmount();
    expect(readTranscriptMessageCursor()).toBeNull();
  });
});
