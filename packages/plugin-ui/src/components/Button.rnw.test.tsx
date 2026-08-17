import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import type { ReactNode } from 'react';
import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { HappierPressable } from '../presentation/interaction/Pressable.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Button, IconButton } from './Button.js';
import { PluginUiProvider } from './PluginUiProvider.js';

/**
 * EU-7b, family `pressable interaction` — the §3.10.9.2 row that makes every
 * deciding journey's "run a typed action" step buildable through public API.
 *
 * RED at 2026-08-07: `@happier-dev/plugin-ui` exported no pressable at all, so
 * an author could render text and state but could not offer the user anything to
 * press. Meanwhile Happier core carried the async-pending press mechanism TWICE
 * — `IconButton.tsx` (`isPromiseLike` + `busyRef` + a mount guard) and
 * `RoundButton.tsx` (its own `setLoading` around `action`) — which is the
 * duplicate this family's shared owner removes.
 *
 * The assertions below are written against a real React-Native-Web mount, not a
 * serialized tree: the defect class this family guards against (an element with
 * no role, no accessible name, or a press that keeps firing while busy) is
 * invisible in a `react-test-renderer` snapshot.
 *
 * Supporting evidence only (§7 excludes jsdom from layer 6); the packed browser
 * and device lanes own the gate.
 */
function mountSurface(children: ReactNode, context?: SurfaceContext) {
  const resolved = context ?? createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(resolved)} context={resolved}>
      {children}
    </PluginUiProvider>,
  );
}

function findButton(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('[role="button"]');
  expect(element, 'no element with an accessible button role was rendered').not.toBeNull();
  return element!;
}

function resolveRenderedBorderColor(value: string): string {
  const probe = document.createElement('div');
  probe.style.borderTopColor = value;
  document.body.appendChild(probe);
  const rendered = getComputedStyle(probe).borderTopColor;
  probe.remove();
  return rendered;
}

async function activateWithEnter(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
    button.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
    // A real browser turns the native button's Enter cycle into this click;
    // jsdom does not synthesize that default action for raw keyboard events.
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('plugin-ui Button renders real React Native pressable semantics', () => {
  it('renders a real accessible button carrying its label, never a marker element', () => {
    const mount = mountSurface(<Button title="Refresh findings" onPress={() => {}} testID="plugin-button" />);

    expect(mount.container.innerHTML).not.toContain('happier-plugin-');
    const button = findButton(mount.container);
    expect(button.getAttribute('aria-label') ?? button.textContent).toContain('Refresh findings');
    expect(button.className).toContain('css-view');

    mount.unmount();
  });

  it('rejects untyped input that would render a focusable icon-only button without an accessible name', () => {
    const unsafeUntypedProps = {
      icon: <span aria-hidden="true">↻</span>,
      onPress: () => undefined,
    } as unknown as Parameters<typeof Button>[0];

    expect(() => mountSurface(<Button {...unsafeUntypedProps} />)).toThrow(
      /Button requires a non-empty accessible name/u,
    );
  });

  it('rejects an untyped icon-button whose accessible name is whitespace only', () => {
    const unsafeUntypedProps = {
      accessibilityLabel: ' \t ',
      icon: <span aria-hidden="true">↻</span>,
      onPress: () => undefined,
    } as unknown as Parameters<typeof IconButton>[0];

    expect(() => {
      const mount = mountSurface(<IconButton {...unsafeUntypedProps} />);
      mount.unmount();
    }).toThrow(/requires a non-empty accessible name/u);
  });

  it('resolves a declared translation key and falls back to author text for an undeclared one', () => {
    const context = createSurfaceContext({ translations: { 'acme.refresh': 'Rafraîchir' } });
    const mount = mountSurface(
      <>
        <Button titleKey="acme.refresh" title="Refresh" onPress={() => {}} testID="translated" />
        <Button titleKey="acme.absent" title="Retry" onPress={() => {}} testID="fallback" />
      </>,
      context,
    );

    expect(mount.container.textContent).toContain('Rafraîchir');
    expect(mount.container.textContent).toContain('Retry');
    expect(mount.container.textContent).not.toContain('acme.absent');

    mount.unmount();
  });

  it('uses the centrally projected high-contrast focus token', async () => {
    const context = createSurfaceContext({ contrast: 'high' });
    const mount = mountSurface(<Button title="Refresh findings" onPress={() => {}} />, context);
    const button = findButton(mount.container) as HTMLButtonElement;

    await act(async () => { button.focus(); });

    expect(getComputedStyle(button).borderTopColor).toBe(
      resolveRenderedBorderColor(context.theme.colors.text),
    );
    mount.unmount();
  });

  it('shows a pending indicator while an async press is unresolved and swallows further presses', async () => {
    let settle: () => void = () => {};
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const onPress = vi.fn(() => pending);
    const mount = mountSurface(<Button title="Run review" onPress={onPress} testID="run" />);

    const button = findButton(mount.container);
    expect(mount.container.querySelector('[role="progressbar"]')).toBeNull();

    await act(async () => {
      button.click();
    });

    expect(mount.container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(button.getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      button.click();
      button.click();
    });
    expect(onPress).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
      await pending;
    });

    expect(mount.container.querySelector('[role="progressbar"]')).toBeNull();
    expect(button.getAttribute('aria-busy')).not.toBe('true');

    mount.unmount();
  });

  it('does not steal focus moved to a sibling after an Enter-activated pending press settles', async () => {
    let settle: () => void = () => {};
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const mount = mountSurface(
      <>
        <Button title="Refresh findings" onPress={() => pending} testID="refresh" />
        <button type="button">Sibling control</button>
      </>,
    );
    const button = findButton(mount.container) as HTMLButtonElement;
    const sibling = mount.container.querySelector<HTMLButtonElement>('button:not([role="button"])');
    expect(sibling).not.toBeNull();

    await act(async () => { button.focus(); });
    await activateWithEnter(button);

    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(true);
    await act(async () => { sibling?.focus(); });
    expect(document.activeElement).toBe(sibling);

    await act(async () => {
      settle();
      await pending;
    });

    expect(document.activeElement).toBe(sibling);
    mount.unmount();
  });

  it('returns focus after an Enter-activated pending press settles with no newer focus target', async () => {
    let settle: () => void = () => {};
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const mount = mountSurface(<Button title="Refresh findings" onPress={() => pending} testID="refresh" />);
    const button = findButton(mount.container) as HTMLButtonElement;

    await act(async () => { button.focus(); });
    await activateWithEnter(button);
    await act(async () => { button.blur(); });
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      settle();
      await pending;
    });

    expect(document.activeElement).toBe(button);
    mount.unmount();
  });

  it('does not restore focus after a pointer pending press, even when the button was focused', async () => {
    let settle: () => void = () => {};
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const mount = mountSurface(<Button title="Refresh findings" onPress={() => pending} testID="refresh" />);
    const button = findButton(mount.container) as HTMLButtonElement;

    await act(async () => { button.focus(); });
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    });
    await act(async () => { button.blur(); });
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      settle();
      await pending;
    });

    expect(document.activeElement).toBe(document.body);
    mount.unmount();
  });

  it('does not steal sibling focus when an Enter-activated pending press rejects', async () => {
    let reject: (error: Error) => void = () => {};
    const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const mount = mountSurface(
      <>
        <Button title="Refresh findings" onPress={() => pending} testID="refresh" />
        <button type="button">Sibling control</button>
      </>,
    );
    const button = findButton(mount.container) as HTMLButtonElement;
    const sibling = mount.container.querySelector<HTMLButtonElement>('button:not([role="button"])');
    expect(sibling).not.toBeNull();

    await act(async () => { button.focus(); });
    await activateWithEnter(button);
    await act(async () => { sibling?.focus(); });
    await act(async () => {
      reject(new Error('request failed'));
      await pending.catch(() => undefined);
    });

    expect(document.activeElement).toBe(sibling);
    mount.unmount();
  });

  it('waits for caller-owned busy state to settle before restoring Enter focus', async () => {
    let settleInternal: () => void = () => {};
    let settleCallerBusy: () => void = () => {};
    const internal = new Promise<void>((resolve) => { settleInternal = resolve; });

    function CallerOwnedBusyButton() {
      const [busy, setBusy] = useState(false);
      settleCallerBusy = () => setBusy(false);
      return (
        <Button
          title="Refresh findings"
          busy={busy}
          onPress={() => {
            setBusy(true);
            return internal;
          }}
          testID="refresh"
        />
      );
    }

    const mount = mountSurface(<CallerOwnedBusyButton />);
    const button = findButton(mount.container) as HTMLButtonElement;

    await act(async () => { button.focus(); });
    await activateWithEnter(button);
    await act(async () => { button.blur(); });
    await act(async () => {
      settleInternal();
      await internal;
    });
    expect(document.activeElement).toBe(document.body);

    await act(async () => { settleCallerBusy(); });

    expect(document.activeElement).toBe(button);
    mount.unmount();
  });

  it('keeps a returned promise pending when a caller explicitly declares busy false', async () => {
    let settle: () => void = () => {};
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const mount = mountSurface(
      <Button title="Run review" busy={false} onPress={() => pending} testID="run" />,
    );
    const button = findButton(mount.container);

    await act(async () => { button.click(); });
    expect(button.getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      settle();
      await pending;
    });
    expect(button.getAttribute('aria-busy')).not.toBe('true');
    mount.unmount();
  });

  it('clears the pending state when the async press rejects, without fabricating a status', async () => {
    let fail: (error: Error) => void = () => {};
    const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
    const onPress = vi.fn(() => pending);
    const mount = mountSurface(<Button title="Run review" onPress={onPress} testID="run" />);

    const button = findButton(mount.container);
    await act(async () => {
      button.click();
    });
    expect(button.getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      fail(new Error('the daemon refused'));
      await pending.catch(() => undefined);
    });

    expect(button.getAttribute('aria-busy')).not.toBe('true');
    // Pressing again is possible: a failed action is not a terminal state.
    await act(async () => {
      button.click();
    });
    expect(onPress).toHaveBeenCalledTimes(2);

    mount.unmount();
  });

  it('blocks a disabled press and announces the disabled state', async () => {
    const onPress = vi.fn();
    const mount = mountSurface(<Button title="Run review" disabled onPress={onPress} testID="run" />);

    const button = findButton(mount.container);
    expect(button.getAttribute('aria-disabled')).toBe('true');

    await act(async () => {
      button.click();
    });
    expect(onPress).not.toHaveBeenCalled();

    mount.unmount();
  });

  it('activates a Button exactly once for one complete Enter keydown and keyup', async () => {
    const onPress = vi.fn();
    const mount = mountSurface(<Button title="Run review" onPress={onPress} testID="run" />);
    const button = findButton(mount.container);
    expect(button.tagName).toBe('BUTTON');

    await act(async () => {
      button.focus();
      button.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }));
      button.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }));
      // A browser turns the native button's Enter cycle into this click; jsdom
      // deliberately does not synthesize that default action for raw events.
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(onPress).toHaveBeenCalledOnce();
    mount.unmount();
  });

  it('leaves an Enter consumed by a shared keyboard owner out of the paired native button click', async () => {
    const onPress = vi.fn();
    const onConsumeEnter = vi.fn();
    const mount = mountSurface(
      <HappierPressable
        accessibilityLabel="Keyboard-owned action"
        onPress={onPress}
        onKeyDown={(key) => {
          if (key !== 'Enter') return false;
          onConsumeEnter();
          return true;
        }}
      />,
    );
    const button = findButton(mount.container);
    expect(button.tagName).toBe('BUTTON');

    await act(async () => {
      button.focus();
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      button.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(onConsumeEnter).toHaveBeenCalledOnce();
    expect(onPress).not.toHaveBeenCalled();
    mount.unmount();
  });

  it('does not let a consumed native Enter block a later pointer press', async () => {
    const onPress = vi.fn();
    const onConsumeEnter = vi.fn();
    const mount = mountSurface(
      <HappierPressable
        accessibilityLabel="Keyboard-owned action"
        onPress={onPress}
        onKeyDown={(key) => {
          if (key !== 'Enter') return false;
          onConsumeEnter();
          return true;
        }}
      />,
    );
    const button = findButton(mount.container);

    await act(async () => {
      button.focus();
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      button.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    });

    expect(onConsumeEnter).toHaveBeenCalledOnce();
    expect(onPress).toHaveBeenCalledOnce();
    mount.unmount();
  });

  it('keeps a declared selection in the shared pressable style state', () => {
    let observedSelection: boolean | undefined;
    const mount = mountSurface(
      <HappierPressable
        selected
        onPress={() => {}}
        style={(state) => {
          observedSelection = state.selected;
          return undefined;
        }}
      />,
    );

    expect(observedSelection).toBe(true);
    mount.unmount();
  });
});
