import * as React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { Platform, View } from 'react-native';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import { PluginUiProvider } from '../../components/PluginUiProvider.js';
import { HappierMaterialSurface } from '../layout/Surface.js';
import { happierSurfaceGradientWebStyle } from '../layout/material.js';
import { HappierFindBar, type HappierFindBarHost, type HappierFindBarInputProps, type HappierFindBarLabels, type HappierFindBarProps } from './FindBar.js';
import type { FindOptions, FindStatus } from './findTypes.js';

const host: HappierFindBarHost = {
  Text: (props) => <span data-testid={props.testID}>{props.children}</span>,
  TextInput: ({ ref, ...props }) => (
    <input
      ref={ref as React.Ref<HTMLInputElement>}
      data-testid={props.testID}
      aria-label={props.accessibilityLabel}
      placeholder={props.placeholder}
      value={props.value}
      onChange={(event) => props.onChangeText(event.currentTarget.value)}
      onKeyDown={(event) => props.onKeyPress(event)}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
    />
  ),
  renderGlyph: (glyph) => <span>{glyph}</span>,
  renderSpinner: () => <span data-testid="spinner" />,
};

const labels: HappierFindBarLabels = {
  field: 'Find in chat',
  previous: 'Previous match',
  next: 'Next match',
  matchCase: 'Match case',
  regex: 'Use regular expression',
  regexShort: 'Regular expression',
  options: 'Match options',
  close: 'Close find',
  done: 'Done',
  stop: 'Stop',
  noMatches: 'No matches',
  noneFound: 'None found',
  invalidPattern: 'Invalid pattern',
  offline: 'Offline',
  unsupported: 'Not searchable',
  count: (current, total) => (current === null ? `${total} matches` : `${current} of ${total}`),
  files: (files) => `${files} files`,
  soFar: 'so far',
  loaded: 'loaded',
};

const colors = {
  surface: 'white', ring: 'gray', field: 'whitesmoke', text: 'black', secondaryText: 'dimgray', tertiaryText: 'gray',
  divider: 'gainsboro', accent: 'blue', accentFill: 'lightblue', danger: 'red', hover: 'whitesmoke', pressed: 'gainsboro', focus: 'blue',
} as const;

type Recorded = { steps: Array<1 | -1>; options: FindOptions[]; closed: number; stopped: number; queries: string[] };

function mountBar(overrides: Partial<HappierFindBarProps> & { status: FindStatus }, wrap: (body: React.ReactElement) => React.ReactElement = body => body) {
  const recorded: Recorded = { steps: [], options: [], closed: 0, stopped: 0, queries: [] };
  const props: HappierFindBarProps = {
    query: 'remount',
    options: { matchCase: false, regex: false },
    capabilities: { regex: true, stop: true },
    onQueryChange: (query) => recorded.queries.push(query),
    onOptionsChange: (options) => recorded.options.push(options),
    onStep: (direction) => recorded.steps.push(direction),
    onStop: () => { recorded.stopped += 1; },
    onClose: () => { recorded.closed += 1; },
    presentation: 'inline',
    labels,
    colors,
    host,
    reducedMotion: true,
    autoFocus: false,
    testID: 'find',
    ...overrides,
  };
  const mounted = mountThroughReactNativeWeb(wrap(<HappierFindBar {...props} />));
  return { mounted, recorded, props };
}

const byTestId = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const buttonNamed = (container: HTMLElement, name: string) => Array.from(container.querySelectorAll<HTMLElement>('[role="button"], [role="switch"]'))
  .find((element) => element.getAttribute('aria-label') === name);

async function press(element: HTMLElement | null | undefined): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function key(element: HTMLElement | null, init: KeyboardEventInit & { keyCode?: number }): Promise<KeyboardEvent> {
  expect(element).toBeTruthy();
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: init.keyCode });
  await act(async () => {
    element!.dispatchEvent(event);
  });
  return event;
}

describe('HappierFindBar', () => {
  const gradient = { colors: ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0.024)'] as [string, string] };
  const baseContext = createSurfaceContext();
  const context = { ...baseContext, theme: { ...baseContext.theme, surfaceFinish: { floating: gradient } } };
  const provider = (body: React.ReactElement) => <PluginUiProvider context={context} hostApi={createHostApiStub(context)}>{body}</PluginUiProvider>;

  it('paints the floating capsule once while its field keeps focus, keyboard behavior and identity across Flat', async () => {
    const { mounted, recorded, props } = mountBar({ status: { kind: 'results', current: 1, total: 2, coverage: 'complete' } }, provider);
    const capsule = byTestId(mounted.container, 'find.capsule');
    expect(capsule).toBeTruthy();
    expect(getComputedStyle(capsule!).backgroundImage).toContain('linear-gradient');
    expect(getComputedStyle(capsule!).backgroundColor).toContain('--happier-glass-floating-opacity');
    expect(mounted.container.querySelector('svg')).toBeNull();
    const field = byTestId(mounted.container, 'find.field')!;
    const input = byTestId(mounted.container, 'find.input') as HTMLInputElement;
    expect(field.contains(input)).toBe(true);
    expect(['', 'none']).toContain(getComputedStyle(field).backgroundImage);
    await press(field);
    expect(document.activeElement).toBe(input);
    await mounted.render(provider(<HappierFindBar {...props} gradient={null} />));
    expect(byTestId(mounted.container, 'find.input')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(['', 'none']).toContain(getComputedStyle(byTestId(mounted.container, 'find.capsule')!).backgroundImage);
    await key(input, { key: 'Enter' });
    expect(recorded.steps).toEqual([1]);
    await press(buttonNamed(mounted.container, 'Close find'));
    expect(recorded.closed).toBe(1);
    mounted.unmount();
  });

  it('inherits an already-finished floating group without a second coat and keeps independent content groups separate', () => {
    const same = mountBar({ status: { kind: 'idle' }, note: { icon: 'offline', text: 'Offline' } }, body => provider(<HappierMaterialSurface testID="parent" materialRole="floating" finishRole="floating" style={{ backgroundColor: 'white' }}>{body}</HappierMaterialSurface>));
    expect(getComputedStyle(byTestId(same.mounted.container, 'parent')!).backgroundImage).toContain('linear-gradient');
    expect(byTestId(same.mounted.container, 'find.capsule')).toBeTruthy();
    expect(['', 'none']).toContain(getComputedStyle(byTestId(same.mounted.container, 'find.capsule')!).backgroundImage);
    expect(['', 'none']).toContain(getComputedStyle(byTestId(same.mounted.container, 'find.note')!).backgroundImage);
    same.mounted.unmount();
    const separate = mountBar({ status: { kind: 'idle' } }, body => provider(<HappierMaterialSurface materialRole="content" gradient={gradient} style={{ backgroundColor: 'white' }}>{body}</HappierMaterialSurface>));
    expect(getComputedStyle(byTestId(separate.mounted.container, 'find.capsule')!).backgroundImage).toContain('linear-gradient');
    separate.mounted.unmount();
  });

  it('delivers the resolved floating coat to the material host without replacing its translucent fill', async () => {
    const renderMaterialSurface: NonNullable<HappierFindBarProps['renderMaterialSurface']> = input => {
      expect(input.role).toBe('floating');
      expect(input.finishRole).toBe('floating');
      // The platform glass renderer is a boundary; shared finish decisions and capsule anatomy stay real.
      return <View testID={input.testID} style={[input.style, { backgroundColor: 'rgba(255, 255, 255, 0.3)' }, happierSurfaceGradientWebStyle(input.gradient)]}>{input.children}</View>;
    };
    const { mounted, props } = mountBar({ status: { kind: 'idle' }, renderMaterialSurface }, provider);
    const body = byTestId(mounted.container, 'find.capsule')!;
    expect(getComputedStyle(body).backgroundColor).toBe('rgba(255, 255, 255, 0.3)');
    expect(getComputedStyle(body).backgroundImage).toContain('linear-gradient');
    expect(['', '1']).toContain(getComputedStyle(body).opacity);
    const input = byTestId(mounted.container, 'find.input');
    await mounted.render(provider(<HappierFindBar {...props} gradient={null} />));
    expect(byTestId(mounted.container, 'find.input')).toBe(input);
    expect(['', 'none']).toContain(getComputedStyle(byTestId(mounted.container, 'find.capsule')!).backgroundImage);
    expect(getComputedStyle(byTestId(mounted.container, 'find.capsule')!).backgroundColor).toBe('rgba(255, 255, 255, 0.3)');
    mounted.unmount();
  });

  it('renders one native-branch overlay per floating plane and none for an explicit null finish', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    try {
      for (const presentation of ['inline', 'keyboardSeated'] as const) {
        const { mounted, props } = mountBar({ presentation, status: { kind: 'idle' }, note: { icon: 'offline', text: 'Offline' } }, provider);
        const planes = presentation === 'inline' ? 2 : 1;
        expect(mounted.container.querySelectorAll('svg')).toHaveLength(planes);
        expect(mounted.container.querySelectorAll('linearGradient')).toHaveLength(planes);
        expect(byTestId(mounted.container, 'find.note')!.querySelectorAll('svg')).toHaveLength(presentation === 'inline' ? 1 : 0);
        const input = byTestId(mounted.container, 'find.input');
        expect(byTestId(mounted.container, 'find.capsule')!.contains(input)).toBe(true);
        await mounted.render(provider(<HappierFindBar {...props} gradient={null} />));
        expect(mounted.container.querySelectorAll('svg')).toHaveLength(0);
        expect(byTestId(mounted.container, 'find.input')).toBe(input);
        mounted.unmount();
      }
    } finally {
      if (descriptor) Object.defineProperty(Platform, 'OS', descriptor);
    }
  });

  it('finishes the separate inline alert but seats the note inside the single phone material without remounting its input', async () => {
    for (const presentation of ['inline', 'keyboardSeated'] as const) {
      let searched = 0;
      const { mounted, props, recorded } = mountBar({
        presentation,
        status: { kind: 'results', current: 1, total: 2, coverage: 'loaded' },
        note: { icon: 'history', text: 'Older messages remain unsearched.', action: { label: 'Search older messages', onPress: () => { searched += 1; } } },
      }, provider);
      const note = byTestId(mounted.container, 'find.note')!;
      const capsule = byTestId(mounted.container, 'find.capsule')!;
      expect(capsule.contains(note)).toBe(presentation === 'keyboardSeated');
      if (presentation === 'inline') {
        expect(getComputedStyle(note).backgroundImage).toContain('linear-gradient');
        expect(getComputedStyle(note).backgroundColor).toContain('--happier-glass-floating-opacity');
      } else {
        expect(['', 'none']).toContain(getComputedStyle(note).backgroundImage);
        expect(['', 'transparent', 'rgba(0, 0, 0, 0)']).toContain(getComputedStyle(note).backgroundColor);
      }
      const input = byTestId(mounted.container, 'find.input')!;
      await act(async () => { input.focus(); });
      await press(buttonNamed(mounted.container, 'Search older messages'));
      expect(searched).toBe(1);
      await mounted.render(provider(<HappierFindBar {...props} gradient={null} status={{ kind: 'searching', current: 1, total: 2 }} />));
      expect(byTestId(mounted.container, 'find.input')).toBe(input);
      expect(['', 'none']).toContain(getComputedStyle(byTestId(mounted.container, 'find.note')!).backgroundImage);
      expect(buttonNamed(mounted.container, 'Search older messages')).toBeUndefined();
      await press(buttonNamed(mounted.container, 'Stop'));
      expect(recorded.stopped).toBe(1);
      mounted.unmount();
    }
  });

  it('steps once for the native SDK keyPress Enter followed by submitEditing sequence', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    let inputProps: HappierFindBarInputProps | undefined;
    const nativeHost: HappierFindBarHost = { ...host, TextInput: (props) => { inputProps = props; return <host.TextInput {...props} />; } };
    const { mounted, recorded } = mountBar({ host: nativeHost, status: { kind: 'results', current: 1, total: 2, coverage: 'complete' } });
    try {
      // Android InputConnection emits keyPress; its editor action emits submitEditing independently.
      await act(async () => { inputProps!.onKeyPress({ nativeEvent: { key: 'Enter' } }); inputProps!.onSubmitEditing!(); });
      expect(recorded.steps).toEqual([1]);
    } finally {
      mounted.unmount();
      if (descriptor) Object.defineProperty(Platform, 'OS', descriptor);
    }
  });

  it('reports actual field focus and blur so a mounted surface releases native Return ownership', async () => {
    let inputFocused = false;
    const { mounted } = mountBar({
      status: { kind: 'idle' },
      onInputFocus: () => { inputFocused = true; },
      onInputBlur: () => { inputFocused = false; },
    });
    const input = byTestId(mounted.container, 'find.input');
    await act(async () => { input!.focus(); });
    expect(inputFocused).toBe(true);
    await act(async () => { input!.blur(); });
    expect(inputFocused).toBe(false);
    mounted.unmount();
  });

  it('steps with ↵ and ⇧↵ and closes with Esc from its field, and never while an IME is composing', async () => {
    const { mounted, recorded } = mountBar({ status: { kind: 'results', current: 3, total: 8, coverage: 'complete' } });
    const input = byTestId(mounted.container, 'find.input');

    const enter = await key(input, { key: 'Enter' });
    await key(input, { key: 'Enter', shiftKey: true });
    expect(recorded.steps).toEqual([1, -1]);
    // ↵ is the bar's step, so it must not also submit or reach the page.
    expect(enter.defaultPrevented).toBe(true);

    await key(input, { key: 'Enter', isComposing: true });
    await key(input, { key: 'Enter', keyCode: 229 });
    await key(input, { key: 'Escape', isComposing: true });
    expect(recorded.steps).toEqual([1, -1]);
    expect(recorded.closed).toBe(0);

    await key(input, { key: 'Escape' });
    expect(recorded.closed).toBe(1);
    mounted.unmount();
  });

  it('says "No matches" only when everything was searched; an incomplete search says what it found so far', async () => {
    const complete = mountBar({ status: { kind: 'results', current: null, total: 0, coverage: 'complete' } });
    expect(byTestId(complete.mounted.container, 'find.status')?.textContent).toBe('No matches');
    complete.mounted.unmount();

    for (const coverage of ['loaded', 'olderRemaining', 'limited', 'partialErrors'] as const) {
      const partial = mountBar({ status: { kind: 'results', current: null, total: 0, coverage } });
      const text = byTestId(partial.mounted.container, 'find.status')?.textContent ?? '';
      expect(text).not.toContain('No matches');
      expect(text).toBe('None found');
      partial.mounted.unmount();
    }
  });

  it('counts across files and marks a loaded-only count, in a polite live region', async () => {
    const files = mountBar({ status: { kind: 'results', current: 3, total: 8, files: 3, coverage: 'complete' } });
    const region = byTestId(files.mounted.container, 'find.status');
    expect(region?.textContent).toBe('3 of 8 · 3 files');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    files.mounted.unmount();

    const loaded = mountBar({ status: { kind: 'results', current: 3, total: 5, coverage: 'loaded' } });
    expect(byTestId(loaded.mounted.container, 'find.status')?.textContent).toBe('3 of 5 loaded');
    loaded.mounted.unmount();
  });

  it('offers ↑ ↓ only when there is a match to step to', async () => {
    const none = mountBar({ status: { kind: 'invalidPattern' }, options: { matchCase: false, regex: true } });
    expect(byTestId(none.mounted.container, 'find.status')?.textContent).toBe('Invalid pattern');
    await press(buttonNamed(none.mounted.container, 'Next match'));
    await press(buttonNamed(none.mounted.container, 'Previous match'));
    expect(none.recorded.steps).toEqual([]);
    none.mounted.unmount();

    const some = mountBar({ status: { kind: 'results', current: 1, total: 2, coverage: 'complete' } });
    await press(buttonNamed(some.mounted.container, 'Next match'));
    await press(buttonNamed(some.mounted.container, 'Previous match'));
    expect(some.recorded.steps).toEqual([1, -1]);
    some.mounted.unmount();
  });

  it('draws Aa and .* as switches that report their state and flip one option, and hides .* without regex support', async () => {
    const { mounted, recorded } = mountBar({
      status: { kind: 'results', current: 1, total: 2, coverage: 'complete' },
      options: { matchCase: true, regex: false },
    });
    const matchCase = buttonNamed(mounted.container, 'Match case');
    const regex = buttonNamed(mounted.container, 'Use regular expression');
    expect(matchCase?.getAttribute('role')).toBe('switch');
    expect(matchCase?.getAttribute('aria-checked')).toBe('true');
    expect(regex?.getAttribute('aria-checked')).toBe('false');
    await press(matchCase);
    await press(regex);
    expect(recorded.options).toEqual([{ matchCase: false, regex: false }, { matchCase: true, regex: true }]);
    mounted.unmount();

    const engine = mountBar({ status: { kind: 'idle' }, capabilities: { regex: false, stop: false } });
    expect(buttonNamed(engine.mounted.container, 'Use regular expression')).toBeUndefined();
    expect(buttonNamed(engine.mounted.container, 'Match case')).toBeTruthy();
    engine.mounted.unmount();
  });

  it('shows progress and a Stop while searching older content, and the surface note beside it', async () => {
    const { mounted, recorded } = mountBar({
      status: { kind: 'searching', total: 4 },
      note: { icon: 'history', text: 'Looking through older messages · 2 of 9 pages' },
    });
    expect(byTestId(mounted.container, 'spinner')).toBeTruthy();
    expect(byTestId(mounted.container, 'find.status')?.textContent).toBe('4 matches so far');
    expect(byTestId(mounted.container, 'find.note')?.textContent).toContain('Looking through older messages');
    await press(buttonNamed(mounted.container, 'Stop'));
    expect(recorded.stopped).toBe(1);
    mounted.unmount();

    // The current match stays named while older pages load (Find lab ST: "2 of 4 so far").
    const stepped = mountBar({ status: { kind: 'searching', current: 2, total: 4 } });
    expect(byTestId(stepped.mounted.container, 'find.status')?.textContent).toBe('2 of 4 so far');
    stepped.mounted.unmount();

    const noStop = mountBar({ status: { kind: 'searching', total: 4 }, capabilities: { regex: true, stop: false } });
    expect(buttonNamed(noStop.mounted.container, 'Stop')).toBeUndefined();
    noStop.mounted.unmount();
  });

  it("ends the surface's note with its one action (Search older), and Stop takes that place while searching", async () => {
    let searched = 0;
    const action = { label: 'Search older messages', onPress: () => { searched += 1; }, testID: 'find.searchOlder' };
    const idle = mountBar({
      status: { kind: 'results', current: 1, total: 2, coverage: 'loaded' },
      note: { icon: 'history', text: 'Older messages remain unsearched.', action },
    });
    expect(byTestId(idle.mounted.container, 'find.note')?.textContent).toContain('Older messages remain unsearched.');
    await press(buttonNamed(idle.mounted.container, 'Search older messages'));
    expect(searched).toBe(1);
    idle.mounted.unmount();

    const busy = mountBar({ status: { kind: 'searching', current: 1, total: 2 }, note: { icon: 'history', text: 'Looking through older messages', action } });
    expect(buttonNamed(busy.mounted.container, 'Search older messages')).toBeUndefined();
    expect(buttonNamed(busy.mounted.container, 'Stop')).toBeTruthy();
    busy.mounted.unmount();
  });

  it('closes with Esc while focus rests on a bar control, not only in the field', async () => {
    const { mounted, recorded } = mountBar({ status: { kind: 'results', current: 1, total: 2, coverage: 'complete' } });
    await key(buttonNamed(mounted.container, 'Next match') ?? null, { key: 'Escape' });
    expect(recorded.closed).toBe(1);
    mounted.unmount();
  });

  it('reaches match case and regex on a phone through one quiet disclosure, and turns a regex seed back into a literal search', async () => {
    const phone = mountBar({ presentation: 'keyboardSeated', status: { kind: 'results', current: 1, total: 3, coverage: 'complete' } });
    // Closed: the options stay out of the way; nothing to toggle yet.
    expect(buttonNamed(phone.mounted.container, 'Match case')).toBeUndefined();
    const disclosure = buttonNamed(phone.mounted.container, 'Match options');
    expect(disclosure?.getAttribute('aria-expanded')).toBe('false');
    await press(disclosure);
    expect(buttonNamed(phone.mounted.container, 'Match options')?.getAttribute('aria-expanded')).toBe('true');
    const matchCase = buttonNamed(phone.mounted.container, 'Match case');
    expect(matchCase?.getAttribute('role')).toBe('switch');
    expect(matchCase?.getAttribute('aria-checked')).toBe('false');
    await press(matchCase);
    await press(buttonNamed(phone.mounted.container, 'Use regular expression'));
    expect(phone.recorded.options).toEqual([{ matchCase: true, regex: false }, { matchCase: false, regex: true }]);
    phone.mounted.unmount();

    // A seeded regex that does not compile: the same switch returns it to a literal search.
    const seeded = mountBar({ presentation: 'keyboardSeated', options: { matchCase: false, regex: true }, status: { kind: 'invalidPattern' } });
    await press(buttonNamed(seeded.mounted.container, 'Match options'));
    const regex = buttonNamed(seeded.mounted.container, 'Use regular expression');
    expect(regex?.getAttribute('aria-checked')).toBe('true');
    await press(regex);
    expect(seeded.recorded.options).toEqual([{ matchCase: false, regex: false }]);
    seeded.mounted.unmount();

    // An engine without regex offers only match case.
    const engine = mountBar({ presentation: 'keyboardSeated', capabilities: { regex: false, stop: false }, status: { kind: 'idle' } });
    await press(buttonNamed(engine.mounted.container, 'Match options'));
    expect(buttonNamed(engine.mounted.container, 'Match case')).toBeTruthy();
    expect(buttonNamed(engine.mounted.container, 'Use regular expression')).toBeUndefined();
    engine.mounted.unmount();
  });

  it('seats above the keyboard with ↑ ↓, the field and a printed Done that closes', async () => {
    const { mounted, recorded } = mountBar({
      presentation: 'keyboardSeated',
      status: { kind: 'results', current: 2, total: 3, coverage: 'complete' },
    });
    const done = buttonNamed(mounted.container, 'Close find');
    expect(done?.textContent).toBe('Done');
    await press(buttonNamed(mounted.container, 'Next match'));
    await press(done);
    expect(recorded.steps).toEqual([1]);
    expect(recorded.closed).toBe(1);
    expect(byTestId(mounted.container, 'find.status')?.textContent).toBe('2 of 3');
    mounted.unmount();
  });
});
