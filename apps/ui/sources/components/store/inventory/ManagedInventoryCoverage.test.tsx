import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ManagedInventoryCoverage } from './ManagedInventoryCoverage';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

afterEach(standardCleanup);

type Families = React.ComponentProps<
  typeof ManagedInventoryCoverage
>['families'];
const family = (coverage: unknown, continuation?: () => unknown) =>
  ({
    kind: 'app',
    result: { rows: [], coverage, ...(continuation ? { continuation } : {}) },
  }) as unknown as Families[number];

async function lines(families: readonly Families[number][], sectionsPage = false) {
  const screen = await renderScreen(
    <ManagedInventoryCoverage
      families={families as Families}
      testIDPrefix="store.installed"
      sectionsPage={sectionsPage}
    />,
  );
  return screen.root
    .findAllByType(SurfaceStateCard)
    .map((node) => ({
      testID: node.props.testID as string,
      kind: node.props.kind as string,
      retry: node.props.action?.testID as string | undefined,
    }));
}

// Pending, settled-partial and failed are different states (happier-testing "Pending, empty and failed are three
// states"). QA-DEPLOY-1114 #14 / QA-SHELL-1114 F4: Installed kept the pending glyph for minutes on a settled page whose
// own Next pager was already showing ("Apps · Some of these haven't loaded yet").
it('keeps the pending glyph only while a read is still arriving', async () => {
  expect(
    await lines([
      family({
        partial: { kind: 'resolved', observation: 'live' },
      }),
    ]),
  ).toEqual([
    {
      testID: 'store.installed.coverage.partial',
      kind: 'loading',
      retry: undefined,
    },
  ]);
});

it('says a settled partial read without the pending glyph', async () => {
  const settled = await lines([
    family(
      { partial: { kind: 'resolved', settled: true, observation: 'stale' } },
      () => {},
    ),
  ]);
  expect(settled).toHaveLength(1);
  expect(settled[0]!.kind).not.toBe('loading');
  expect(settled[0]!.retry).toBe('store.installed.coverage.incomplete.retry');
});

it('leaves a settled page with more to load to its own pager: no line, no pending glyph', async () => {
  expect(
    await lines([
      family(
        {
          partial: {
            items: [{}],
            coverage: 'partial',
            hasNextPage: true,
            hasPreviousPage: false,
          },
        },
        () => {},
      ),
    ], true),
  ).toEqual([]);
});

// Updates has no pager for Apps: there a page that wasn't read is "may not be everything", never a blank body.
it('says a paged family is incomplete where the sections do not page it', async () => {
  const paged = await lines([family({ partial: { items: [{}], coverage: 'partial', hasNextPage: true, hasPreviousPage: false } }, () => {})]);
  expect(paged.map(line => line.testID)).toEqual(['store.installed.coverage.incomplete']);
});
