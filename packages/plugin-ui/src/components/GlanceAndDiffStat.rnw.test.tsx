import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '@happier-dev/plugin-sdk/testing';

import {
  HappierUiPaletteProvider,
  resolveHappierUiPalette,
} from '../environment/context.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../surfaceFixture.testSupport.js';
import { DiffStat, WidgetGlanceRow } from '../index.js';
import { PluginUiProvider } from './PluginUiProvider.js';

/** The browser's own spelling of a colour, so a hex token compares with a computed style. */
function cssColor(value: string): string {
  const probe = document.createElement('span');
  probe.style.color = value;
  return probe.style.color;
}

function textColor(container: HTMLElement, text: string): string {
  const node = [...container.querySelectorAll('div, span')].find(
    (element) => element.textContent === text && element.children.length === 0,
  );
  if (!(node instanceof HTMLElement)) throw new Error(`No text node "${text}"`);
  return node.style.color || getComputedStyle(node).color;
}

function mount(
  element: ReactElement,
  palette?: Parameters<typeof HappierUiPaletteProvider>[0]['palette'],
) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {palette ? (
        <HappierUiPaletteProvider palette={palette}>
          {element}
        </HappierUiPaletteProvider>
      ) : (
        element
      )}
    </PluginUiProvider>,
  );
}

describe('DiffStat', () => {
  it('draws the counts in the host version-control inks, and the snapshot success/danger inks without them', () => {
    const palette = {
      ...resolveHappierUiPalette(SURFACE_CONTEXT_THEME_FIXTURE),
      versionControlAdded: '#123456',
      versionControlRemoved: '#654321',
    };
    const hosted = mount(
      <DiffStat added={1234} removed={5} testID="stat" />,
      palette,
    );
    expect(
      hosted.container.querySelector('[data-testid="stat"]')?.textContent,
    ).toBe(`+${(1234).toLocaleString()} −5`);
    expect(textColor(hosted.container, `+${(1234).toLocaleString()}`)).toBe(
      cssColor('#123456'),
    );
    expect(textColor(hosted.container, '−5')).toBe(cssColor('#654321'));
    hosted.unmount();

    const snapshot = mount(<DiffStat added={3} removed={2} />);
    expect(textColor(snapshot.container, '+3')).toBe(
      cssColor(SURFACE_CONTEXT_THEME_FIXTURE.colors.success),
    );
    expect(textColor(snapshot.container, '−2')).toBe(
      cssColor(SURFACE_CONTEXT_THEME_FIXTURE.colors.danger),
    );
    snapshot.unmount();
  });

  it('leaves out a side with nothing to say, and draws nothing with neither', () => {
    const onlyAdded = mount(<DiffStat added={7} removed={0} testID="stat" />);
    expect(
      onlyAdded.container.querySelector('[data-testid="stat"]')?.textContent,
    ).toBe('+7');
    onlyAdded.unmount();
    const none = mount(<DiffStat added={0} removed={0} testID="stat" />);
    expect(none.container.querySelector('[data-testid="stat"]')).toBeNull();
    none.unmount();
  });
});

describe('WidgetGlanceRow', () => {
  it('is one pressable named by its title, tag and fact when it leads somewhere', () => {
    const onPress = vi.fn();
    const row = mount(
      <WidgetGlanceRow
        testID="row"
        title="main"
        tag="Here"
        fact="nl1 · agent working"
        onPress={onPress}
      />,
    );
    const pressable = row.container.querySelector(
      '[data-testid="row"]',
    ) as HTMLElement;
    expect(pressable.getAttribute('role')).toBe('button');
    expect(pressable.getAttribute('aria-label')).toBe(
      'main, Here, nl1 · agent working',
    );
    pressable.click();
    expect(onPress).toHaveBeenCalledTimes(1);
    row.unmount();
  });

  it('continues the label as one wrapping sentence when the tag says more about it', () => {
    const row = mount(<WidgetGlanceRow testID="row" title="5 files not committed" tag="3 included" tagSentence />);
    const texts = [...row.container.querySelectorAll('[data-testid="row"] [dir="auto"]')] as HTMLElement[];
    const line = texts.find(text => text.textContent?.includes('5 files not committed')) as HTMLElement;
    expect(line.textContent).toBe('5 files not committed · 3 included');
    // Room or not, the label is never cut short by its tag: the line wraps instead of clamping to one.
    expect(getComputedStyle(line).whiteSpace).not.toBe('nowrap');
    row.unmount();
  });

  it('wraps a state row\'s title and fact instead of cutting them short, as the state lines beside it do', () => {
    const row = mount(<WidgetGlanceRow testID="row" variant="state" title="No Environments in this Project"
      fact="Add one to deploy and run checks here" />);
    const texts = [...row.container.querySelectorAll('[data-testid="row"] [dir="auto"]')] as HTMLElement[];
    for (const sentence of ['No Environments in this Project', 'Add one to deploy and run checks here']) {
      const line = texts.find(text => text.textContent === sentence) as HTMLElement;
      expect(getComputedStyle(line).whiteSpace).not.toBe('nowrap');
    }
    row.unmount();
  });

  it('stays a static row without a press, and speaks only when the fact needs the person', () => {
    const row = mount(
      <WidgetGlanceRow
        testID="row"
        title="feature/x"
        fact="needs you"
        factTone="attention"
      />,
    );
    expect(
      row.container.querySelector('[data-testid="row"]')?.getAttribute('role'),
    ).not.toBe('button');
    expect(textColor(row.container, 'needs you')).toBe(
      cssColor(SURFACE_CONTEXT_THEME_FIXTURE.colors.warning),
    );
    row.unmount();
    const quiet = mount(<WidgetGlanceRow title="feature/x" fact="nl1" />);
    expect(textColor(quiet.container, 'nl1')).toBe(
      cssColor(SURFACE_CONTEXT_THEME_FIXTURE.colors.secondaryText),
    );
    quiet.unmount();
  });
});
