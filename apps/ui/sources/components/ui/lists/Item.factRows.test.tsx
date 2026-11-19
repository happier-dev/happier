import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@/components/ui/layout/layout', () => ({
  useLayoutMaxWidth: () => 850,
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: (props: any) => React.createElement('Text', props, props.children),
}));

afterEach(() => {
  standardCleanup();
  vi.resetModules();
});

type Flat = Record<string, unknown>;

async function renderFactSection(rows: 'facts' | undefined, note?: string) {
  const { ItemGroup } = await import('./ItemGroup');
  const { Item } = await import('./Item');
  const { ListPresentationProvider } = await import('./listPresentation');
  const screen = await renderScreen(
    <ListPresentationProvider value="page">
      <ItemGroup header="none" {...(rows ? { rows } : {})}>
        <Item mode="info" title="Licence" detail="MIT" {...(note ? { subtitle: note } : {})} accessoryLayout="adaptive" showChevron={false} />
      </ItemGroup>
    </ListPresentationProvider>,
  );
  const nodeOf = (text: string) => {
    const node = screen
      .findAllByType('Text' as never)
      .find((candidate) => candidate.props.children === text);
    if (!node) throw new Error(`no text ${text}`);
    return node;
  };
  const flat = (style: unknown): Flat => Object.assign({}, ...([style].flat(Infinity).filter(Boolean) as Flat[]));
  const styleOf = (text: string): Flat => flat(nodeOf(text).props.style);
  // The box a text sits in: its nearest styled ancestor that is not the text itself.
  const columnOf = (text: string) => {
    let node = nodeOf(text).parent;
    while (node && (node.type === ('Text' as never) || (typeof node.type === 'function' && node.type.name === 'Text') || !node.props.style)) node = node.parent;
    if (!node) throw new Error(`no column for ${text}`);
    return node;
  };
  return { key: styleOf('Licence'), value: styleOf('MIT'), nodeOf, columnOf, flat };
}

describe('Item in a facts section (Store listing facts, Themes lab C2)', () => {
  it('steps the key back to the regular face in secondary ink while the value leads in primary ink', async () => {
    const { lightTheme } = await import('@/theme');
    const { Typography } = await import('@/constants/Typography');
    const { key, value } = await renderFactSection('facts');
    expect(key.fontFamily).toBe(Typography.default('regular').fontFamily);
    expect(key.color).toBe(lightTheme.colors.text.secondary);
    expect(value.color).toBe(lightTheme.colors.text.primary);
  });

  it('keeps a settings section label first: its key stays in the medium face', async () => {
    const { Typography } = await import('@/constants/Typography');
    const { key } = await renderFactSection(undefined);
    expect(key.fontFamily).toBe(Typography.default('medium').fontFamily);
  });

  it('sets the facts as two columns: the key in its own column, the value and its note left-aligned beside it (lab C2 th-kv)', async () => {
    const { resolveHappierPageRowMetrics } = await import('@happier-dev/plugin-ui/presentation');
    const { nodeOf, columnOf, flat } = await renderFactSection('facts', 'Reviewed for the Happier catalog');
    const keyColumn = columnOf('Licence');
    const valueColumn = columnOf('MIT');
    // The note qualifies the value, so it sits under the value, not under the key.
    expect(columnOf('Reviewed for the Happier catalog')).toBe(valueColumn);
    expect(keyColumn).not.toBe(valueColumn);
    expect(keyColumn.parent).toBe(valueColumn.parent);
    const keyColumnPx = resolveHappierPageRowMetrics({ density: 'cozy', shape: 'standard', role: 'facts' }).factKeyColumnPx;
    expect(keyColumnPx).toBeGreaterThan(0);
    expect(flat(keyColumn.props.style).width).toBe(keyColumnPx);
    expect(flat(valueColumn.props.style).flex).toBe(1);
    // A value is prose that wraps in its column; it never right-aligns or cuts to one line.
    expect(nodeOf('MIT').props.numberOfLines).toBeUndefined();
    expect(flat(nodeOf('MIT').props.style).textAlign ?? 'left').toBe('left');
  });

  it('keeps settings rows label first with no key column', async () => {
    const { resolveHappierPageRowMetrics } = await import('@happier-dev/plugin-ui/presentation');
    expect(resolveHappierPageRowMetrics({ density: 'cozy', shape: 'standard' }).factKeyColumnPx).toBeNull();
  });
});
