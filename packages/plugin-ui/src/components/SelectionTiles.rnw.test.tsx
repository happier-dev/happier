import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { SelectionTiles, Text, type SelectionTilesOption } from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { HappierSelectionTiles } from '../presentation/form/SelectionTiles.js';

function mountTiles(element: React.ReactElement, context = createSurfaceContext()) {
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {element}
    </PluginUiProvider>,
  );
}

const DENSITY_OPTIONS: readonly SelectionTilesOption<'comfortable' | 'compact' | 'dense' | 'cozy'>[] = [
  { id: 'comfortable', title: 'Comfortable', subtitle: 'More room' },
  { id: 'compact', title: 'Compact' },
  { id: 'dense', title: 'Dense', disabled: true },
  { id: 'cozy', title: 'Cozy' },
];

function ControlledSingle(props: Readonly<{ variant?: 'card' | 'visual'; onChange?: (next: string | null) => void }>) {
  const [value, setValue] = useState<'comfortable' | 'compact' | 'dense' | 'cozy' | null>('compact');
  return (
    <SelectionTiles
      variant={props.variant}
      accessibilityLabel="Row density"
      options={DENSITY_OPTIONS}
      value={value}
      onChange={(next) => {
        props.onChange?.(next);
        setValue(next);
      }}
      testID="density"
    />
  );
}

function radios(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="radio"]')];
}

function checked(container: HTMLElement, role: 'radio' | 'checkbox'): string[] {
  return [...container.querySelectorAll<HTMLElement>(`[role="${role}"]`)]
    .filter((tile) => tile.getAttribute('aria-checked') === 'true')
    .map((tile) => tile.textContent ?? '');
}

async function pressKey(target: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
  });
}

describe('SelectionTiles', () => {
  it('presents author-supplied bare marks, badges and current option footers without losing choice semantics', async () => {
    const onChange = vi.fn();
    const mount = mountTiles(<SelectionTiles
      accessibilityLabel="Speech service" value="one" onChange={onChange}
      options={[{ id: 'one', title: 'One', mark: <Text>Identity</Text>, badge: 'Preview' },
        { id: 'two', title: 'Two' }]}
      density="compact" minimumColumns={2} maximumColumns={2} minimumTileWidth={170} subtitleLines={0}
      renderOptionFooter={({ option, selected }) => <Text>{`${option.id}:${selected ? 'selected' : 'available'}`}</Text>}
    />);
    expect(mount.container.textContent).toContain('Identity');
    expect(mount.container.textContent).toContain('Preview');
    expect(mount.container.textContent).toContain('one:selected');
    expect(mount.container.textContent).toContain('two:available');
    await act(async () => { radios(mount.container)[1]?.click(); });
    expect(onChange).toHaveBeenLastCalledWith('two');
    mount.unmount();
  });
  it('wraps a four-option visual picker into the requested two columns without changing selection order', async () => {
    const onChange = vi.fn();
    const mount = mountThroughReactNativeWeb(<HappierSelectionTiles
      variant="visual" tileSizing="fill" maximumColumns={2}
      accessibilityLabel="Starting style" options={DENSITY_OPTIONS} value="compact" onChange={onChange}
      colors={{ tileBackground: 'white', tileBorder: 'gray', selection: 'black', glyph: 'black', ring: 'black',
        previewBackground: 'white', actionBackground: 'white', actionBorderHovered: 'black' }}
      renderText={({ text }) => <span>{text}</span>}
      renderGlyph={() => null}
    />);
    // RNW exposes the wrapping basis in the real DOM. Three bases plus two gaps cannot fit
    // a row, so the four previews wrap into two equal pairs instead of being squeezed together.
    const basis = getComputedStyle(radios(mount.container)[0]!).flexBasis;
    expect(basis.endsWith('%')).toBe(true);
    expect(Number.parseFloat(basis) * 3).toBeGreaterThanOrEqual(100);
    await pressKey(radios(mount.container)[1]!, 'ArrowDown');
    expect(onChange).toHaveBeenLastCalledWith('cozy');
    mount.unmount();
  });
  it('is one named radio group whose tiles say which option is chosen, and a press chooses', async () => {
    const onChange = vi.fn();
    const mount = mountTiles(<ControlledSingle onChange={onChange} />);

    const group = mount.container.querySelector<HTMLElement>('[role="radiogroup"]');
    expect(group?.getAttribute('aria-label')).toBe('Row density');
    expect(radios(mount.container)).toHaveLength(4);
    expect(checked(mount.container, 'radio')).toEqual(['Compact']);
    expect(mount.container.textContent).toContain('More room');

    await act(async () => { radios(mount.container)[0]?.click(); });
    expect(onChange).toHaveBeenLastCalledWith('comfortable');
    expect(checked(mount.container, 'radio')).toEqual(['Comfortable' + 'More room']);

    // A disabled tile is announced as disabled and never chooses.
    const dense = radios(mount.container)[2]!;
    expect(dense.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { dense.click(); });
    expect(onChange).not.toHaveBeenCalledWith('dense');
    mount.unmount();
  });

  it.each(['card', 'visual'] as const)('keeps one tab stop and moves the %s selection with the arrow keys, skipping disabled tiles', async (variant) => {
    const mount = mountTiles(<ControlledSingle variant={variant} />);

    const tabStops = () => radios(mount.container).map((tile) => tile.getAttribute('tabindex'));
    expect(tabStops()).toEqual(['-1', '0', '-1', '-1']);

    await pressKey(radios(mount.container)[1]!, 'ArrowRight');
    expect(checked(mount.container, 'radio')).toEqual(['Cozy']);
    expect(tabStops()).toEqual(['-1', '-1', '-1', '0']);

    await pressKey(radios(mount.container)[3]!, 'Home');
    expect(checked(mount.container, 'radio')[0]).toContain('Comfortable');
    mount.unmount();
  });

  it('toggles checkbox tiles in multiple selection and keeps each one in the tab order', async () => {
    const onChange = vi.fn();
    function ControlledMultiple() {
      const [value, setValue] = useState<readonly string[]>(['compact']);
      return (
        <SelectionTiles
          selectionMode="multiple"
          accessibilityLabel="Columns"
          options={DENSITY_OPTIONS}
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    const mount = mountTiles(<ControlledMultiple />);
    const boxes = () => [...mount.container.querySelectorAll<HTMLElement>('[role="checkbox"]')];

    expect(boxes()).toHaveLength(4);
    // Every enabled checkbox is its own tab stop (a disabled one leaves the order).
    expect(boxes().map((tile) => tile.getAttribute('tabindex'))).toEqual(['0', '0', '-1', '0']);
    await act(async () => { boxes()[3]?.click(); });
    expect(onChange).toHaveBeenLastCalledWith(['compact', 'cozy']);
    await pressKey(boxes()[1]!, ' ');
    expect(onChange).toHaveBeenLastCalledWith(['cozy']);
    expect(checked(mount.container, 'checkbox')).toEqual(['Cozy']);
    mount.unmount();
  });

  it('renders each visual tile as its preview with the label beneath, and rings the chosen one', async () => {
    const context = createSurfaceContext();
    function ControlledVisual() {
      const [value, setValue] = useState<'list' | 'grid'>('grid');
      return (
        <SelectionTiles
          variant="visual"
          accessibilityLabel="Layout"
          options={[
            { id: 'list', title: 'List', preview: <Text value="list preview" testID="preview:list" /> },
            { id: 'grid', title: 'Grid', preview: <Text value="grid preview" testID="preview:grid" /> },
          ]}
          value={value}
          onChange={(next) => { if (next !== null) setValue(next); }}
          testID="layout"
        />
      );
    }
    const mount = mountTiles(<ControlledVisual />, context);

    const list = mount.container.querySelector<HTMLElement>('[data-testid="layout:list"]')!;
    const grid = mount.container.querySelector<HTMLElement>('[data-testid="layout:grid"]')!;
    // The preview is the author's real element, inside its tile, above the label.
    expect(list.querySelector('[data-testid="preview:list"]')?.textContent).toBe('list preview');
    expect(grid.querySelector('[data-testid="preview:grid"]')?.textContent).toBe('grid preview');
    expect(list.getAttribute('aria-label')).toBe('List');
    expect(grid.getAttribute('aria-checked')).toBe('true');

    const ringOf = (tile: HTMLElement) => getComputedStyle(tile.firstElementChild as HTMLElement).borderTopColor;
    expect(ringOf(grid)).not.toBe(ringOf(list));
    await act(async () => { list.click(); });
    expect(list.getAttribute('aria-checked')).toBe('true');
    expect(grid.getAttribute('aria-checked')).toBe('false');
    mount.unmount();
  });
});
