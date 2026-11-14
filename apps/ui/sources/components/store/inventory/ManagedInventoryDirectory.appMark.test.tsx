import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

afterEach(standardCleanup);

const { RowMark } = await import('./ManagedInventoryDirectory');
const { StoreItemMark } =
  await import('@/components/store/catalog/StoreItemMark');
const { StoreRegistryIdentityProvider } =
  await import('@/components/store/catalog/StoreRegistryIdentity');

const brandMark = { displayName: 'PostgreSQL', bytes: new Uint8Array([137, 80, 78, 71]) };
const appRow = (
  catalogTemplate?: Readonly<{
    sourceId: string;
    itemId: string;
    version: string;
  }>,
) =>
  ({
    kind: 'app',
    key: 'app:1',
    scope: { serverId: 'srv', accountId: 'account' },
    projectKeys: null,
    home: '/x',
    native: {
      environment: { id: 'env-1' },
      title: 'Postgres for QA',
      chip: null,
      ...(catalogTemplate ? { catalogTemplate } : {}),
    },
  }) as never;

// J50 (QA-SHELL-1114 / COR5-OPS-STORE-1114): an App installed from a catalog draws its listing's own artwork through the
// Store's one registry identity owner, never the generic App glyph; an App with no catalog origin keeps the kind glyph.
it("draws an installed App with its catalog listing's artwork", async () => {
  const screen = await renderScreen(
    <StoreRegistryIdentityProvider
      items={[
        {
          kind: 'app',
          sourceId: 'apps',
          itemId: 'postgres',
          version: '1',
          title: 'PostgreSQL',
          brandMark,
        },
      ]}
    >
      <RowMark
        row={appRow({ sourceId: 'apps', itemId: 'postgres', version: '1' })}
        title="Postgres for QA"
        input={{} as never}
      />
    </StoreRegistryIdentityProvider>,
  );
  expect(screen.root.findByType(StoreItemMark).props.facts.brand).toBe(
    brandMark,
  );
});

it('keeps the App kind glyph for an App with no catalog origin', async () => {
  const screen = await renderScreen(
    <RowMark row={appRow()} title="Hand-written compose" input={{} as never} />,
  );
  expect(
    screen.root.findByType(StoreItemMark).props.facts.brand ?? null,
  ).toBeNull();
});
