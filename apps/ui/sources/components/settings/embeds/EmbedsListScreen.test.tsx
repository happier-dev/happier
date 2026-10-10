import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildEmbedParentGrantV1 } from '@happier-dev/protocol/embed';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import {
  createApiTokenSettingsControllerHarness,
  disposeApiTokenSettingsControllerHarnesses,
} from '../apiTokens/apiTokenSettingsControllerTestHarness';
import { DEFAULT_EMBED_DRAFT } from './embedDraft';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('react-native-gesture-handler', async () => {
  const { createGestureHandlerMock } =
    await import('@/dev/testkit/mocks/gestureHandler');
  return createGestureHandlerMock();
});

vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  return createReanimatedModuleMock();
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock().module;
});

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});

// The preview is an isolated frame host (iframe on web, WebView on native); the list only shows it as art.
vi.mock('./EmbedLivePreview', () => ({ EmbedLivePreview: () => null }));

const EMBED_ID = '33333333-3333-4333-8333-333333333333';

function embedRow(): Record<string, unknown> {
  const access = {
    ...DEFAULT_EMBED_DRAFT.access,
    sites: ['https://crm.acme.dev'],
    send: true,
  };
  return {
    tokenId: EMBED_ID,
    label: 'Leads dashboard',
    displayPrefix: 'hap_v1_33333333',
    createdAt: '2026-09-24T10:00:00.000Z',
    lastUsedAt: null,
    expiresAt: null,
    hasEncryptionAccess: false,
    hasUnattendedTeamAccess: false,
    grant: buildEmbedParentGrantV1(access, DEFAULT_EMBED_DRAFT.config),
    parentTokenId: null,
    activeChildCount: 0,
    embedConfig: DEFAULT_EMBED_DRAFT.config,
  };
}

// The real store, controller and Action graph need a longer cold-transform budget on shared workers.
beforeAll(async () => {
  await import('@/sync/domains/state/storageStore');
  await import('@/sync/ops/actions/defaultActionExecutor');
  await import('./EmbedsListScreen');
}, 600_000);

afterEach(async () => {
  await disposeApiTokenSettingsControllerHarnesses();
  standardCleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function until(assertion: () => void): Promise<void> {
  await vi.waitFor(
    async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assertion();
    },
    { timeout: 30_000 },
  );
}

describe('Settings → Embeds list (real token controller)', () => {
  it('keeps the last embeds after a failed refresh and says so in one line with Retry (lab L3)', async () => {
    const harness = await createApiTokenSettingsControllerHarness({
      mode: 'plain',
      rows: [embedRow()],
    });
    const { ApiTokenSettingsScope } =
      await import('../apiTokens/collection/ApiTokenSettingsScope');
    const { EmbedsListScreen } = await import('./EmbedsListScreen');
    const screen = await renderScreen(
      <ApiTokenSettingsScope controller={harness.controller}>
        <EmbedsListScreen />
      </ApiTokenSettingsScope>,
    );
    await until(() =>
      expect(
        screen.findByTestId(`settings-embeds-row:${EMBED_ID}`),
      ).toBeTruthy(),
    );
    expect(screen.findByTestId('settings-embeds-refresh-stale')).toBeNull();

    harness.setListAvailable(false);
    await act(async () => {
      await harness.controller.refresh();
    });

    // Last-known-good rows stay; the failure is one quiet line with its Retry, not a vanished error.
    expect(screen.findByTestId(`settings-embeds-row:${EMBED_ID}`)).toBeTruthy();
    expect(screen.findByTestId('settings-embeds-refresh-stale')).toBeTruthy();
    expect(screen.findByTestId('settings-embeds-list-error')).toBeNull();

    harness.setListAvailable(true);
    await act(async () => {
      screen.pressByTestId('settings-embeds-refresh-stale-action');
    });
    await until(() =>
      expect(screen.findByTestId('settings-embeds-refresh-stale')).toBeNull(),
    );
    expect(screen.findByTestId(`settings-embeds-row:${EMBED_ID}`)).toBeTruthy();
  }, 180_000);
});
