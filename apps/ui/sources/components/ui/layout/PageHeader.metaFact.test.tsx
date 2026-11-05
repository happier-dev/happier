import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSignedOutAuthForTest } from '@/dev/testkit/fixtures/signedOutAuth';
import { PageHeader } from '@/components/ui/layout/PageHeader';

vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('@react-navigation/native', async () =>
  (
    await import('@/dev/testkit/mocks/reactNavigation')
  ).createReactNavigationNativeMock(),
);

type Screen = Awaited<ReturnType<typeof renderScreen>>;
let screen: Screen | null = null;

afterEach(async () => {
  await screen?.unmount();
  screen = null;
});

// A provider's own name for a machine (a Lima instance is 50+ unbroken characters) is as long as it is.
const NATIVE_NAME =
  'happier-208p8qr2m9m9szbi5eswryjkn7ck5t48b9vkt1jjoq65kn079r';

it('gives up the middle of an id fact on its one line, so it never runs off a narrow header', async () => {
  screen = await renderScreen(
    <PageHeader
      testID="header"
      title="Build box"
      meta={[
        { key: 'kind', text: 'Lima VM' },
        { key: 'id', text: NATIVE_NAME, mono: true, testID: 'header-id' },
      ]}
    />,
  );

  const fact = screen.findByTestId('header-id')!;
  const painted = fact.findAll(
    (node) =>
      typeof node.type === 'string' && node.props?.numberOfLines !== undefined,
  );
  expect(painted.length).toBeGreaterThan(0);
  for (const node of painted) expect(node.props.numberOfLines).toBe(1);
  // Everything is still there for the page, assistive tech and the tooltip: the pieces join back to the name.
  const text = fact
    .findAll((node) => typeof node.props?.children === 'string')
    .map((node) => node.props.children as string)
    .join('');
  expect(text).toContain(NATIVE_NAME);
});

it('lets a plain-words fact wrap as before', async () => {
  screen = await renderScreen(
    <PageHeader
      testID="header"
      title="Build box"
      meta={[{ key: 'kind', text: 'Hetzner server', testID: 'header-kind' }]}
    />,
  );

  const fact = screen.findByTestId('header-kind')!;
  expect(
    fact.findAll((node) => node.props?.numberOfLines !== undefined),
  ).toHaveLength(0);
});

it('copies the whole id when the id fact is tapped', async () => {
    const restoreAuth = installSignedOutAuthForTest();
    const written: string[] = [];
    vi.spyOn(await import('expo-clipboard'), 'setStringAsync').mockImplementation(async (value: string) => { written.push(value); return true; });
    try {
        screen = await renderScreen(
            <PageHeader testID="header" title="Build box" meta={[{ key: 'id', text: NATIVE_NAME, mono: true, testID: 'header-id' }]} />,
        );

        const tap = screen.findByTestId('header-id')!.findAll((node) => typeof node.props?.onPress === 'function')[0]!;
        await act(async () => { await tap.props.onPress(); });
        expect(written).toEqual([NATIVE_NAME]);
    } finally { restoreAuth(); }
});
