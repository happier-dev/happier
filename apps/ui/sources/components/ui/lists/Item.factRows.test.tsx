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

async function renderFactSection(rows: 'facts' | undefined) {
  const { ItemGroup } = await import('./ItemGroup');
  const { Item } = await import('./Item');
  const { ListPresentationProvider } = await import('./listPresentation');
  const screen = await renderScreen(
    <ListPresentationProvider value="page">
      <ItemGroup header="none" {...(rows ? { rows } : {})}>
        <Item mode="info" title="Licence" detail="MIT" showChevron={false} />
      </ItemGroup>
    </ListPresentationProvider>,
  );
  const styleOf = (text: string): Flat => {
    const node = screen
      .findAllByType('Text' as never)
      .find((candidate) => candidate.props.children === text);
    if (!node) throw new Error(`no text ${text}`);
    return Object.assign(
      {},
      ...([node.props.style].flat(Infinity).filter(Boolean) as Flat[]),
    );
  };
  return { key: styleOf('Licence'), value: styleOf('MIT') };
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
});
