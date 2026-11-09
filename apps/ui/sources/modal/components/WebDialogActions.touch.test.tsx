import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./BaseModal', () => ({
  BaseModal: (props: any) =>
    React.createElement('BaseModal', props, props.children),
}));

installModalComponentCommonModuleMocks();

afterEach(() => {
  vi.unstubAllGlobals();
});

function flattenStyle(style: unknown): Record<string, unknown> {
  const resolved =
    typeof style === 'function'
      ? style({ pressed: false, hovered: false, focused: false })
      : style;
  return Object.assign({}, ...[resolved].flat(Infinity).filter(Boolean));
}

async function renderOnPhoneBrowser(
  element: () => Promise<React.ReactElement>,
) {
  // The primary pointer is a browser boundary: a phone browser reports touch points and no hover.
  vi.stubGlobal('navigator', { maxTouchPoints: 5 });
  return {
    screen: await renderScreen(await element()),
    // A finger's target on iOS and in a phone browser.
    floor: 44,
  };
}

describe('web alert and prompt actions under a finger', () => {
  it('keep every alert choice at its row height and reach the touch floor with the hit area', async () => {
    const { screen, floor } = await renderOnPhoneBrowser(async () => {
      const { WebAlertModal } = await import('./WebAlertModal');
      return (
        <WebAlertModal
          config={{
            id: 'c',
            type: 'confirm',
            title: 'Discard changes?',
            cancelText: 'Keep editing',
            confirmText: 'Discard',
            destructive: true,
          }}
          onClose={() => {}}
          onConfirm={() => {}}
        />
      );
    });
    expect(floor).toBe(44);
    for (const testID of ['web-modal-cancel', 'web-modal-confirm']) {
      const choice = screen.findByTestId(testID);
      // A touch target is a hit area, not a drawn size: the choice row keeps its own height.
      expect(flattenStyle(choice?.props.style).minHeight).toBeUndefined();
      expect(choice?.props.onLayout, 'the choice measures its row for the hit area').toBeTypeOf('function');
    }
  });

  it('keep prompt choices at their row height and name the prompt field by the dialog title', async () => {
    const { screen } = await renderOnPhoneBrowser(async () => {
      const { WebPromptModal } = await import('./WebPromptModal');
      return (
        <WebPromptModal
          config={{
            id: 'p',
            type: 'prompt',
            title: 'Rename branch',
            cancelText: 'Cancel',
            confirmText: 'Rename',
            defaultValue: 'main',
            inputType: 'default',
          }}
          onClose={() => {}}
          onConfirm={() => {}}
        />
      );
    });
    for (const testID of ['web-prompt-cancel', 'web-prompt-confirm']) {
      expect(
        flattenStyle(screen.findByTestId(testID)?.props.style).minHeight,
      ).toBeUndefined();
    }
    // The prompt's field is the shared page field: it is named for assistive technology.
    expect(
      screen.findByTestId('web-prompt-input')?.props.accessibilityLabel,
    ).toBe('Rename branch');
  });
});
