import { act, useState, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import * as publicUi from '../../index.public.js';
import { HappierUiEnvironmentProvider } from '../../environment/context.js';
import { projectHappierUiEnvironment } from '../../environment/projectEnvironment.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';

function surface(children: ReactNode) {
  return (
    <HappierUiEnvironmentProvider
      environment={projectHappierUiEnvironment(createSurfaceContext())}
    >
      {children}
    </HappierUiEnvironmentProvider>
  );
}

it('presents caller-supplied requester facts and an optional accessible help link through the public API', async () => {
  expect(publicUi.HappierRequesterDisclosureContent).toBeTypeOf('function');
  const onPress = vi.fn();
  const mounted = mountThroughReactNativeWeb(surface(<publicUi.HappierRequesterDisclosureContent
    model={{ title: 'Runs on Ben’s build-01', description: 'Full sign-in. Ben can read the files. OpenAI.',
      learnMore: { label: 'How sharing works', onPress } }} />));
  try {
    expect(mounted.container.textContent).toContain('Full sign-in. Ben can read the files. OpenAI.');
    const link = mounted.container.querySelector<HTMLElement>('[role="link"]')!;
    expect(link.textContent).toBe('How sharing works');
    act(() => link.click());
    expect(onPress).toHaveBeenCalledOnce();
    await mounted.render(surface(<publicUi.HappierRequesterDisclosureContent
      model={{ title: 'Runs on Ben’s build-01', description: 'Scoped sign-in.' }} />));
    expect(mounted.container.querySelector('[role="link"]')).toBeNull();
    expect(mounted.container.textContent).toContain('Scoped sign-in.');
  } finally { mounted.unmount(); }
});

function ControlledTrigger(props: Readonly<{ disabled?: boolean; onOpen: () => void; onToggle: (enabled: boolean) => void }>) {
  const [enabled, setEnabled] = useState(true);
  return <publicUi.HappierTriggerRow testID="trigger" title="Daily digest" qualifier="Every morning"
    enabled={enabled} toggleDisabled={props.disabled} toggleLabel="Toggle Daily digest"
    onToggle={next => { props.onToggle(next); setEnabled(next); }} onPress={props.onOpen} />;
}

it('lets authors toggle a trigger independently from opening it, including disabled writes', async () => {
  const open = vi.fn();
  const toggle = vi.fn();
  const mounted = mountThroughReactNativeWeb(
    surface(
      <ControlledTrigger onToggle={toggle} onOpen={open} />,
    ),
  );
  try {
    const row = mounted.container.querySelector<HTMLElement>(
      '[data-testid="trigger"]',
    )!;
    const control = mounted.container.querySelector<HTMLElement>(
      '[data-testid="trigger-switch"]',
    )!;
    expect(row.contains(control)).toBe(false);
    expect(control.getAttribute('role')).toBe('switch');
    expect(control.getAttribute('aria-checked')).toBe('true');
    act(() => control.click());
    expect(toggle).toHaveBeenCalledWith(false);
    expect(mounted.container.querySelector('[data-testid="trigger-switch"]')?.getAttribute('aria-checked')).toBe('false');
    expect(open).not.toHaveBeenCalled();
    act(() => row.click());
    expect(open).toHaveBeenCalledOnce();
    await mounted.render(
      surface(
        <ControlledTrigger disabled onToggle={toggle} onOpen={open} />,
      ),
    );
    act(() =>
      mounted.container
        .querySelector<HTMLElement>('[data-testid="trigger-switch"]')!
        .click(),
    );
    expect(toggle).toHaveBeenCalledOnce();
    expect(mounted.container.querySelector('[data-testid="trigger-switch"]')?.getAttribute('aria-checked')).toBe('false');
  } finally {
    mounted.unmount();
  }
});

it('renders caller-qualified provenance as a named link or a non-interactive source', async () => {
  const open = vi.fn();
  const mounted = mountThroughReactNativeWeb(
    surface(
      <publicUi.HappierProvenanceChip
        label="From Daily digest · step 3"
        accessibilityLabel="Open producing step"
        testID="source"
        onPress={open}
      />,
    ),
  );
  try {
    const chip = mounted.container.querySelector<HTMLElement>(
      '[data-testid="source"]',
    )!;
    expect(chip.getAttribute('role')).toBe('link');
    expect(chip.getAttribute('aria-label')).toBe('Open producing step');
    const linkedAlignment = getComputedStyle(chip).alignSelf;
    act(() => chip.click());
    expect(open).toHaveBeenCalledOnce();
    await mounted.render(
      surface(
        <publicUi.HappierProvenanceChip
          label="From a workflow"
          testID="source"
        />,
      ),
    );
    const plain = mounted.container.querySelector<HTMLElement>(
      '[data-testid="source"]',
    )!;
    expect(plain.getAttribute('role')).not.toBe('link');
    expect(linkedAlignment).not.toBe('flex-start');
    expect(getComputedStyle(plain).alignSelf).toBe(linkedAlignment);
    act(() => plain.click());
    expect(open).toHaveBeenCalledOnce();
  } finally {
    mounted.unmount();
  }
});
