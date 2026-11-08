// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import type { MarkdownEditModeState } from './useMarkdownEditMode';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});
// The web eligibility owner (Tiptap round trip) decides rich eligibility, as in the browser.
vi.mock(
  '@/components/ui/markdown/editor/core/eligibility/richEligibility',
  async () => import('./core/eligibility/richEligibility.web'),
);

import { useMarkdownEditMode } from './useMarkdownEditMode';

/**
 * The product default, decided by the real feature decision over default Account settings (no feature
 * mock): a Markdown document (a Doc, a prompt, a `.md` file) opens in the rich editor and offers Raw.
 */
const captured = { state: null as MarkdownEditModeState | null };

function Probe(
  props: Readonly<{
    value: string;
    editorHandleRef: React.MutableRefObject<TextEditorHandle | null>;
    onValueChange: (next: string) => void;
  }>,
) {
  captured.state = useMarkdownEditMode({
    value: props.value,
    language: 'markdown',
    baseResetKey: 'doc',
    editorHandleRef: props.editorHandleRef,
    onValueChange: props.onValueChange,
  });
  return null;
}

beforeEach(() => {
  captured.state = null;
  storage.setState((state) => ({
    settings: { ...state.settings, ...settingsDefaults },
  }));
});

describe('useMarkdownEditMode product default', () => {
  it('opens Markdown in the rich editor and offers the Raw switch with default settings', async () => {
    await renderScreen(
      <Probe
        value={'# Plan\n\nFirst draft.'}
        editorHandleRef={{ current: null }}
        onValueChange={() => {}}
      />,
    );
    expect(captured.state?.showToggle).toBe(true);
    expect(captured.state?.markdownEditMode).toBe('rich');
    expect(captured.state?.showRich).toBe(true);
  });

  it('keeps the unsaved draft across Rich → Raw → Rich', async () => {
    let surfaceText = '# Plan\n\nFirst draft, edited in rich.';
    const handle: TextEditorHandle = {
      getValue: () => surfaceText,
      flushPendingChange: async () => {},
    } as TextEditorHandle;
    const values: string[] = [];
    await renderScreen(
      <Probe
        value={'# Plan\n\nFirst draft.'}
        editorHandleRef={{ current: handle }}
        onValueChange={(next) => {
          values.push(next);
        }}
      />,
    );

    await act(async () => {
      await captured.state?.onToggle('raw');
    });
    expect(captured.state?.markdownEditMode).toBe('raw');
    expect(captured.state?.seedText).toBe(
      '# Plan\n\nFirst draft, edited in rich.',
    );

    surfaceText = '# Plan\n\nFirst draft, edited in rich, then in raw.';
    await act(async () => {
      await captured.state?.onToggle('rich');
    });
    expect(captured.state?.showRich).toBe(true);
    expect(captured.state?.seedText).toBe(
      '# Plan\n\nFirst draft, edited in rich, then in raw.',
    );
    expect(values.at(-1)).toBe(
      '# Plan\n\nFirst draft, edited in rich, then in raw.',
    );
  });
});
