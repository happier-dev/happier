import { act, useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import {
  HappierInputField,
  type HappierInputFieldDescriptor,
} from './InputField.js';
import { HappierInputPickerProvider, type HappierInputPickerPort } from './inputPicker.js';
import { PluginUiPresentationHostProviderInternal, type PluginUiPresentationHost } from '../../presentationHost/context.js';

const theme = createSurfaceContext().theme;
const metric: HappierInputFieldDescriptor = {
  path: 'metric',
  title: 'Metric',
  widget: 'select',
};
const two = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'cost', label: 'Cost' },
];
const segmentedIn = (element: ReactNode) =>
  mountThroughReactNativeWeb(element).container.querySelector(
    '[data-testid="metric.segmented"]',
  );

describe('one typed field decides how a fixed choice is drawn, for every form', () => {
  it('lets a suggested string choice be selected or replaced with a new name', async () => {
    const changes = vi.fn();
    function Profile() {
      const [value, setValue] = useState('work');
      return <HappierInputField field={{ path: 'profileId', title: 'Profile', widget: 'select', allowCustomValue: true }}
        value={value} selection={value} options={[{ value: 'work', label: 'Work' }, { value: 'personal', label: 'Personal' }]}
        onChange={next => { changes(next); setValue(String(next)); }} frame="none" theme={theme} testID="profile" />;
    }
    const view = mountThroughReactNativeWeb(<Profile />);
    try {
      const trigger = () => view.container.querySelector<HTMLElement>('[data-testid="profile.trigger"]')!;
      expect(trigger()).not.toBeNull();
      await act(async () => trigger().click());
      const personal = [...view.container.querySelectorAll<HTMLElement>('[role="radio"]')].find(row => row.textContent === 'Personal')!;
      await act(async () => personal.click());
      expect(changes).toHaveBeenLastCalledWith('personal');
      await act(async () => trigger().click());
      const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Profile"]')!;
      expect(input).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'new-profile');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(changes).toHaveBeenLastCalledWith('new-profile');
      await act(async () => trigger().click());
      expect(trigger().textContent).toContain('new-profile');
    } finally { view.unmount(); }
  });
  it('offers an empty inventory action only when there is nothing to choose', async () => {
    const connect = vi.fn();
    const props = { field: metric, value: undefined, options: [], onChange: vi.fn(),
      optionsEmptyAction: <button onClick={connect}>Connect a source</button>,
      frame: 'none' as const, theme };
    const view = mountThroughReactNativeWeb(<HappierInputField {...props} optionsStatus="ready" />);
    const button = () => [...view.container.querySelectorAll<HTMLElement>('[role="button"],button')]
      .find(item => item.textContent === 'Connect a source');
    try {
      expect(button()).toBeDefined();
      await act(async () => button()!.click());
      expect(connect).toHaveBeenCalledOnce();
      expect(props.onChange).not.toHaveBeenCalled();
      await view.render(<HappierInputField {...props} optionsStatus="ready" disabled />);
      expect(button()).toBeUndefined();
      await view.render(<HappierInputField {...props} optionsStatus="loading" />);
      expect(button()).toBeUndefined();
      await view.render(<HappierInputField {...props} optionsStatus="failed" />);
      expect(button()).toBeUndefined();
      await view.render(<HappierInputField {...props} optionsStatus="ready" options={two} />);
      expect(button()).toBeUndefined();
    } finally { view.unmount(); }
  });
  it('explains pending and empty choices and withdraws the notice when choices arrive', async () => {
    const props = { field: { path: 'session', title: 'Session', widget: 'select' as const }, value: undefined,
      options: [], onChange: () => {}, frame: 'none' as const, theme, testID: 'session' };
    const view = mountThroughReactNativeWeb(<HappierInputField {...props} optionsStatus="ready" />);
    try {
      const empty = view.container.querySelector('[aria-live="polite"]')?.textContent?.trim();
      expect(empty).toBeTruthy();
      await view.render(<HappierInputField {...props} optionsStatus="loading" />);
      const pending = view.container.querySelector('[aria-live="polite"]')?.textContent?.trim();
      expect(pending).toBeTruthy();
      expect(pending).not.toBe(empty);
      expect(view.container.querySelector('[data-testid="session.trigger"]')?.getAttribute('aria-disabled')).toBe('true');
      await view.render(<HappierInputField {...props} optionsStatus="ready" options={[{ value: 'session', label: 'Project session' }]} />);
      expect(view.container.querySelector('[aria-live="polite"]')).toBeNull();
    } finally { view.unmount(); }
  });
  it('keeps new-name entry available with empty, pending, or failed suggestions', async () => {
    const props = { field: { path: 'profileId', title: 'Profile', widget: 'select' as const, allowCustomValue: true },
      value: 'new-profile', selection: 'new-profile', options: [], onChange: vi.fn(), frame: 'none' as const,
      theme, testID: 'profile', controlTestID: 'profile-name' };
    const view = mountThroughReactNativeWeb(<HappierInputField {...props} optionsStatus="ready" />);
    try {
      await act(async () => view.container.querySelector<HTMLElement>('[data-testid="profile.trigger"]')!.click());
      for (const optionsStatus of ['ready', 'loading', 'failed'] as const) {
        await view.render(<HappierInputField {...props} optionsStatus={optionsStatus} />);
        const input = view.container.querySelector<HTMLInputElement>('[data-testid="profile-name"]')!;
        expect(input.value).toBe('new-profile');
        expect(input.disabled).toBe(false);
        expect(view.container.querySelector('[aria-live="polite"]')).toBeNull();
      }
    } finally { view.unmount(); }
  });
  it('does not offer a picker whose choices failed to load: Browse waits for Retry', async () => {
    const port: HappierInputPickerPort = {
      describe: () => ({ label: 'Browse…' }),
      pick: async () => ({ status: 'cancelled' }),
    };
    const field = { path: 'participant', title: 'Participant', widget: 'select' as const,
      inputType: { pluginId: 'com.acme.inputs', localId: 'participant' } };
    const render = (status: 'ready' | 'failed') => <HappierInputPickerProvider port={port}>
      <HappierInputField field={field} value={undefined} options={[]} optionsStatus={status}
        optionsNotice={<></>} onChange={() => {}} frame="none" theme={theme} testID="participant" />
    </HappierInputPickerProvider>;
    const trigger = (view: ReturnType<typeof mountThroughReactNativeWeb>) =>
      view.container.querySelector('[data-testid="participant-picker"]');
    const view = mountThroughReactNativeWeb(render('ready'));
    try {
      expect(trigger(view)?.textContent).toContain('Browse…');
      expect(trigger(view)?.getAttribute('aria-disabled')).not.toBe('true');
      await view.render(render('failed'));
      expect(trigger(view)?.getAttribute('aria-disabled')).toBe('true');
    } finally { view.unmount(); }
  });
  it('keeps the declared all answer and explains why its empty inventory cannot be opened', async () => {
    const view = mountThroughReactNativeWeb(
      <HappierInputField
        field={{ path: 'agents', title: 'Agents', widget: 'multiselect', placeholder: 'All agents', required: false }}
        value={[]}
        selection={[]}
        options={[]}
        optionsStatus="ready"
        onChange={() => {}}
        frame="none"
        theme={theme}
        testID="agents"
      />,
    );
    try {
      expect(view.container.textContent).toContain('All agents');
      expect(view.container.querySelector('[aria-live="polite"]')?.textContent?.trim()).toBeTruthy();
      // An empty set has nothing to open: the field reads its answer and does not offer a blank list.
      expect(view.container.querySelector('[data-testid="agents.trigger"]')?.getAttribute('aria-disabled')).toBe('true');
      await view.render(<HappierInputField
        field={{ path: 'agents', title: 'Agents', widget: 'multiselect', placeholder: 'All agents', required: false }}
        value={[]} selection={[]} options={[{ value: 'codex', label: 'Codex' }]} optionsStatus="ready"
        onChange={() => {}} frame="none" theme={theme} testID="agents" />);
      expect(view.container.querySelector('[aria-live="polite"]')).toBeNull();
      expect(view.container.querySelector('[data-testid="agents.trigger"]')?.getAttribute('aria-disabled')).not.toBe('true');
    } finally { view.unmount(); }
  });
  it('draws two to four short choices as one segmented control and pins the pressed value', () => {
    const onChange = vi.fn();
    const view = mountThroughReactNativeWeb(
      <HappierInputField
        field={metric}
        value="tokens"
        selection="tokens"
        options={two}
        onChange={onChange}
        frame="none"
        theme={theme}
        testID="metric"
      />,
    );
    const group = view.container.querySelector(
      '[data-testid="metric.segmented"]',
    )!;
    expect(group).not.toBeNull();
    const segments = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(segments.map((segment) => segment.textContent)).toEqual([
      'Tokens',
      'Cost',
    ]);
    expect(
      segments.map((segment) => segment.getAttribute('aria-checked')),
    ).toEqual(['true', 'false']);
    act(() => {
      segments[1]!.click();
    });
    expect(onChange).toHaveBeenLastCalledWith('cost');
  });

  it('hangs a field\'s floating choices from the drawn box, not from the wider press row around it', async () => {
    const anchors: unknown[] = [];
    const host: PluginUiPresentationHost = {
      renderMarkdown: () => null, renderCodeBlock: () => null, renderIcon: () => null,
      // The host's popover is the platform boundary; record what the field anchors it to.
      renderPopover: (input) => { anchors.push(input.anchorRef.current); return null; },
    };
    const five = ['a', 'b', 'c', 'd', 'e'].map((value) => ({ value, label: value.toUpperCase() }));
    const view = mountThroughReactNativeWeb(<PluginUiPresentationHostProviderInternal host={host}>
      <HappierInputField field={metric} value={undefined} options={five} onChange={() => {}} frame="none" theme={theme} testID="metric" />
    </PluginUiPresentationHostProviderInternal>);
    try {
      const trigger = view.container.querySelector<HTMLElement>('[data-testid="metric.trigger"]')!;
      await act(async () => { trigger.click(); });
      const anchor = anchors.at(-1) as HTMLElement | undefined;
      expect(anchor).toBeInstanceOf(HTMLElement);
      // The box sits inside the press target; the menu matches its width, so it is never the row itself.
      expect(anchor).not.toBe(trigger);
      expect(trigger.contains(anchor!)).toBe(true);
      expect(anchor!.textContent).toContain(trigger.textContent?.trim().slice(0, 3) ?? '');
    } finally { view.unmount(); }
  });

  it('spans a framed field\'s choice box under its label on a phone, and keeps the desktop cap where the form is wide', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((value) => ({ value, label: value.toUpperCase() }));
    const view = mountThroughReactNativeWeb(
      <HappierInputField field={metric} value={undefined} options={five} onChange={() => {}} theme={theme} testID="metric" />,
    );
    try {
      const handler = (node: Element) => Reflect.get(node, '__reactLayoutHandler') as ((event: unknown) => void) | undefined;
      const frame = view.container.querySelector<HTMLElement>('[data-testid="metric"]')!;
      expect(handler(frame), 'a framed field measures the room its control has beneath the label').toBeDefined();
      const box = () => view.container.querySelector<HTMLElement>('[data-testid="metric.trigger"]')!.firstElementChild as HTMLElement;
      act(() => handler(frame)!({ nativeEvent: { layout: { x: 0, y: 0, width: 640, height: 80 } } }));
      expect(box().style.maxWidth).not.toBe('');
      expect(box().style.alignSelf).not.toBe('stretch');
      // A phone dialog: the box spans the field like its text inputs, so its menu covers the row edge to edge.
      act(() => handler(frame)!({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 80 } } }));
      expect(box().style.alignSelf).toBe('stretch');
      expect(box().style.maxWidth).toBe('');
    } finally { view.unmount(); }
  });

  it('keeps a list for choices that explain themselves, carry long labels, number five or more, or take several values', () => {
    const described = two.map((option) => ({
      ...option,
      description: `${option.label} per day`,
    }));
    const five = ['a', 'b', 'c', 'd', 'e'].map((value) => ({
      value,
      label: value.toUpperCase(),
    }));
    const long = [
      { value: 'auto', label: 'Best available cost' },
      { value: 'reported', label: 'Reported by agents' },
    ];
    expect(
      segmentedIn(
        <HappierInputField
          field={metric}
          value="auto"
          selection="auto"
          options={long}
          onChange={() => {}}
          frame="none"
          theme={theme}
          testID="metric"
        />,
      ),
    ).toBeNull();
    expect(
      segmentedIn(
        <HappierInputField
          field={metric}
          value="tokens"
          selection="tokens"
          options={described}
          onChange={() => {}}
          frame="none"
          theme={theme}
          testID="metric"
        />,
      ),
    ).toBeNull();
    expect(
      segmentedIn(
        <HappierInputField
          field={metric}
          value="a"
          selection="a"
          options={five}
          onChange={() => {}}
          frame="none"
          theme={theme}
          testID="metric"
        />,
      ),
    ).toBeNull();
    expect(
      segmentedIn(
        <HappierInputField
          field={{ ...metric, widget: 'multiselect' }}
          value={[]}
          selection={[]}
          options={two}
          onChange={() => {}}
          frame="none"
          theme={theme}
          testID="metric"
        />,
      ),
    ).toBeNull();
  });
});
