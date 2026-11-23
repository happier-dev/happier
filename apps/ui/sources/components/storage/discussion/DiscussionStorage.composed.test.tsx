import * as React from 'react';
import { Dimensions } from 'react-native';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import type {
  StorageInventoryItemV1,
  StorageInventoryV1,
} from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import {
  getActiveServerAccountScope,
  retireActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import {
  PaneHeaderSlotProvider,
  PaneHeaderSlotScope,
  usePublishedPaneHeaderContent,
} from '@/components/appShell/panes/paneHeaderSlot';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';

// Navigation is the platform boundary: the route's params are the router's, and a press is a push.
const routerMock = vi.hoisted(() => ({
  spies: null as unknown as { push: ReturnType<typeof vi.fn> },
  state: {
    pathname: '/discussions/discussion-1',
    params: {} as Record<string, string>,
  },
}));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit');
  const mock = createExpoRouterMock({
    pathname: () => routerMock.state.pathname,
    params: () => routerMock.state.params,
  });
  routerMock.spies = mock.spies;
  return mock.module;
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit');
  return createModalModuleMock({ confirmResult: true }).module;
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit');
  return createTextModuleMock();
});

import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { DiscussionDetailsPanel } from '@/components/discussions/DiscussionDetailsPanel';
import { buildDiscussionStorageRouteHref } from '@/components/discussions/discussionRoutes';
import { WorkspaceRouteBody as DiscussionStorageRoute } from '@/app/(app)/discussions/storage';
import type { DiscussionStorageSource } from './DiscussionStorage';

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
  routerMock.state = { pathname: '/discussions/discussion-1', params: {} };
  vi.restoreAllMocks();
});

const ACCOUNT = 'viewer';
const DISCUSSION = 'discussion-1';
const VIDEO = '44444444-4444-4444-8444-000000000001';
const TRACE = '44444444-4444-4444-8444-000000000002';
const ORPHAN = '44444444-4444-4444-8444-000000000003';
const MB = 1_000_000;
const storage = (bytes: number) =>
  formatHappierDataBytes(bytes, { kind: 'storage' });

/** The Discussion's files as the storage read owner reports them, with its own admission per row. */
const PAGE_1: StorageInventoryItemV1[] = [
  {
    id: VIDEO,
    kind: 'discussionAttachments',
    storedSizeBytes: 64.2 * MB,
    createdAt: 1,
    viewerMayRemove: false,
    location: {
      kind: 'discussion',
      discussionId: DISCUSSION,
      messageId: 'message-1',
      attachmentId: VIDEO,
    },
  },
  {
    id: TRACE,
    kind: 'discussionAttachments',
    storedSizeBytes: 9.8 * MB,
    createdAt: 2,
    viewerMayRemove: true,
    location: {
      kind: 'discussion',
      discussionId: DISCUSSION,
      messageId: 'message-2',
      attachmentId: TRACE,
    },
  },
];
// A file whose message this device has not loaded, and whose admission the server left out.
const PAGE_2: StorageInventoryItemV1[] = [
  {
    id: ORPHAN,
    kind: 'discussionAttachments',
    storedSizeBytes: 3.6 * MB,
    createdAt: 3,
    location: {
      kind: 'discussion',
      discussionId: DISCUSSION,
      messageId: 'message-9',
      attachmentId: ORPHAN,
    },
  },
];

function summary(totalBytes: number): StorageInventoryV1 {
  return {
    totalBytes,
    artifactLimitBytes: null,
    unmeasuredKinds: [],
    byKind: {
      artifacts: 0,
      pluginArtifacts: 0,
      discussionAttachments: totalBytes,
      accountPets: 0,
      pluginCollections: 0,
    },
  };
}

const fileMessage = (
  id: string,
  authorAccountId: string,
  blobId: string,
  name: string,
  sizeBytes: number,
) => ({
  id,
  authorAccountId,
  accountActor: null,
  createdAt: 1,
  content: {
    v: 1 as const,
    parts: [
      {
        t: 'attachment' as const,
        attachment: {
          kind: 'file' as const,
          id: blobId,
          name,
          file: {
            blobId,
            mime: 'application/octet-stream',
            sizeBytes,
            sha256: 'a'.repeat(64),
          },
        },
      },
    ],
  },
});

const MESSAGES = [
  fileMessage('message-1', 'mika', VIDEO, 'checkout-bug-repro.mov', 64.2 * MB),
  fileMessage('message-2', ACCOUNT, TRACE, 'network-trace.har', 9.8 * MB),
];

/** The same messages as the Home stores them in a plain Discussion, for its exact message read. */
const toWire = (message: (typeof MESSAGES)[number], seq: number) => ({
  ...message,
  discussionId: DISCUSSION,
  localId: null,
  seq,
  accountActor: {
    v: 1 as const,
    accountId: message.authorAccountId,
    profile: { name: message.authorAccountId === ACCOUNT ? 'Leeroy' : 'Mika Tanaka', firstName: null, lastName: null, username: null, avatarUrl: null },
  },
  producerV1: null,
  content: { t: 'plain' as const, v: message.content },
  mentionedAccountIds: [],
});
// The open thread's window starts at seq 2; the older message below it is seq 1.
const WIRE_MESSAGES = MESSAGES.map((message, index) => toWire(message, index + 2));
/** An older message, outside the window the open thread has loaded, that carries the second page's file. */
const OFF_WINDOW_MESSAGE = toWire(fileMessage('message-9', 'mika', ORPHAN, 'load-test-results.csv', 3.6 * MB), 1);

let scopedReads: URL[] = [];
let accountReads = 0;
let removals: string[] = [];
/** Every exact message read (`POST /v1/discussions/messages/read`), with the pairs it asked for. */
let exactReads: Array<ReadonlyArray<Readonly<{ discussionId: string; messageId: string }>>> = [];

async function serve(options: Readonly<{ offWindowReadable?: boolean }> = {}) {
  const readable = options.offWindowReadable ? [...WIRE_MESSAGES, OFF_WINDOW_MESSAGE] : WIRE_MESSAGES;
  scopedReads = [];
  accountReads = 0;
  removals = [];
  exactReads = [];
  const served = await serveActionHomes({
    homes: [
      {
        key: 'owner',
        serverUrl: 'https://discussion-storage.test',
        accountId: ACCOUNT,
      },
    ],
    route: (request) => {
      if (
        request.path === '/v1/features' ||
        request.path === '/v1/features/authenticated'
      ) {
        const features = createRootLayoutFeaturesResponse();
        for (const id of [
          'sharing.session',
          'sharing.public',
          'sessions.conversations',
          'teams',
        ] as const)
          tryWriteServerEnabledBitInPlace(features, id, true);
        return Response.json(features);
      }
      if (request.path === '/v1/artifacts/storage/usage') {
        if (request.url.searchParams.get('discussionId') !== DISCUSSION) {
          accountReads += 1;
          return Response.json({ ...summary(1_840 * MB), page: { items: [] } });
        }
        scopedReads.push(request.url);
        const second = request.url.searchParams.get('cursor') === 'page-2';
        return Response.json({
          ...summary(77.6 * MB),
          // The scope's whole count, across both pages.
          kinds: { discussionAttachments: { storedSizeBytes: 77.6 * MB, itemCount: 3 } },
          page: second
            ? { items: PAGE_2 }
            : { items: PAGE_1, nextCursor: 'page-2' },
        });
      }
      if (request.path === '/v1/discussions/messages/read' && request.method === 'POST') {
        const asked = (request.body as { messages: Array<{ discussionId: string; messageId: string }> }).messages;
        exactReads.push(asked);
        // Unless the case makes it readable, `message-9` is not readable by this viewer: the Home leaves it out.
        const messages = readable.filter((message) => asked.some((pair) => pair.discussionId === DISCUSSION && pair.messageId === message.id));
        return Response.json({ discussions: messages.length === 0 ? [] : [{ discussionId: DISCUSSION,
          titleContent: { t: 'plain', v: { v: 1, title: 'Checkout bug triage' } },
          keyContext: { encryptionMode: 'plain', keyReadiness: true, dataEncryptionKey: null }, messages }] });
      }
      if (
        request.method === 'DELETE' &&
        request.path.includes('/attachments/')
      ) {
        removals.push(request.path);
        return Response.json({
          blobId: TRACE,
          removedByAccountId: ACCOUNT,
          removedAt: 5,
        });
      }
      return undefined;
    },
  });
  disposeHome = served.dispose;
  return served.restoreActiveConnection();
}

function textOf(node: ReactTestInstance | null): string {
  if (node === null) return '';
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('');
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/** Each file row's "…" menu ids, by row key. */
function rowMenus(screen: Screen): Map<string, string[]> {
  const menus = new Map<string, string[]>();
  for (const key of [VIDEO, TRACE, ORPHAN]) {
    const row = screen
      .findAll((node) => node.props.testID === `storage:discussion:file:${key}`)
      .at(0);
    if (!row) continue;
    const menu = row
      .findAll(
        (node) =>
          Array.isArray(node.props.items) &&
          typeof node.props.onSelect === 'function' &&
          node.props.triggerIcon === 'more',
      )
      .at(0);
    menus.set(
      key,
      menu
        ? (menu.props.items as Array<{ id: string }>).map((item) => item.id)
        : [],
    );
  }
  return menus;
}

async function layOut(screen: Screen) {
  await vi.waitFor(() =>
    expect(
      screen.findHostByTestId('storage:discussion:files:stage'),
    ).not.toBeNull(),
  );
  await act(async () => {
    invokeTestInstanceHandler(
      screen.findHostByTestId('storage:discussion:files:stage'),
      'onLayout',
      { nativeEvent: { layout: { x: 0, y: 0, width: 340, height: 800 } } },
    );
  });
}

/** The pane's header band reads what the open tab publishes (the right sidebar's `RightSidebarPaneHeader`). */
function HeaderProbe(
  props: Readonly<{
    onRead: (content: ReturnType<typeof usePublishedPaneHeaderContent>) => void;
  }>,
) {
  props.onRead(usePublishedPaneHeaderContent('discussionDetails'));
  return null;
}

function source(ownerAccountId = ACCOUNT): DiscussionStorageSource {
  const scope = getActiveServerAccountScope();
  if (!scope) throw new Error('No active Account');
  return {
    scope,
    discussionId: DISCUSSION,
    ownerAccountId,
    title: 'Checkout bug triage',
    messages: MESSAGES,
    authorLabel: (message) =>
      message.authorAccountId === ACCOUNT ? 'You' : 'Mika Tanaka',
  };
}

describe('Storage from a Discussion’s Details (storage-view lab scene 5 A)', () => {
  it('shows the Discussion’s stored size in Details and opens its files in the pane, one scoped read per page', async () => {
    const disconnect = await serve({ offWindowReadable: true });
    let header: ReturnType<typeof usePublishedPaneHeaderContent> = null;
    try {
      const screen = await renderScreen(
        <AppPaneProvider>
          <SurfaceStateSizeProvider size="pane">
            <PaneHeaderSlotProvider>
              <PaneHeaderSlotScope slotKey="discussionDetails">
                <HeaderProbe
                  onRead={(content) => {
                    header = content;
                  }}
                />
                <DiscussionDetailsPanel actions={[]} storage={source()} />
              </PaneHeaderSlotScope>
            </PaneHeaderSlotProvider>
          </SurfaceStateSizeProvider>
        </AppPaneProvider>,
      );
      try {
        // The row says the scoped read's own total; it never sums the files.
        await vi.waitFor(() =>
          expect(
            textOf(screen.findHostByTestId('discussion-details-storage')),
          ).toContain(
            `artifacts.browser.storageView.discussion.row(size=${storage(77.6 * MB)})`,
          ),
        );
        expect(scopedReads).toHaveLength(1);
        expect(accountReads).toBe(0);

        await act(async () => {
          invokeTestInstanceHandler(
            screen.findHostByTestId('discussion-details-storage'),
            'onPress',
          );
        });
        // The same view, in the pane, under a band that names it and goes back to Details.
        await vi.waitFor(() =>
          expect(screen.findHostByTestId('storage:discussion')).not.toBeNull(),
        );
        expect(header?.subpage?.title).toBe(
          'artifacts.browser.storageView.title',
        );
        await vi.waitFor(() =>
          expect(
            textOf(screen.findHostByTestId('storage:discussion:share-figure')),
          ).toContain(storage(1_840 * MB)),
        );
        expect(scopedReads).toHaveLength(1);
        await layOut(screen);
        // Names come from the loaded messages by the item's triple.
        await vi.waitFor(() =>
          expect(
            textOf(screen.findHostByTestId(`storage:discussion:file:${VIDEO}`)),
          ).toContain('checkout-bug-repro.mov'),
        );
        expect(
          textOf(screen.findHostByTestId(`storage:discussion:file:${TRACE}`)),
        ).toContain('network-trace.har');
        // The sentence counts the scope's files from the read's own count (3), not the page's rows (2).
        expect(textOf(screen.findHostByTestId('storage:discussion:say'))).toContain(
          `artifacts.browser.storageView.discussion.say(size=${storage(77.6 * MB)},count=3)`,
        );
        // The owner's share row says whose total it is; the sentence keeps its ordinary body.
        expect(textOf(screen.findHostByTestId('storage:discussion:say'))).not.toContain(
          'artifacts.browser.storageView.discussion.sayVisible',
        );
        // Remove is offered only where the server admits it.
        expect(rowMenus(screen).get(VIDEO)).not.toContain('remove');
        expect(rowMenus(screen).get(TRACE)).toContain('remove');
        // Every message on this page is already in the open thread: no message read.
        expect(exactReads).toHaveLength(0);

        await act(async () => {
          invokeTestInstanceHandler(
            screen.findHostByTestId('storage:discussion:more'),
            'onPress',
          );
        });
        await vi.waitFor(() =>
          expect(
            screen.findHostByTestId(`storage:discussion:file:${ORPHAN}`),
          ).not.toBeNull(),
        );
        expect(scopedReads).toHaveLength(2);
        expect(scopedReads[1]!.searchParams.get('cursor')).toBe('page-2');
        // The next page's file lives in an older message the open thread has not loaded: one batched read asks for
        // only that message, and the row takes the file's real name and sender from it.
        await vi.waitFor(() =>
          expect(
            textOf(screen.findHostByTestId(`storage:discussion:file:${ORPHAN}`)),
          ).toContain('load-test-results.csv'),
        );
        expect(textOf(screen.findHostByTestId(`storage:discussion:file:${ORPHAN}`))).toContain('Mika Tanaka');
        expect(exactReads).toEqual([[{ discussionId: DISCUSSION, messageId: 'message-9' }]]);
        expect(scopedReads).toHaveLength(2);
        expect(rowMenus(screen).get(ORPHAN)).not.toContain('remove');

        const traceMenu = screen
          .findAll(
            (node) =>
              Array.isArray(node.props.items) &&
              typeof node.props.onSelect === 'function' &&
              (node.props.items as Array<{ id: string }>).some(
                (item) => item.id === 'remove',
              ),
          )
          .at(0)!;
        await act(async () => {
          await traceMenu.props.onSelect('remove');
        });
        await vi.waitFor(() =>
          expect(removals.some((path) => path.includes(TRACE))).toBe(true),
        );

        await act(async () => {
          header!.subpage!.onBack();
        });
        await vi.waitFor(() =>
          expect(
            screen.findHostByTestId('discussion-details-storage'),
          ).not.toBeNull(),
        );
        expect(screen.findHostByTestId('storage:discussion')).toBeNull();
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  });

  it('shows shared Discussion bytes without treating them as part of the participant’s Account', async () => {
    const disconnect = await serve();
    try {
      const shared = source('another-account');
      const screen = await renderScreen(
        <AppPaneProvider>
          <SurfaceStateSizeProvider size="pane">
            <DiscussionDetailsPanel actions={[]} storage={shared} />
          </SurfaceStateSizeProvider>
        </AppPaneProvider>,
      );
      try {
        await act(async () => {
          invokeTestInstanceHandler(
            screen.findHostByTestId('discussion-details-storage'),
            'onPress',
          );
        });
        await vi.waitFor(() =>
          expect(textOf(screen.findHostByTestId('storage:discussion'))).toContain(storage(77.6 * MB)),
        );
        expect(screen.findHostByTestId('storage:discussion:share-figure')).toBeNull();
        // A participant's total counts only the files on messages they can read: the pane says whose total it is.
        expect(textOf(screen.findHostByTestId('storage:discussion:say'))).toContain(
          'artifacts.browser.storageView.discussion.sayVisible(title=Checkout bug triage)',
        );
        expect(textOf(screen.findHostByTestId('storage:discussion:say'))).not.toContain(
          'artifacts.browser.storageView.discussion.sayBody',
        );
        expect(accountReads).toBe(0);
        expect(scopedReads).toHaveLength(1);
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  });

  it('on a phone pushes the Storage page, which reads the Discussion’s scope once per page', async () => {
    const disconnect = await serve();
    try {
      const details = await renderScreen(
        <AppPaneProvider>
          <SurfaceStateSizeProvider size="phone">
            <DiscussionDetailsPanel actions={[]} storage={source()} />
          </SurfaceStateSizeProvider>
        </AppPaneProvider>,
      );
      let href = '';
      try {
        await vi.waitFor(() =>
          expect(
            textOf(details.findHostByTestId('discussion-details-storage')),
          ).toContain(storage(77.6 * MB)),
        );
        await act(async () => {
          invokeTestInstanceHandler(
            details.findHostByTestId('discussion-details-storage'),
            'onPress',
          );
        });
        expect(details.findHostByTestId('storage:discussion')).toBeNull();
        href = String(routerMock.spies.push.mock.calls.at(-1)?.[0] ?? '');
      } finally {
        await details.unmount();
      }
      const url = new URL(href, 'https://app.test');
      expect(url.pathname).toBe('/discussions/storage');
      expect(url.searchParams.get('discussionId')).toBe(DISCUSSION);

      scopedReads = [];
      routerMock.state = {
        pathname: url.pathname,
        params: Object.fromEntries(url.searchParams),
      };
      const page = await renderScreen(
        <AppPaneProvider>
          <DiscussionStorageRoute />
        </AppPaneProvider>,
      );
      try {
        await layOut(page);
        await vi.waitFor(() =>
          expect(
            page.findHostByTestId(`storage:discussion:file:${TRACE}`),
          ).not.toBeNull(),
        );
        expect(scopedReads).toHaveLength(1);
        // This device holds no thread for it: one exact read names the page's files, their senders and the Discussion.
        await vi.waitFor(() => expect(textOf(page.findHostByTestId(`storage:discussion:file:${VIDEO}`))).toContain('checkout-bug-repro.mov'));
        expect(textOf(page.findHostByTestId(`storage:discussion:file:${VIDEO}`))).toContain('Mika Tanaka');
        expect(textOf(page.findHostByTestId(`storage:discussion:file:${TRACE}`))).toContain('network-trace.har');
        expect(textOf(page.findHostByTestId('storage:discussion'))).toContain(
          'artifacts.browser.storageView.discussion.descriptionNamed(title=Checkout bug triage)');
        expect(exactReads).toEqual([[{ discussionId: DISCUSSION, messageId: 'message-1' }, { discussionId: DISCUSSION, messageId: 'message-2' }]]);
        // The next page asks only for its own message; the Home leaves it out, so that row keeps the kind's name.
        await act(async () => { invokeTestInstanceHandler(page.findHostByTestId('storage:discussion:more'), 'onPress'); });
        await vi.waitFor(() => expect(exactReads).toHaveLength(2));
        expect(exactReads[1]).toEqual([{ discussionId: DISCUSSION, messageId: 'message-9' }]);
        await vi.waitFor(() => expect(textOf(page.findHostByTestId(`storage:discussion:file:${ORPHAN}`))).toContain(
          'artifacts.browser.storageView.items.titles.discussionAttachments'));
        expect(scopedReads).toHaveLength(2);
        // The phone page has no share of the Account, so it reads nothing else.
        expect(page.findHostByTestId('storage:discussion:share')).toBeNull();
        expect(rowMenus(page).get(VIDEO)).not.toContain('remove');
        expect(rowMenus(page).get(TRACE)).toContain('remove');
      } finally {
        await page.unmount();
      }
    } finally {
      await disconnect();
    }
  });

  it('heads the phone’s pushed page with a Back that names the Discussion, and keeps each file’s “…”', async () => {
    // A phone window: the workspace hosts the pushed page under its own navigation bar.
    vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 2, fontScale: 1 });
    const disconnect = await serve();
    try {
      const scope = getActiveServerAccountScope();
      if (!scope) throw new Error('No active Account');
      const url = new URL(buildDiscussionStorageRouteHref({ serverId: scope.serverId, discussionId: DISCUSSION }), 'https://app.test');
      const params = Object.fromEntries(url.searchParams);
      routerMock.state = { pathname: url.pathname, params };
      const back = vi.fn();
      const page = await renderScreen(
        <AppPaneProvider>
          <DestinationInstanceHost tabId="discussion-storage" phone ref={{ kind: 'discussionStorage', params }}
            pathname={url.pathname} focused visible
            navigation={{ push: () => {}, replace: () => {}, back, canGoBack: () => true }}>
            <DiscussionStorageRoute />
          </DestinationInstanceHost>
        </AppPaneProvider>,
      );
      try {
        await layOut(page);
        await vi.waitFor(() => expect(page.findHostByTestId(`storage:discussion:file:${TRACE}`)).not.toBeNull());
        // The bar names where Back returns: a Discussion this device has not loaded is named by the page's exact read.
        await vi.waitFor(() => expect(textOf(page.findHostByTestId('workspace-destination-header'))).toContain('Checkout bug triage'));
        const bar = page.findHostByTestId('workspace-destination-header');
        const backButton = bar!.findAll((node) => node.props.accessibilityLabel === 'common.back'
          && typeof node.props.onPress === 'function').at(0);
        expect(backButton).toBeDefined();
        await act(async () => { invokeTestInstanceHandler(backButton!, 'onPress'); });
        expect(back).toHaveBeenCalledTimes(1);
        expect(rowMenus(page).get(VIDEO)).toEqual(expect.arrayContaining(['show']));
        expect(rowMenus(page).get(TRACE)).toContain('remove');
      } finally {
        await page.unmount();
      }
    } finally {
      await disconnect();
    }
  });
});
