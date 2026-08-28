import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Button } from './Button.js';
import { List } from './List.js';
import { PluginUiProvider } from './PluginUiProvider.js';

/**
 * Two row capabilities a virtualized collection needs and a fixed row does not.
 *
 * **Line bounds** exist because the virtualizer has no fixed row height and
 * reveals an unmounted row by `averageItemLength * index`. A title free to grow
 * to any height makes that average describe no row in particular, so the reveal
 * lands short and the reader's own scroll estimate drifts the further they page.
 *
 * **A wrapping accessory** exists because the default row keeps everything on
 * one line by letting the text column shrink to nothing. That is right for a
 * chevron and wrong for a row whose accessory is two real controls: at 320 pt,
 * at the reader's largest type size, or with a long localization the controls
 * keep their intrinsic width and the title is squeezed out of its own row.
 *
 * Both are OFF unless a caller asks, which is what these cases pin first: a
 * capability that silently applied to every existing row would start truncating
 * and reflowing collections that never opted in.
 */
function mountRow(children: ReactNode) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <List accessibilityLabel="Entries">{children}</List>
    </PluginUiProvider>,
  );
}

/** The exact rendered element carrying one row's own text. */
function textElement(container: ParentNode, content: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('div')]
    .find((element) => element.children.length === 0 && element.textContent === content);
  if (!found) throw new Error(`No rendered element carries the text ${JSON.stringify(content)}.`);
  return found;
}

/**
 * How many lines the platform will actually draw, read from the element rather
 * than from the prop that asked for it.
 *
 * React Native Web renders a bound as a real line clamp; `null` is text with no
 * bound at all, which is the default and must stay observable as such.
 */
function renderedLineBound(element: HTMLElement): number | null {
  const clamp = element.style.getPropertyValue('-webkit-line-clamp');
  if (clamp !== '') return Number.parseInt(clamp, 10);
  // One line is not a clamp: React Native Web expresses it as the nowrap
  // ellipsis treatment, which it emits as atomic classes rather than inline
  // declarations. Unbounded text carries neither.
  const classes = element.getAttribute('class') ?? '';
  const nowrap = classes.includes('r-whiteSpace-') && classes.includes('r-textOverflow-');
  return nowrap ? 1 : null;
}

const LONG_TITLE = 'Replace the duplicated normalizer so every source stops answering the same question twice';

describe('plugin-ui List row line bounds', () => {
  it('leaves every text slot unbounded when no bound is asked for', () => {
    const mount = mountRow(
      <List.Item title={LONG_TITLE} subtitle="acme/web" detail="Updated" />,
    );

    expect(renderedLineBound(textElement(mount.container, LONG_TITLE))).toBeNull();
    expect(renderedLineBound(textElement(mount.container, 'acme/web'))).toBeNull();
    expect(renderedLineBound(textElement(mount.container, 'Updated'))).toBeNull();
    mount.unmount();
  });

  it('bounds each slot the caller asks for, and only that slot', () => {
    const mount = mountRow(
      <List.Item
        title={LONG_TITLE}
        subtitle="acme/web"
        detail="Updated"
        titleNumberOfLines={2}
        detailNumberOfLines={1}
      />,
    );

    expect(renderedLineBound(textElement(mount.container, LONG_TITLE))).toBe(2);
    expect(renderedLineBound(textElement(mount.container, 'Updated'))).toBe(1);
    // Unasked-for is still unbounded: this is a per-slot capability, not a row
    // mode that quietly truncates the parts the caller said nothing about.
    expect(renderedLineBound(textElement(mount.container, 'acme/web'))).toBeNull();
    mount.unmount();
  });
});

describe('plugin-ui List row accessory wrapping', () => {
  function rowContentBox(container: ParentNode, title: string): HTMLElement {
    const text = textElement(container, title);
    const column = text.parentElement;
    const content = column?.parentElement;
    if (!content) throw new Error('The semantic row rendered no content box.');
    return content;
  }

  it('keeps the accessory on the row and lets the text shrink by default', () => {
    const mount = mountRow(
      <List.Item title={LONG_TITLE} accessory={<Button title="Attach" onPress={() => undefined} />} />,
    );
    const content = rowContentBox(mount.container, LONG_TITLE);
    const column = textElement(mount.container, LONG_TITLE).parentElement;

    expect(content.style.flexWrap).toBe('nowrap');
    // A column that may shrink to nothing is exactly what keeps a small
    // trailing affordance beside the title on one line.
    expect(column?.style.minWidth).toBe('0px');
    mount.unmount();
  });

  it('lets the accessory take its own line rather than starve the title', () => {
    const mount = mountRow(
      <List.Item title={LONG_TITLE} accessoryWraps accessory={<Button title="Attach" onPress={() => undefined} />} />,
    );
    const content = rowContentBox(mount.container, LONG_TITLE);
    const column = textElement(mount.container, LONG_TITLE).parentElement;

    expect(content.style.flexWrap).toBe('wrap');
    // Half the row is what makes the wrap happen at all: a column free to
    // shrink lets the accessory keep its intrinsic width and take the title's
    // space instead of its own line. It is an equal claim between the row's two
    // content groups, not a breakpoint or a device width.
    expect(column?.style.minWidth).toBe('50%');
    mount.unmount();
  });

  it('keeps the wrapping contract when an interactive accessory is outside the row pressable', () => {
    const mount = mountRow(
      <List.Item
        title={LONG_TITLE}
        onPress={() => undefined}
        accessoryWraps
        accessoryOutsidePressable
        accessory={<Button title="Attach" onPress={() => undefined} />}
      />,
    );
    const accessory = [...mount.container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((element) => element.textContent === 'Attach');
    const outerContent = accessory?.parentElement;
    const primaryContent = outerContent?.firstElementChild as HTMLElement | null;

    expect(outerContent?.style.flexWrap).toBe('wrap');
    expect(primaryContent?.style.minWidth).toBe('50%');
    mount.unmount();
  });
});
