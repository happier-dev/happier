import { act, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import * as publicUi from '../../index.public.js';
import { HappierUiEnvironmentProvider } from '../../environment/context.js';
import { projectHappierUiEnvironment } from '../../environment/projectEnvironment.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';

function surface(children: ReactNode) {
  return <HappierUiEnvironmentProvider environment={projectHappierUiEnvironment(createSurfaceContext())}>{children}</HappierUiEnvironmentProvider>;
}

it('presents supplied levels and grant recovery without acquiring grant authority', async () => {
  expect(publicUi.HappierShareGrantRow).toBeTypeOf('function');
  expect(publicUi.HappierShareLevelControl).toBeTypeOf('function');
  const change = vi.fn();
  const remove = vi.fn();
  const retry = vi.fn();
  const open = vi.fn();
  const row = (busy = false) => <publicUi.HappierShareGrantRow busy={busy} levelsAccessibilityLabel="Maya, access level"
    levels={[{ id: 'use', label: 'Use', selected: true, testID: 'use', accessibilityLabel: 'Maya, Use', onPress: change },
      { id: 'manage', label: 'Manage', testID: 'manage', onPress: change }]}
    error="Home unavailable" retry={{ label: 'Retry', testID: 'retry', onPress: retry }}
    removal={{ kind: 'confirming', consequences: ['Maya loses access'],
      confirm: { label: 'Remove', testID: 'remove', onPress: remove },
      cancel: { label: 'Cancel', testID: 'cancel', onPress: open } }} />;
  const mounted = mountThroughReactNativeWeb(surface(<>
    <publicUi.HappierShareLevelControl label="Use" accessibilityLabel="Maya, access level, Use" testID="level" onPress={open} />
    {row()}
  </>));
  try {
    const level = mounted.container.querySelector<HTMLElement>('[data-testid="level"]')!;
    expect(level.getAttribute('aria-label')).toBe('Maya, access level, Use');
    expect(level.getAttribute('tabindex')).toBe('0');
    // RNW uses a native button: browsers synthesize its keyboard click; jsdom does not.
    expect(level.tagName).toBe('BUTTON');
    act(() => level.click());
    expect(open).toHaveBeenCalledOnce();
    // A level is one value among a few: a named radio group with the supplied level checked.
    const use = mounted.container.querySelector<HTMLElement>('[data-testid="use"]')!;
    const group = use.closest('[role="radiogroup"]');
    expect(group?.getAttribute('aria-label')).toBe('Maya, access level');
    expect(use.getAttribute('role')).toBe('radio');
    expect(use.getAttribute('aria-checked')).toBe('true');
    expect(mounted.container.querySelector('[data-testid="manage"]')!.getAttribute('aria-checked')).toBe('false');
    expect(use.getAttribute('aria-label')).toBe('Maya, Use');
    // Choosing the level it already has writes nothing; another level is the one change.
    act(() => use.click());
    expect(change).not.toHaveBeenCalled();
    act(() => mounted.container.querySelector<HTMLElement>('[data-testid="manage"]')!.click());
    expect(change).toHaveBeenCalledOnce();
    act(() => mounted.container.querySelector<HTMLElement>('[data-testid="retry"]')!.click());
    expect(retry).toHaveBeenCalledOnce();
    expect(mounted.container.textContent).toContain('Maya loses access');
    act(() => mounted.container.querySelector<HTMLElement>('[data-testid="remove"]')!.click());
    expect(remove).toHaveBeenCalledOnce();
    await mounted.render(surface(row(true)));
    for (const id of ['use', 'manage', 'remove', 'cancel']) {
      const control = mounted.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      expect(control.getAttribute('aria-disabled')).toBe('true');
      act(() => control.click());
    }
    expect(change).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
  } finally { mounted.unmount(); }
});

it('keeps supplied sheet content mounted across layouts and hands off only supplied actions', async () => {
  expect(publicUi.HappierShareSheet).toBeTypeOf('function');
  const copy = vi.fn();
  const done = vi.fn();
  const sheet = (phone: boolean) => <publicUi.HappierShareSheet presentation="full" phone={phone}
    handoffs={[{ label: 'Copy link', testID: 'copy', onPress: copy }]}
    done={{ label: 'Done', testID: 'done', onPress: done }}>
    <input aria-label="People" defaultValue="Maya" />
  </publicUi.HappierShareSheet>;
  const mounted = mountThroughReactNativeWeb(surface(sheet(false)));
  try {
    const input = mounted.container.querySelector('input')!;
    input.value = 'Still typing';
    await mounted.render(surface(sheet(true)));
    expect(mounted.container.querySelector('input')).toBe(input);
    expect(input.value).toBe('Still typing');
    act(() => mounted.container.querySelector<HTMLElement>('[data-testid="copy"]')!.click());
    act(() => mounted.container.querySelector<HTMLElement>('[data-testid="done"]')!.click());
    expect(copy).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledOnce();
  } finally { mounted.unmount(); }
});

it('never draws closing as the primary act: Done is quiet and only the commit is filled', () => {
  const emphases: Record<string, string> = {};
  const Button = (props: { testID?: string; label: string; emphasis: string; onPress: () => void }) => {
    emphases[props.testID ?? props.label] = props.emphasis;
    return <button data-testid={props.testID} onClick={props.onPress}>{props.label}</button>;
  };
  const sheet = (primary?: { label: string; testID: string; onPress: () => void }) => <publicUi.HappierShareSheet presentation="full"
    Button={Button} handoffs={[{ label: 'Copy link', testID: 'copy', onPress: vi.fn() }]}
    done={{ label: 'Done', testID: 'done', onPress: vi.fn() }} {...(primary ? { primary } : {})}>
    <input aria-label="People" />
  </publicUi.HappierShareSheet>;
  const closing = mountThroughReactNativeWeb(surface(sheet()));
  try {
    expect(emphases).toEqual({ copy: 'secondary', done: 'secondary' });
  } finally { closing.unmount(); }
  for (const key of Object.keys(emphases)) delete emphases[key];
  const reviewed = mountThroughReactNativeWeb(surface(sheet({ label: 'Share', testID: 'share', onPress: vi.fn() })));
  try {
    expect(emphases).toEqual({ copy: 'secondary', share: 'primary' });
  } finally { reviewed.unmount(); }
});
