/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installModalComponentCommonModuleMocks } from './components/modalComponentTestHelpers';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
installModalComponentCommonModuleMocks({
  reactNative: async () => {
    const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
    const { createRequire } =
      getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>(
        'node:module',
      );
    return await vi.importActual(
      createRequire(import.meta.url).resolve('react-native-web'),
    );
  },
  text: async () => await vi.importActual('@/text'),
});
vi.mock('@/utils/web/radixCjs', async () => {
  const { createRadixCjsRealModule } =
    await import('@/dev/testkit/mocks/radixCjs');
  return await createRadixCjsRealModule();
});
vi.mock('react-native-keyboard-controller', async () => {
  const { View } =
    await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    );
  return { KeyboardAvoidingView: View };
});

const { ModalProvider } = await import('./ModalProvider');
const { Modal } = await import('./ModalManager');
const { motionTokens } = await import('@/components/ui/motion/motionTokens');

function pressTab() {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
}

/**
 * A picker opened from a form is a second dialog in front of the first (a Saved Secret picker over an
 * Action form, DESIGN-CAPTURE-1119). The form behind it is covered: Tab stays in the picker and the
 * form's controls leave the accessibility tree until the picker closes.
 */
it('keeps Tab in the front dialog and makes the dialog behind it inert until the front one closes', async () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Form() {
    return (
      <div>
        <button data-testid="form-close">Close</button>
        <button data-testid="form-browse">Browse</button>
      </div>
    );
  }
  function Picker() {
    return (
      <div>
        <button data-testid="picker-close">Close</button>
        <button data-testid="picker-choice">Staging token</button>
      </div>
    );
  }
  const dialogOf = (testId: string) =>
    document
      .querySelector(`[data-testid="${testId}"]`)!
      .closest('[role="dialog"]')!;
  let pickerId = '';
  try {
    await act(async () =>
      root.render(
        <ModalProvider>
          <div />
        </ModalProvider>,
      ),
    );
    await act(async () => {
      Modal.show({ component: Form });
    });
    document
      .querySelector<HTMLButtonElement>('[data-testid="form-browse"]')!
      .focus();
    await act(async () => {
      pickerId = Modal.show({ component: Picker });
    });

    const picker = dialogOf('picker-choice');
    document
      .querySelector<HTMLButtonElement>('[data-testid="picker-choice"]')!
      .focus();
    await act(async () => {
      pressTab();
    });
    expect(picker.contains(document.activeElement)).toBe(true);
    expect(dialogOf('form-close').hasAttribute('inert')).toBe(true);
    expect(picker.hasAttribute('inert')).toBe(false);

    await act(async () => {
      Modal.hide(pickerId);
    });
    await act(async () => {
      vi.advanceTimersByTime(motionTokens.overlay.modal.exitMs);
    });
    expect(dialogOf('form-close').hasAttribute('inert')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    container.remove();
  }
});
