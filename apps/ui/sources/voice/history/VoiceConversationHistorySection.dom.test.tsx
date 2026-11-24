/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_LIST_PAGE_DEFAULT_LIMIT, SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { encodeV2SessionListCursorV1 } from '@happier-dev/protocol/sessions/control/contract';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import {
  useVoiceConversationHistoryRows,
  type VoiceHistoryPageRow,
} from './VoiceConversationHistorySection';
import { createVoiceHistoryListRowFixture } from './voiceConversationHistory.testkit';
import {
  createVoiceSettingsAccountTestHarness,
  type VoiceSettingsAccountTestHarness,
} from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import {
  configureConnectedServerSocketBoundary,
  installDisconnectedServerSocketBoundary,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('socket.io-client', async (original) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(original),
);

describe('Voice History conversation section states', () => {
  let account: VoiceSettingsAccountTestHarness;
  beforeEach(async () => {
    installDisconnectedServerSocketBoundary(
      configureConnectedServerSocketBoundary,
    );
    account = await createVoiceSettingsAccountTestHarness(settingsParse({}), {
      features: createRootLayoutFeaturesResponse({
        features: {
          sessions: { enabled: true, filteredListing: { enabled: true } },
        },
      }),
    });
    await getServerFeaturesSnapshot({
      serverId: account.scope.serverId,
      force: true,
    });
    const { sync } = await import('@/sync/sync');
    await waitForHomeGovernance(() =>
      expect(storage.getState().isDataReady).toBe(true),
    );
    await sync.refreshSessions();
  });
  afterEach(async () => {
    await account?.dispose();
    installDisconnectedServerSocketBoundary();
  });

  it('keeps loading through pages without Voice conversations before showing the settled empty state', async () => {
    const ordinary = await Promise.all(Array.from({ length: SESSION_LIST_PAGE_DEFAULT_LIMIT }, (_, index) =>
      createVoiceHistoryListRowFixture(
        createSessionFixture({
          id: `ordinary-${index}`,
          metadata: { ...createSessionFixture().metadata!, name: `ordinary-${index}` },
        }),
        { credentials: account.credentials },
      ),
    ));
    const firstPage = createDeferred<void>();
    const continuation = createDeferred<void>();
    const ordinaryCursor = encodeV2SessionListCursorV1('ordinary');
    let continuationRequested = false;
    const request = account.request.getMockImplementation()!;
    account.request.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === '/v2/sessions/query') {
        const query = SessionListQueryV1Schema.parse(
          JSON.parse(String(init?.body)),
        );
        const first = query.storage === 'active' && !query.cursor;
        if (first) await firstPage.promise;
        if (query.storage === 'active' && query.cursor === ordinaryCursor) {
          continuationRequested = true;
          await continuation.promise;
        }
        return Response.json({
          sessions: first ? ordinary : [],
          nextCursor: first ? ordinaryCursor : null,
          hasNext: first,
          attentionNextCursor: null,
          attentionHasNext: false,
        });
      }
      return request(input, init);
    });
    const environment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousAct = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const state: { rows: readonly VoiceHistoryPageRow[] } = { rows: [] };
    const noop = () => {};
    function Host() {
      state.rows = useVoiceConversationHistoryRows({
        onContinue: noop,
        onOpen: noop,
      });
      return null;
    }
    const keys = () => state.rows.map((row) => row.key);
    try {
      await act(async () => root.render(<Host />));
      expect(keys()).toEqual(['conversations:loading']);

      await act(async () => firstPage.resolve());
      await waitForHomeGovernance(() => expect(continuationRequested).toBe(true));
      expect(keys()).toEqual(['conversations:loading']);

      await act(async () => continuation.resolve());
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        expect(keys()).toEqual(['conversations:empty']);
      });
    } finally {
      firstPage.resolve();
      continuation.resolve();
      await act(async () => root.unmount());
      container.remove();
      environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
      account.request.mockImplementation(request);
    }
  });
});
