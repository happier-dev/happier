import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  PluginUiPresentationHostProviderInternal,
  type PluginUiPresentationHost,
} from '../presentationHost/context.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import {
  Button,
  Form,
  Heading,
  IconButton,
  Row,
  Screen,
  Stack,
  Status,
  type PluginUiFocusTarget,
  usePluginUiFocusTarget,
} from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';

type FocusTargets = Readonly<{
  button: PluginUiFocusTarget;
  iconButton: PluginUiFocusTarget;
  textField: PluginUiFocusTarget;
  heading: PluginUiFocusTarget;
  status: PluginUiFocusTarget;
  screen: PluginUiFocusTarget;
  stack: PluginUiFocusTarget;
  row: PluginUiFocusTarget;
}>;

type FocusPresentationHost = PluginUiPresentationHost & Readonly<{
  focusTarget(target: unknown): boolean;
}>;

function createPresentationHost(focusTarget: FocusPresentationHost['focusTarget']): FocusPresentationHost {
  return {
    focusTarget,
    renderMarkdown: () => null,
    renderCodeBlock: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
  };
}

function FocusTargetFixture(props: Readonly<{
  onTargets(targets: FocusTargets): void;
  includeButton?: boolean;
  buttonDisabled?: boolean;
  onButtonPress?: () => unknown;
  textFieldDisabled?: boolean;
}>): React.ReactElement {
  const button = usePluginUiFocusTarget();
  const iconButton = usePluginUiFocusTarget();
  const textField = usePluginUiFocusTarget();
  const heading = usePluginUiFocusTarget();
  const status = usePluginUiFocusTarget();
  const screen = usePluginUiFocusTarget();
  const stack = usePluginUiFocusTarget();
  const row = usePluginUiFocusTarget();

  React.useEffect(() => {
    props.onTargets({ button, iconButton, textField, heading, status, screen, stack, row });
  }, [button, heading, iconButton, props, row, screen, stack, status, textField]);

  return (
    <Screen testID="focus-screen" focusTarget={screen}>
      <Stack testID="focus-stack" focusTarget={stack}>
        <Row testID="focus-row" focusTarget={row}>
          {props.includeButton === false ? null : (
            <Button
              testID="focus-button"
              title="Continue"
              focusTarget={button}
              disabled={props.buttonDisabled}
              onPress={props.onButtonPress ?? (() => undefined)}
            />
          )}
          <IconButton
            testID="focus-icon-button"
            accessibilityLabel="Continue with icon"
            icon={<span />}
            focusTarget={iconButton}
            onPress={() => undefined}
          />
          <Form.TextField
            testID="focus-text-field"
            label="Name"
            value=""
            onChange={() => undefined}
            focusTarget={textField}
            disabled={props.textFieldDisabled}
          />
          <Heading testID="focus-heading" level={2} value="Step details" focusTarget={heading} />
          <Status testID="focus-status" tone="info" label="Ready" focusTarget={status} />
        </Row>
      </Stack>
    </Screen>
  );
}

function mountFocusFixture(
  children: React.ReactNode,
  host?: FocusPresentationHost,
) {
  const context = createSurfaceContext();
  const surface = (
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {host === undefined
        ? children
        : <PluginUiPresentationHostProviderInternal host={host}>{children}</PluginUiPresentationHostProviderInternal>}
    </PluginUiProvider>
  );
  return mountThroughReactNativeWeb(surface);
}

function queryFocusable(container: HTMLElement, testID: string): HTMLElement {
  const target = container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  expect(target, `Expected ${testID} to render a physical focus target.`).not.toBeNull();
  return target!;
}

describe('plugin-ui logical focus targets', () => {
  it('delegate each existing public focusable primitive through the mounted host instead of choosing a browser or native focus owner', async () => {
    let targets: FocusTargets | undefined;
    const physicalFocus = vi.fn((target: unknown): boolean => {
      const focus = (target as Readonly<{ focus?: () => void }> | null)?.focus;
      if (typeof focus !== 'function') return false;
      focus.call(target);
      return true;
    });
    const mount = mountFocusFixture(
      <FocusTargetFixture onTargets={(next) => { targets = next; }} />,
      createPresentationHost(physicalFocus),
    );

    expect(targets).toBeDefined();
    const cases = [
      ['button', 'focus-button'],
      ['iconButton', 'focus-icon-button'],
      ['textField', 'focus-text-field'],
      ['heading', 'focus-heading'],
      ['status', 'focus-status'],
      ['screen', 'focus-screen'],
      ['stack', 'focus-stack'],
      ['row', 'focus-row'],
    ] as const;

    for (const [targetName, testID] of cases) {
      await act(async () => {
        expect(targets?.[targetName].focus()).toBe(true);
      });
      expect(document.activeElement).toBe(queryFocusable(mount.container, testID));
    }
    expect(physicalFocus).toHaveBeenCalledTimes(cases.length);
    mount.unmount();
  });

  it('fails closed without a mounted host and clears a stale logical target when its physical primitive unmounts', async () => {
    let targets: FocusTargets | undefined;
    const withoutHost = mountFocusFixture(
      <FocusTargetFixture onTargets={(next) => { targets = next; }} />,
    );

    expect(targets?.button.focus()).toBe(false);
    withoutHost.unmount();

    const physicalFocus = vi.fn(() => true);
    const host = createPresentationHost(physicalFocus);
    const mount = mountFocusFixture(
      <FocusTargetFixture onTargets={(next) => { targets = next; }} />,
      host,
    );
    const oldButtonTarget = targets?.button;
    expect(oldButtonTarget?.focus()).toBe(true);

    await mount.render(
      <PluginUiProvider hostApi={createHostApiStub(createSurfaceContext())} context={createSurfaceContext()}>
        <PluginUiPresentationHostProviderInternal host={host}>
          <FocusTargetFixture includeButton={false} onTargets={(next) => { targets = next; }} />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );

    expect(oldButtonTarget?.focus()).toBe(false);
    expect(physicalFocus).toHaveBeenCalledTimes(1);
    mount.unmount();
  });

  it('rebinds a retained logical target to the current presentation host when the host changes', async () => {
    let targets: FocusTargets | undefined;
    const oldHostFocus = vi.fn(() => true);
    const currentHostFocus = vi.fn(() => true);
    const oldHost = createPresentationHost(oldHostFocus);
    const currentHost = createPresentationHost(currentHostFocus);
    const initialContext = createSurfaceContext();
    const mount = mountFocusFixture(
      <FocusTargetFixture onTargets={(next) => { targets = next; }} />,
      oldHost,
    );

    const retainedTarget = targets?.button;
    expect(retainedTarget?.focus()).toBe(true);
    expect(oldHostFocus).toHaveBeenCalledOnce();

    await mount.render(
      <PluginUiProvider hostApi={createHostApiStub(initialContext)} context={initialContext}>
        <PluginUiPresentationHostProviderInternal host={currentHost}>
          <FocusTargetFixture onTargets={(next) => { targets = next; }} />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );

    expect(targets?.button).toBe(retainedTarget);
    expect(retainedTarget?.focus()).toBe(true);
    expect(oldHostFocus).toHaveBeenCalledOnce();
    expect(currentHostFocus).toHaveBeenCalledOnce();
    mount.unmount();
  });

  it('keeps the host and physical binding opaque to an author-held logical target', () => {
    let targets: FocusTargets | undefined;
    const mount = mountFocusFixture(
      <FocusTargetFixture onTargets={(next) => { targets = next; }} />,
      createPresentationHost(() => true),
    );

    expect(Reflect.ownKeys(targets!.button)).toEqual(['focus']);
    mount.unmount();
  });

  it('does not transfer focus to a disabled control, and reconnects the same logical target when it becomes enabled', async () => {
    let targets: FocusTargets | undefined;
    const physicalFocus = vi.fn(() => true);
    const host = createPresentationHost(physicalFocus);
    const context = createSurfaceContext();
    const mount = mountFocusFixture(
      <FocusTargetFixture
        onTargets={(next) => { targets = next; }}
        buttonDisabled
        textFieldDisabled
      />,
      host,
    );
    const disabledTargets = targets;

    expect(disabledTargets?.button.focus()).toBe(false);
    expect(disabledTargets?.textField.focus()).toBe(false);
    expect(physicalFocus).not.toHaveBeenCalled();

    await mount.render(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={host}>
          <FocusTargetFixture onTargets={(next) => { targets = next; }} />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );

    expect(disabledTargets?.button.focus()).toBe(true);
    expect(disabledTargets?.textField.focus()).toBe(true);
    expect(physicalFocus).toHaveBeenCalledTimes(2);
    mount.unmount();
  });

  it('disconnects a logical target while its button is internally pending, then reconnects it after settlement', async () => {
    let targets: FocusTargets | undefined;
    let settle: () => void = () => {};
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const physicalFocus = vi.fn(() => true);
    const mount = mountFocusFixture(
      <FocusTargetFixture
        onTargets={(next) => { targets = next; }}
        onButtonPress={() => pending}
      />,
      createPresentationHost(physicalFocus),
    );

    const button = queryFocusable(mount.container, 'focus-button');
    await act(async () => { button.click(); });

    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(targets?.button.focus()).toBe(false);
    expect(physicalFocus).not.toHaveBeenCalled();

    await act(async () => {
      settle();
      await pending;
    });

    expect(targets?.button.focus()).toBe(true);
    expect(physicalFocus).toHaveBeenCalledOnce();
    mount.unmount();
  });
});
