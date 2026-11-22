import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactListHttpResponse } from '@/dev/testkit/harness/artifactStoreBoundary';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
} from '@happier-dev/protocol/storage/artifactStoredContent';
import type { StorageInventoryV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import type { ReactTestInstance } from 'react-test-renderer';

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit');
  return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit');
  return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit');
  return createTextModuleMock();
});

import { ArtifactsBrowserScreen } from './ArtifactsBrowserScreen';

// Keep the lazy executable graph's first load outside the operation's behavior deadline.
await import('@/sync/ops/actions/defaultActionExecutor');

const initialState = getStorage().getState();
let disposeHome: (() => Promise<void>) | undefined;
afterEach(async () => {
  await act(async () => {
    await disposeHome?.();
    disposeHome = undefined;
    retireActiveServerAccountScopeLifetime();
    invalidateAccountEncryptionModeCache();
    getStorage().setState(initialState, true);
  });
  vi.restoreAllMocks();
});

const SMALL = '11111111-1111-4111-8111-00000000000a';
const LARGE = '11111111-1111-4111-8111-00000000000b';
const UNKNOWN = '11111111-1111-4111-8111-00000000000c';
const storage = (bytes: number) =>
  formatHappierDataBytes(bytes, { kind: 'storage' });

function textOf(node: ReactTestInstance | null): string {
  if (node === null) return '';
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('');
}

/** The listed rows top to bottom, by the Collection's own row ids. */
function rowOrder(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
  const ids = screen
    .findAll(
      (node) =>
        typeof node.type === 'string' &&
        typeof node.props.testID === 'string' &&
        /^artifacts:row:[^:]+$/.test(node.props.testID),
    )
    .map((node) => String(node.props.testID).slice('artifacts:row:'.length));
  return [...new Set(ids)];
}

describe('Artifacts browser storage numbers (owner 11-19, audit 42a/42b)', () => {
  it("shows the Account total with no limit, each row's stored size, and Largest first with unknown sizes last", async () => {
    const accountId = 'owner';
    const inventory: StorageInventoryV1 = {
      totalBytes: 1_840_000_000,
      artifactLimitBytes: null,
      unmeasuredKinds: [],
      byKind: {
        artifacts: 1_620_000_000,
        pluginArtifacts: 0,
        discussionAttachments: 120_000_000,
        accountPets: 100_000_000,
        pluginCollections: 0,
      },
    };
    const row = (
      id: string,
      title: string,
      updatedAt: number,
      storedSizeBytes?: number,
    ) => ({
      id,
      ownerAccountId: accountId,
      access: 'owner' as const,
      kind: 'other' as const,
      kindHint: 'markdown',
      encryptionMode: 'plain' as const,
      publicAudience: 'none' as const,
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: encodePlainArtifactStoredContent({ kind: 'markdown', title }),
      headerVersion: 1,
      bodyVersion: 1,
      seq: updatedAt,
      createdAt: updatedAt,
      updatedAt,
      ...(storedSizeBytes === undefined ? {} : { storedSizeBytes }),
    });
    // Newest first by default: the unknown-size row leads, the largest sits last.
    const rows = [
      row(UNKNOWN, 'Pricing page copy', 3),
      row(SMALL, 'Staging release checklist', 2, 96_000),
      row(LARGE, 'Q4 launch plan', 1, 192_000_000),
    ];
    const served = await serveActionHomes({
      homes: [
        {
          key: 'owner',
          serverUrl: 'https://artifact-storage-numbers.test',
          accountId,
        },
      ],
      route: (request) => {
        if (request.path === '/v1/artifacts/storage/usage')
          return Response.json(inventory);
        if (request.path === '/v1/artifacts' && request.method === 'GET')
          return createArtifactListHttpResponse(request.url, rows);
        return undefined;
      },
    });
    disposeHome = served.dispose;
    const disconnect = await served.restoreActiveConnection();
    // This device chose the list: a wide page draws it as the table, whose end column is Size.
    getStorage().setState((state) => ({
      localSettings: { ...state.localSettings, artifactsBrowserViewV1: { presentation: 'list' } },
    }));
    try {
      const screen = await renderScreen(
        <AppPaneProvider>
          <ArtifactsBrowserScreen />
        </AppPaneProvider>,
      );
      try {
        await act(async () => {
          invokeTestInstanceHandler(
            screen.findHostByTestId('artifacts:collection:stage'),
            'onLayout',
            {
              nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } },
            },
          );
        });
        // No limit set: the Account total stands in the meter's place; there is no meter to fill.
        await vi.waitFor(() =>
          expect(
            textOf(screen.findHostByTestId('artifacts:storageTotal')),
          ).toContain(
            `artifacts.browser.storage.total(size=${storage(inventory.totalBytes)})`,
          ),
        );
        expect(screen.findHostByTestId('artifacts:storageMeter')).toBeNull();
        // Every row says its stored size; one the Home has not measured says so with a dash.
        await vi.waitFor(() =>
          expect(
            textOf(screen.findHostByTestId(`artifacts:row:${LARGE}:size`)),
          ).toBe(storage(192_000_000)),
        );
        expect(
          textOf(screen.findHostByTestId(`artifacts:row:${SMALL}:size`)),
        ).toBe(storage(96_000));
        expect(
          textOf(screen.findHostByTestId(`artifacts:row:${UNKNOWN}:size`)),
        ).toBe('—');
        expect(rowOrder(screen)).toEqual([UNKNOWN, SMALL, LARGE]);

        const sort = screen
          .findAll((node) => node.props.filter?.testID === 'artifacts:sort')
          .at(0);
        expect(
          sort?.props.filter.options.map((option: { id: string }) => option.id),
        ).toContain('size_desc');
        await act(async () => {
          sort!.props.filter.onChange('size_desc');
        });
        expect(rowOrder(screen)).toEqual([LARGE, SMALL, UNKNOWN]);
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  });
});
