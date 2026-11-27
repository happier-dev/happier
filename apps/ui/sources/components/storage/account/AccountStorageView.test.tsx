import * as React from 'react';
import { Dimensions } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import type { StorageInventoryV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
} from '@happier-dev/protocol/storage/artifactStoredContent';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactListHttpResponse, createArtifactReadBatchHttpResponse } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';

// Navigation is the platform boundary: the route's params and pathname are the router's, and a press is a push.
const routerMock = vi.hoisted(() => ({
  spies: null as unknown as { push: ReturnType<typeof vi.fn> },
  state: {
    pathname: '/settings/storage',
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

import { WorkspaceRouteBody as StorageSettingsRoute } from '@/app/(app)/settings/storage';
import { ArtifactsBrowserScreen } from '@/components/artifacts/ArtifactsBrowserScreen';
import { StorageSpecimen } from '@/components/dev/storage/StorageSpecimen';

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
  routerMock.state = { pathname: '/settings/storage', params: {} };
  vi.restoreAllMocks();
});

const ACCOUNT = 'owner';
const LARGE = '22222222-2222-4222-8222-00000000000a';
const SMALL = '22222222-2222-4222-8222-00000000000b';
const UNKNOWN = '22222222-2222-4222-8222-00000000000c';
const SHARED = '22222222-2222-4222-8222-00000000000d';
const storage = (bytes: number) =>
  formatHappierDataBytes(bytes, { kind: 'storage' });

function inventory(artifactLimitBytes: number | null): StorageInventoryV1 {
  return {
    totalBytes: 265_000_000,
    artifactLimitBytes,
    unmeasuredKinds: ['profilePictures'],
    byKind: {
      artifacts: 200_000_000,
      pluginArtifacts: 0,
      discussionAttachments: 50_000_000,
      accountPets: 10_000_000,
      pluginCollections: 5_000_000,
    },
  };
}

function artifactRow(
  id: string,
  title: string,
  updatedAt: number,
  storedSizeBytes?: number,
  access: 'owner' | 'view' = 'owner',
) {
  return {
    id,
    ownerAccountId: access === 'owner' ? ACCOUNT : 'someone-else',
    access,
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
  };
}

const ROWS = [
  artifactRow(UNKNOWN, 'Pricing page copy', 4),
  artifactRow(SMALL, 'Staging release checklist', 3, 96_000),
  artifactRow(LARGE, 'Q4 launch plan', 2, 192_000_000),
  // Shared with this Account: its bytes count toward its owner, so the view does not list it.
  artifactRow(SHARED, 'Partner deck', 1, 500_000_000, 'view'),
];

function textOf(node: ReactTestInstance | null): string {
  if (node === null) return '';
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('');
}

function itemOrder(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
  const ids = screen
    .findAll(
      (node) =>
        typeof node.type === 'string' &&
        typeof node.props.testID === 'string' &&
        /^storage:item:[^:]+$/.test(node.props.testID),
    )
    .map((node) => String(node.props.testID).slice('storage:item:'.length));
  return [...new Set(ids)];
}

/** The kind filter's chips as the view hands them to the shared tab bar. */
function filterBar(screen: Awaited<ReturnType<typeof renderScreen>>): ReactTestInstance {
  const bar = screen.findAll((node) => node.props.testIDPrefix === 'storage:filter' && Array.isArray(node.props.tabs)).at(0);
  if (!bar) throw new Error('No kind filter');
  return bar;
}
function filterTabs(screen: Awaited<ReturnType<typeof renderScreen>>): Array<Readonly<{ id: string; count?: string }>> {
  return filterBar(screen).props.tabs as Array<Readonly<{ id: string; count?: string }>>;
}

/** Every storage inventory read the view made, in order (the count contract: one read per page). */
let inventoryReads: URL[] = [];
let artifactListReads = 0;
/** The view's own gestures reach the Home only through their Actions' requests. */
let mutations: Array<Readonly<{ method: string; path: string }>> = [];
const BLOB = '33333333-3333-4333-8333-000000000001';
/** Someone else's file in a Discussion this Account can see: the server does not admit its removal. */
const OTHER_BLOB = '33333333-3333-4333-8333-000000000002';
/** 30 more small Artifacts the Account owns: the view's reads must not grow with them. */
const MANY = Array.from({ length: 30 }, (_, index) =>
  artifactRow(`22222222-2222-4222-8222-1000000000${String(index).padStart(2, '0')}`, `Note ${index}`, 10 + index, 1_000));
// Each row carries the server's own admission (`viewerMayRemove`, `viewerMayTrim`); a false or absent fact offers nothing.
const PAGE_1 = [
  { id: LARGE, kind: 'artifacts' as const, storedSizeBytes: 192_000_000, createdAt: 2, location: { kind: 'artifact' as const, artifactId: LARGE } },
  { id: BLOB, kind: 'discussionAttachments' as const, storedSizeBytes: 50_000_000, createdAt: 3, viewerMayRemove: true,
    location: { kind: 'discussion' as const, discussionId: 'discussion-1', messageId: 'message-1', attachmentId: BLOB } },
  { id: SMALL, kind: 'artifactOldVersions' as const, storedSizeBytes: 8_000_000, createdAt: 3, viewerMayTrim: true,
    location: { kind: 'artifact' as const, artifactId: SMALL } },
  { id: OTHER_BLOB, kind: 'discussionAttachments' as const, storedSizeBytes: 6_000_000, createdAt: 3, viewerMayRemove: false,
    location: { kind: 'discussion' as const, discussionId: 'discussion-1', messageId: 'message-2', attachmentId: OTHER_BLOB } },
  { id: LARGE, kind: 'artifactOldVersions' as const, storedSizeBytes: 4_000_000, createdAt: 2,
    location: { kind: 'artifact' as const, artifactId: LARGE } },
];
const PAGE_2 = [
  { id: UNKNOWN, kind: 'artifacts' as const, storedSizeBytes: null, createdAt: 4, location: { kind: 'artifact' as const, artifactId: UNKNOWN } },
];

/** Every exact Discussion message read the view made (`POST /v1/discussions/messages/read`), with its request body. */
let exactReads: Array<ReadonlyArray<Readonly<{ discussionId: string; messageId: string }>>> = [];
const actor = (accountId: string, name: string) => ({ v: 1 as const, accountId,
  profile: { name, firstName: null, lastName: null, username: null, avatarUrl: null } });
const MIKA = actor('mika', 'Mika Tanaka');
const SELF = actor(ACCOUNT, 'Leeroy');
/** One message carrying files, as the Home stores it in a plain Discussion. */
function wireMessage(discussionId: string, id: string, seq: number, author: ReturnType<typeof actor>, files: ReadonlyArray<readonly [string, string]>) {
  return { id, discussionId, localId: null, seq, authorAccountId: author.accountId, accountActor: author, producerV1: null,
    content: { t: 'plain', v: { v: 1, parts: files.map(([blobId, name]) => ({ t: 'attachment', attachment: { kind: 'file', id: blobId, name,
      file: { blobId, mime: 'application/octet-stream', sizeBytes: 1_000, sha256: 'a'.repeat(64) } } })) } },
    mentionedAccountIds: [], createdAt: 1 };
}
const BLOB3 = '33333333-3333-4333-8333-000000000003';
const BLOB4 = '33333333-3333-4333-8333-000000000004';
const BLOB5 = '33333333-3333-4333-8333-000000000005';
const BLOB6 = '33333333-3333-4333-8333-000000000006';
/** The Discussions the Home holds; `message-2` is not readable by this viewer, so the Home leaves it out. */
const DISCUSSIONS = [
  { id: 'discussion-1', title: 'Checkout bug triage', messages: [wireMessage('discussion-1', 'message-1', 1, MIKA, [[BLOB, 'checkout-bug-repro.mov']])] },
  { id: 'discussion-2', title: 'Release planning', messages: [wireMessage('discussion-2', 'message-3', 1, SELF,
    [[BLOB3, 'api-trace-export.har'], [BLOB5, 'release-notes.md']])] },
  { id: 'discussion-3', title: 'Pricing page copy', messages: [wireMessage('discussion-3', 'message-4', 1, MIKA, [[BLOB4, 'pricing-draft.pdf']])] },
  { id: 'discussion-4', title: 'Onboarding video', messages: [wireMessage('discussion-4', 'message-5', 1, MIKA, [[BLOB6, 'final-cut.mov']])] },
];
const file = (id: string, discussionId: string, messageId: string, bytes: number) => ({ id, kind: 'discussionAttachments' as const,
  storedSizeBytes: bytes, createdAt: 3, location: { kind: 'discussion' as const, discussionId, messageId, attachmentId: id } });
/** Files from three Discussions on one page (two of them in one message), and one more Discussion on the next page. */
const NAMED_PAGE_1 = [
  file(BLOB, 'discussion-1', 'message-1', 64_200_000), file(BLOB3, 'discussion-2', 'message-3', 18_600_000),
  file(BLOB4, 'discussion-3', 'message-4', 12_000_000), file(OTHER_BLOB, 'discussion-1', 'message-2', 6_000_000),
  file(BLOB5, 'discussion-2', 'message-3', 2_000_000),
];
const NAMED_PAGE_2 = [file(BLOB6, 'discussion-4', 'message-5', 1_000_000)];
/** Per-kind counts for the full inventory scope (unmeasured items included), as a carrying Home reports them. */
const COUNTED_KINDS: NonNullable<StorageInventoryV1['kinds']> = {
  artifacts: { storedSizeBytes: 192_000_000, itemCount: 214 },
  artifactOldVersions: { storedSizeBytes: 8_000_000, itemCount: 61 },
  discussionAttachments: { storedSizeBytes: 50_000_000, itemCount: 342 },
  accountPets: { storedSizeBytes: 10_000_000, itemCount: 6 },
  pluginCollections: { storedSizeBytes: 5_000_000, itemCount: 4 },
  pluginArtifacts: { storedSizeBytes: 0, itemCount: 0 },
  profilePictures: { storedSizeBytes: null, itemCount: 1 },
};

/** Only images stored, each measured (the server's total sums them like any other kind). */
const IMAGE_ONLY: StorageInventoryV1 = {
  totalBytes: 3_500_000, artifactLimitBytes: null, unmeasuredKinds: [],
  byKind: { artifacts: 0, pluginArtifacts: 0, discussionAttachments: 0, accountPets: 0, pluginCollections: 0 },
  kinds: {
    profilePictures: { storedSizeBytes: 1_500_000, itemCount: 1 },
    avatars: { storedSizeBytes: 1_200_000, itemCount: 3 },
    teamLogos: { storedSizeBytes: 800_000, itemCount: 1 },
  },
};
/** Artifacts and two measured image kinds, and Avatars whose size the Home did not record. */
const MIXED_IMAGES: StorageInventoryV1 = {
  totalBytes: 2_600_000, artifactLimitBytes: null, unmeasuredKinds: ['avatars'],
  byKind: { artifacts: 2_000_000, pluginArtifacts: 0, discussionAttachments: 0, accountPets: 0, pluginCollections: 0 },
  kinds: {
    artifacts: { storedSizeBytes: 2_000_000, itemCount: 2 },
    profilePictures: { storedSizeBytes: 400_000, itemCount: 1 },
    avatars: { storedSizeBytes: null, itemCount: 2 },
    teamLogos: { storedSizeBytes: 200_000, itemCount: 1 },
  },
};

async function serve(limit: number | null, options: Readonly<{
  counts?: boolean;
  artifactBilledBytes?: number;
  pages?: readonly [readonly unknown[], readonly unknown[]];
  /** The read's summary in place of the default Account's. */
  summary?: StorageInventoryV1;
  refuseFirstOnce?: boolean;
  /** The Home refuses the first ask for the next page with its typed cursor refusal. */
  refuseNextOnce?: boolean;
}> = {}) {
  let refuseFirst = options.refuseFirstOnce === true;
  let refuseNext = options.refuseNextOnce === true;
  inventoryReads = [];
  artifactListReads = 0;
  mutations = [];
  exactReads = [];
  const [first, second] = options.pages ?? [PAGE_1, PAGE_2];
  const rows = [...ROWS, ...MANY];
  const served = await serveActionHomes({
    homes: [
      {
        key: 'owner',
        serverUrl: 'https://account-storage-view.test',
        accountId: ACCOUNT,
      },
    ],
    route: (request) => {
      // The Home offers Discussions, so their Actions (a file's removal) are admitted to run.
      if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') {
        const features = createRootLayoutFeaturesResponse();
        for (const id of ['sharing.session', 'sharing.public', 'sessions.conversations', 'teams'] as const) tryWriteServerEnabledBitInPlace(features, id, true);
        return Response.json(features);
      }
      if (request.path === '/v1/artifacts/storage/usage') {
        inventoryReads.push(request.url);
        const next = request.url.searchParams.get('cursor') === 'page-2';
        if (!next && refuseFirst) {
          refuseFirst = false;
          return Response.json({ error: 'storage_size_out_of_range' }, { status: 503 });
        }
        if (next && refuseNext) {
          refuseNext = false;
          return Response.json({ error: 'invalid_storage_inventory_cursor' }, { status: 400 });
        }
        return Response.json({ ...(options.summary ?? { ...inventory(limit), ...(options.counts ? { kinds: COUNTED_KINDS } : {}) }),
          ...(options.artifactBilledBytes === undefined ? {} : { artifactBilledBytes: options.artifactBilledBytes }),
          page: next ? { items: second } : { items: first, nextCursor: 'page-2' } });
      }
      if (request.path === '/v1/discussions/messages/read' && request.method === 'POST') {
        const asked = (request.body as { messages: Array<{ discussionId: string; messageId: string }> }).messages;
        exactReads.push(asked);
        // Grouped by Discussion with its title and key context; a message the viewer cannot read is left out.
        return Response.json({ discussions: DISCUSSIONS.flatMap((discussion) => {
          const messages = discussion.messages.filter((message) => asked.some((pair) =>
            pair.discussionId === discussion.id && pair.messageId === message.id));
          return messages.length === 0 ? [] : [{ discussionId: discussion.id, titleContent: { t: 'plain', v: { v: 1, title: discussion.title } },
            keyContext: { encryptionMode: 'plain', keyReadiness: true, dataEncryptionKey: null }, messages }];
        }) });
      }
      if (request.path === '/v1/artifacts/read' && request.method === 'POST')
        return createArtifactReadBatchHttpResponse(request.body, (artifactId) => {
          const row = rows.find((candidate) => candidate.id === artifactId);
          // The read batch carries the header row only; sizes come from the storage read.
          if (!row) return { artifactId, ok: false, error: 'artifact_not_found', status: 404, retryable: false };
          const { storedSizeBytes: _size, ...header } = row;
          return row ? { artifactId, ok: true, artifact: header, recipientCensus: null }
            : { artifactId, ok: false, error: 'artifact_not_found', status: 404, retryable: false };
        });
      if (request.method === 'GET' && request.path === `/v1/artifacts/${SMALL}/revisions`)
        return Response.json({ revisions: [1, 2, 3].map((bodyVersion) => ({ bodyVersion, createdAt: bodyVersion, sizeBytes: 4_000_000 })),
          retentionCount: 10 });
      if (request.method === 'DELETE' && request.path === `/v1/artifacts/${SMALL}/revisions`) {
        mutations.push({ method: request.method, path: request.path });
        return Response.json({ artifactId: SMALL, freedBytes: 8_000_000,
          storageUsage: { usedBytes: 192_000_000, limitBytes: limit, documentLimitBytes: null, revisionRetentionCount: 10 } });
      }
      if (request.method === 'DELETE' && request.path.includes('/attachments/')) {
        mutations.push({ method: request.method, path: request.path });
        return Response.json({ blobId: BLOB, removedByAccountId: ACCOUNT, removedAt: 5 });
      }
      if (request.path === '/v1/artifacts' && request.method === 'GET') {
        // A read of the whole library; a read of exact ids (the page's names) is bounded by the page.
        if (!request.url.searchParams.has('artifactIds')) artifactListReads += 1;
        return createArtifactListHttpResponse(request.url, rows);
      }
      return undefined;
    },
  });
  disposeHome = served.dispose;
  return served.restoreActiveConnection();
}

async function layOut(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  stageTestId: string,
) {
  await act(async () => {
    invokeTestInstanceHandler(
      screen.findHostByTestId(stageTestId),
      'onLayout',
      {
        nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } },
      },
    );
  });
}

describe('Settings › Storage (storage-view lab scenes 1–4)', () => {
  it('lists held storage size when the specimen device cannot read an Artifact name', async () => {
    const screen = await renderScreen(
      <AppPaneProvider>
        <StorageSpecimen state="unknown" />
      </AppPaneProvider>,
    );
    try {
      await vi.waitFor(() =>
        expect(screen.findHostByTestId('storage:collection:stage')).not.toBeNull(),
      );
      await layOut(screen, 'storage:collection:stage');
      const item = 'storage:item:s3';
      await vi.waitFor(() =>
        expect(textOf(screen.findHostByTestId(item))).toContain(
          'artifacts.browser.storageView.items.nameNotReadable',
        ),
      );
      expect(textOf(screen.findHostByTestId(`${item}:size`))).toBe(storage(142_000_000));
    } finally {
      await screen.unmount();
    }
  });

  it("shows the Account's numbers, the Artifact limit, each kind, and the Account's own Artifacts largest first", async () => {
    const disconnect = await serve(300_000_000);
    try {
      const screen = await renderScreen(
        <AppPaneProvider>
          <StorageSettingsRoute />
        </AppPaneProvider>,
      );
      try {
        // The sentence: a kind the Home does not measure makes the total a minimum, and Artifacts hold most of it.
        await vi.waitFor(() =>
          expect(textOf(screen.findHostByTestId('storage:say'))).toContain(
            `artifacts.browser.storageView.say.storedAtLeast(size=${storage(265_000_000)})`,
          ),
        );
        expect(textOf(screen.findHostByTestId('storage:say'))).toContain(
          'artifacts.browser.storageView.say.mostly',
        );
        // Row 1 always; row 2 because a limit is set: what is left of it, from the server's own numbers.
        expect(
          textOf(screen.findHostByTestId('storage:account-figure')),
        ).toContain(storage(265_000_000));
        expect(
          textOf(screen.findHostByTestId('storage:limit-figure')),
        ).toContain(storage(100_000_000));
        expect(screen.findHostByTestId('storage:noLimit')).toBeNull();
        expect(
          textOf(screen.findHostByTestId('storage:kind:artifacts')),
        ).toContain(storage(200_000_000));
        expect(
          textOf(screen.findHostByTestId('storage:kind:profilePictures')),
        ).toContain('—');

        await vi.waitFor(() =>
          expect(
            screen.findHostByTestId('storage:collection:stage'),
          ).not.toBeNull(),
        );
        await layOut(screen, 'storage:collection:stage');
        // The list is the server's page, in the server's order: every kind it stores, not the browser's Artifacts.
        await vi.waitFor(() =>
          expect(itemOrder(screen)).toEqual([LARGE, `discussionAttachments-${BLOB}`, `artifactOldVersions-${SMALL}`,
            `discussionAttachments-${OTHER_BLOB}`, `artifactOldVersions-${LARGE}`]),
        );
        expect(textOf(screen.findHostByTestId(`storage:item:${LARGE}:size`))).toBe(storage(192_000_000));
        expect(textOf(screen.findHostByTestId(`storage:item:discussionAttachments-${BLOB}:size`))).toBe(storage(50_000_000));
        await vi.waitFor(() => expect(textOf(screen.findHostByTestId(`storage:item:${LARGE}`))).toContain('Q4 launch plan'));
        // The wide row says where an unfiled Artifact lives, as its phone row does (ACCEPT-1120 final, nit 2).
        expect(textOf(screen.findHostByTestId(`storage:item:${LARGE}`))).toContain('artifacts.browser.storageView.items.where');
        // One file is one Attachment: the Kind column names the item, not the kind's plural (nit 1).
        expect(textOf(screen.findHostByTestId(`storage:item:discussionAttachments-${BLOB}`)))
          .toContain('artifacts.browser.storageView.kinds.itemNames.discussionAttachments');
        // One inventory read per page, however many Artifacts the Account owns; no whole-library list read.
        expect(inventoryReads).toHaveLength(1);
        expect(artifactListReads).toBe(0);
        await act(async () => {
          invokeTestInstanceHandler(screen.findHostByTestId('storage:items:more'), 'onPress');
        });
        await vi.waitFor(() => expect(itemOrder(screen)).toContain(UNKNOWN));
        expect(inventoryReads).toHaveLength(2);
        expect(inventoryReads[1]!.searchParams.get('cursor')).toBe('page-2');
        expect(textOf(screen.findHostByTestId(`storage:item:${UNKNOWN}:size`))).toBe('—');
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  });

  it('shows the typed first-page storage refusal and retries that same page', async () => {
    const disconnect = await serve(null, { refuseFirstOnce: true });
    try {
      const screen = await renderScreen(<AppPaneProvider><StorageSettingsRoute /></AppPaneProvider>);
      try {
        await vi.waitFor(() => expect(screen.findHostByTestId('storage:retry')).not.toBeNull());
        const details = screen.findHostByTestId('storage:first-failed:details');
        expect(details).not.toBeNull();
        const { Modal } = await import('@/modal');
        await act(async () => { invokeTestInstanceHandler(details, 'onPress'); });
        expect(JSON.stringify(vi.mocked(Modal.alert).mock.calls.at(-1))).toContain('storage_size_out_of_range');
        await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('storage:retry'), 'onPress'); });
        await vi.waitFor(() => expect(screen.findHostByTestId('storage:collection:stage')).not.toBeNull());
        await layOut(screen, 'storage:collection:stage');
        await vi.waitFor(() => expect(itemOrder(screen)).toContain(LARGE));
        expect(inventoryReads.map((url) => url.searchParams.get('cursor'))).toEqual([null, null]);
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  });

  it('keeps the listed items when the Home refuses the next page, says so with its typed cause, and Retry asks for that page again', async () => {
    const disconnect = await serve(null, { refuseNextOnce: true });
    try {
      const screen = await renderScreen(<AppPaneProvider><StorageSettingsRoute /></AppPaneProvider>);
      try {
        await vi.waitFor(() => expect(screen.findHostByTestId('storage:collection:stage')).not.toBeNull());
        await layOut(screen, 'storage:collection:stage');
        await vi.waitFor(() => expect(itemOrder(screen)).toContain(LARGE));
        await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('storage:items:more'), 'onPress'); });
        await vi.waitFor(() => expect(screen.findHostByTestId('storage:items:more-failed')).not.toBeNull());
        expect(itemOrder(screen)).toContain(LARGE);
        expect(screen.findHostByTestId('storage:items:more')).toBeNull();
        const { Modal } = await import('@/modal');
        await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('storage:items:more-failed:details'), 'onPress'); });
        expect(JSON.stringify(vi.mocked(Modal.alert).mock.calls.at(-1))).toContain('invalid_storage_inventory_cursor');
        await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('storage:items:more-failed:retry'), 'onPress'); });
        await vi.waitFor(() => expect(itemOrder(screen)).toContain(UNKNOWN));
        expect(inventoryReads.map((url) => url.searchParams.get('cursor'))).toEqual([null, 'page-2', 'page-2']);
        expect(screen.findHostByTestId('storage:items:more-failed')).toBeNull();
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  });

  it("clears an Artifact's old versions and removes a Discussion file through their Actions, from each row's menu", async () => {
    const disconnect = await serve(null);
    try {
      const screen = await renderScreen(<AppPaneProvider><StorageSettingsRoute /></AppPaneProvider>);
      try {
        await vi.waitFor(() => expect(screen.findHostByTestId('storage:collection:stage')).not.toBeNull());
        await layOut(screen, 'storage:collection:stage');
        await vi.waitFor(() => expect(itemOrder(screen)).toContain(`artifactOldVersions-${SMALL}`));
        const menu = (id: string) => screen.findAll((node) => Array.isArray(node.props.items)
          && typeof node.props.onSelect === 'function' && node.props.triggerIcon === 'more'
          && (node.props.items as Array<{ id: string }>).some((item) => item.id === id)).at(0);
        // Each row offers only what the server admits on it: the facts true offer trim and remove, false or absent offer neither.
        const rowMenuIds = (key: string) => (screen.findAll((node) => node.props.testID === `storage:item:${key}`).at(0)
          ?.findAll((node) => Array.isArray(node.props.items) && typeof node.props.onSelect === 'function' && node.props.triggerIcon === 'more')
          .at(0)?.props.items as Array<{ id: string }> | undefined ?? []).map((item) => item.id);
        await vi.waitFor(() => expect(menu('trim')).toBeDefined());
        expect(menu('remove')).toBeDefined();
        expect(rowMenuIds(`artifactOldVersions-${SMALL}`)).toContain('trim');
        expect(rowMenuIds(`discussionAttachments-${BLOB}`)).toContain('remove');
        await vi.waitFor(() => expect(itemOrder(screen)).toContain(`artifactOldVersions-${LARGE}`));
        expect(rowMenuIds(`discussionAttachments-${OTHER_BLOB}`)).not.toContain('remove');
        expect(rowMenuIds(`artifactOldVersions-${LARGE}`)).not.toContain('trim');
        await act(async () => { await menu('trim')!.props.onSelect('trim'); });
        await vi.waitFor(() => expect(mutations).toContainEqual({ method: 'DELETE', path: `/v1/artifacts/${SMALL}/revisions` }));
        await act(async () => { await menu('remove')!.props.onSelect('remove'); });
        await vi.waitFor(() => expect(mutations.some((request) => request.path.includes('/attachments/'))).toBe(true));
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  });

  it("lists only the kinds that hold something or whose size is not recorded in What's stored", async () => {
    const disconnect = await serve(null);
    try {
      const screen = await renderScreen(<AppPaneProvider><StorageSettingsRoute /></AppPaneProvider>);
      try {
        await vi.waitFor(() => expect(textOf(screen.findHostByTestId('storage:kind:artifacts'))).toContain(storage(200_000_000)));
        // Plugin Artifacts hold 0 B: no row. The Profile picture's size is not recorded: its row stays and says so.
        expect(screen.findHostByTestId('storage:kind:pluginArtifacts')).toBeNull();
        expect(textOf(screen.findHostByTestId('storage:kind:profilePictures'))).toContain('—');
        expect(screen.findHostByTestId('storage:kind:discussionAttachments')).not.toBeNull();
        // An older Home omits the counts: no chip and no kind row claims one.
        expect(filterTabs(screen).every((tab) => tab.count === undefined)).toBe(true);
        expect(textOf(screen.findHostByTestId('storage:kind:artifacts'))).toContain('artifacts.browser.storageView.kinds.facts.artifacts');
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  });

  /** The Account row's bar and legend parts, by kind, as the row hands them to the shared composition strip. */
  async function accountParts(summary: StorageInventoryV1) {
    const disconnect = await serve(null, { summary, pages: [[], []] });
    try {
      const screen = await renderScreen(<AppPaneProvider><StorageSettingsRoute /></AppPaneProvider>);
      try {
        await vi.waitFor(() => expect(textOf(screen.findHostByTestId('storage:account-figure'))).toContain(storage(summary.totalBytes)));
        const strip = (variant: 'bar' | 'legend') => {
          const row = screen.findAll((node) => node.props.testID === 'storage:account').at(0);
          const node = row?.findAll((candidate) => candidate.props.variant === variant && Array.isArray(candidate.props.segments)).at(0);
          if (!node) throw new Error(`No Account ${variant}`);
          return new Map((node.props.segments as Array<{ id: string; value: number | null; color: string }>)
            .map((segment) => [segment.id, segment] as const));
        };
        return { bar: strip('bar'), legend: strip('legend') };
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  }

  it('draws measured images on the Account bar: an Account holding only images shows its bytes as parts, never an empty bar', async () => {
    const { bar, legend } = await accountParts(IMAGE_ONLY);
    expect([...bar.keys()].sort()).toEqual(['avatars', 'profilePictures', 'teamLogos']);
    expect(bar.get('profilePictures')?.value).toBe(1_500_000);
    expect(bar.get('avatars')?.value).toBe(1_200_000);
    expect(bar.get('teamLogos')?.value).toBe(800_000);
    // Each part takes its kind's mark from the one storage owner, the same on the bar and in its legend.
    for (const [id, segment] of bar) expect(segment.color).toBe(legend.get(id)?.color);
  });

  it('keeps a kind whose size is not recorded off the Account bar, while the measured kinds beside it stay on', async () => {
    const { bar, legend } = await accountParts(MIXED_IMAGES);
    expect([...bar.keys()].sort()).toEqual(['artifacts', 'profilePictures', 'teamLogos']);
    expect(bar.get('profilePictures')?.value).toBe(400_000);
    // The legend still names the unmeasured kind, with no amount.
    expect(legend.get('avatars')?.value).toBeNull();
  });

  it("counts each kind's items for the whole inventory on its chip and in its row, whatever page or filter is shown", async () => {
    const disconnect = await serve(null, { counts: true });
    try {
      const screen = await renderScreen(<AppPaneProvider><StorageSettingsRoute /></AppPaneProvider>);
      try {
        await vi.waitFor(() => expect(filterTabs(screen).find((tab) => tab.id === 'artifacts')?.count).toBe('214'));
        const counts = Object.fromEntries(filterTabs(screen).map((tab) => [tab.id, tab.count]));
        expect(counts).toEqual({ all: undefined, artifacts: '214', artifactOldVersions: '61', discussionAttachments: '342',
          accountPets: '6', pluginCollections: '4' });
        // The rows say them as the lab does ("214 Artifacts · documents, boards and files", "History kept in 61 Artifacts").
        expect(textOf(screen.findHostByTestId('storage:kind:artifacts'))).toContain('artifacts.browser.storageView.kinds.countedFacts.artifacts(count=214)');
        expect(textOf(screen.findHostByTestId('storage:kind:artifactOldVersions')))
          .toContain('artifacts.browser.storageView.kinds.countedFacts.artifactOldVersions(count=61)');
        expect(textOf(screen.findHostByTestId('storage:kind:discussionAttachments')))
          .toContain('artifacts.browser.storageView.kinds.countedFacts.discussionAttachments(count=342)');
        // Narrowing the list pages one kind; the counts stay the inventory's.
        await act(async () => { filterBar(screen).props.onSelectTab('accountPets'); });
        await vi.waitFor(() => expect(inventoryReads.at(-1)?.searchParams.get('kinds')).toBe('accountPets'));
        expect(filterTabs(screen).find((tab) => tab.id === 'artifacts')?.count).toBe('214');
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  });

  it('names every Discussion file on a page from one batched exact read, with no Discussion mounted', async () => {
    const disconnect = await serve(null, { pages: [NAMED_PAGE_1, NAMED_PAGE_2] });
    try {
      const screen = await renderScreen(<AppPaneProvider><StorageSettingsRoute /></AppPaneProvider>);
      try {
        await vi.waitFor(() => expect(screen.findHostByTestId('storage:collection:stage')).not.toBeNull());
        await layOut(screen, 'storage:collection:stage');
        const row = (id: string) => textOf(screen.findHostByTestId(`storage:item:discussionAttachments-${id}`));
        await vi.waitFor(() => expect(row(BLOB)).toContain('checkout-bug-repro.mov'));
        // Where it lives reads after the name: its Discussion, then who sent it.
        expect(row(BLOB)).toContain('Checkout bug triage · artifacts.browser.storageView.items.fromAuthor(author=Mika Tanaka)');
        expect(row(BLOB3)).toContain('api-trace-export.har');
        expect(row(BLOB3)).toContain('Release planning · artifacts.browser.storageView.items.fromYou');
        expect(row(BLOB5)).toContain('release-notes.md');
        expect(row(BLOB4)).toContain('pricing-draft.pdf');
        expect(row(BLOB4)).toContain('Pricing page copy · artifacts.browser.storageView.items.fromAuthor(author=Mika Tanaka)');
        // The Home left out a message this viewer cannot read: that row keeps the kind's own name and no place.
        expect(row(OTHER_BLOB)).toContain('artifacts.browser.storageView.items.titles.discussionAttachments');
        expect(row(OTHER_BLOB)).not.toContain('fromAuthor');
        // The count contract: one inventory read and ONE message read for three Discussions, each message asked once.
        expect(inventoryReads).toHaveLength(1);
        expect(exactReads).toHaveLength(1);
        expect(new Set(exactReads[0]!.map((pair) => `${pair.discussionId}/${pair.messageId}`))).toEqual(new Set([
          'discussion-1/message-1', 'discussion-2/message-3', 'discussion-3/message-4', 'discussion-1/message-2']));
        expect(exactReads[0]).toHaveLength(4);

        // The next page: one more inventory read and one more message read, for its own new message only.
        await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('storage:items:more'), 'onPress'); });
        await vi.waitFor(() => expect(row(BLOB6)).toContain('final-cut.mov'));
        expect(inventoryReads).toHaveLength(2);
        expect(exactReads).toHaveLength(2);
        expect(exactReads[1]).toEqual([{ discussionId: 'discussion-4', messageId: 'message-5' }]);
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  });

  it("opens a Discussion file at its message from the row's menu, beside Remove where admitted", async () => {
    const disconnect = await serve(null);
    try {
      const screen = await renderScreen(<AppPaneProvider><StorageSettingsRoute /></AppPaneProvider>);
      try {
        await vi.waitFor(() => expect(screen.findHostByTestId('storage:collection:stage')).not.toBeNull());
        await layOut(screen, 'storage:collection:stage');
        const rowMenu = (key: string) => screen.findAll((node) => node.props.testID === `storage:item:${key}`).at(0)
          ?.findAll((node) => Array.isArray(node.props.items) && typeof node.props.onSelect === 'function' && node.props.triggerIcon === 'more')
          .at(0);
        await vi.waitFor(() => expect(rowMenu(`discussionAttachments-${BLOB}`)).toBeDefined());
        const ids = (key: string) => ((rowMenu(key)?.props.items ?? []) as Array<{ id: string }>).map((item) => item.id);
        expect(ids(`discussionAttachments-${BLOB}`)).toEqual(['show', 'remove']);
        // Someone else's file the server does not let this viewer remove still opens where it lives.
        await vi.waitFor(() => expect(ids(`discussionAttachments-${OTHER_BLOB}`)).toEqual(['show']));
        await act(async () => { await rowMenu(`discussionAttachments-${BLOB}`)!.props.onSelect('show'); });
        const pushed = String(routerMock.spies.push.mock.calls.at(-1)?.[0] ?? '');
        expect(pushed).toContain('discussion-1');
        expect(pushed).toContain('message-1');
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  });

  it("says a phone row's kind and where it lives on line 2, never the kind twice", async () => {
    vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 2, fontScale: 1 });
    const disconnect = await serve(null);
    try {
      const screen = await renderScreen(<AppPaneProvider><StorageSettingsRoute /></AppPaneProvider>);
      try {
        await vi.waitFor(() => expect(screen.findHostByTestId('storage:collection:stage')).not.toBeNull());
        await act(async () => {
          invokeTestInstanceHandler(screen.findHostByTestId('storage:collection:stage'), 'onLayout',
            { nativeEvent: { layout: { x: 0, y: 0, width: 358, height: 800 } } });
        });
        const line = (key: string) => textOf(screen.findHostByTestId(`storage:item:${key}:line`));
        await vi.waitFor(() => expect(line(`artifactOldVersions-${SMALL}`)).not.toBe(''));
        expect(line(`artifactOldVersions-${SMALL}`)).toBe(
          'artifacts.browser.storageView.kinds.itemNames.artifactOldVersions · artifacts.browser.storageView.items.where');
        // A Discussion file's line names its kind once, then its Discussion and who sent it (lab "Checkout bug triage · from Mika Tanaka").
        await vi.waitFor(() => expect(line(`discussionAttachments-${BLOB}`)).toBe(
          'artifacts.browser.storageView.kinds.itemNames.discussionAttachments · Checkout bug triage · '
          + 'artifacts.browser.storageView.items.fromAuthor(author=Mika Tanaka)'));
        // A file the Home does not let this viewer read says its kind and that it is not available to them, never why.
        expect(line(`discussionAttachments-${OTHER_BLOB}`)).toBe(
          'artifacts.browser.storageView.kinds.itemNames.discussionAttachments · artifacts.browser.storageView.items.messageUnavailable');
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  });

  it('over the limit, says the cause once with the shipped notice and no sentence; no limit set says so', async () => {
    const disconnect = await serve(150_000_000);
    try {
      const screen = await renderScreen(
        <AppPaneProvider>
          <StorageSettingsRoute />
        </AppPaneProvider>,
      );
      try {
        await vi.waitFor(() =>
          expect(screen.findHostByTestId('storage:quota')).not.toBeNull(),
        );
        expect(screen.findHostByTestId('storage:say')).toBeNull();
        expect(
          textOf(screen.findHostByTestId('storage:limit-figure')),
        ).toContain(storage(200_000_000));
        expect(textOf(screen.findHostByTestId('storage:quota'))).toContain(
          'artifacts.browser.storageView.showBiggest',
        );
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  });

  it('at 90% of the limit says it is nearly full, as the Artifacts header meter does (one storage quota owner)', async () => {
    const limit = 150_000_000;
    // Physical storage is over the limit. Billed Artifacts sit exactly at the near share.
    const disconnect = await serve(limit, { artifactBilledBytes: 135_000_000 });
    try {
      const screen = await renderScreen(
        <AppPaneProvider>
          <StorageSettingsRoute />
        </AppPaneProvider>,
      );
      try {
        await vi.waitFor(() =>
          expect(textOf(screen.findHostByTestId('storage:say'))).toContain(
            'artifacts.browser.storageView.say.nearlyFull',
          ),
        );
        expect(screen.findHostByTestId('storage:quota')).toBeNull();
        expect(textOf(screen.findHostByTestId('storage:limit-figure'))).toContain(storage(15_000_000));
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  });

  it('opens from the Artifacts header total and from the full-quota notice, filtered to Artifacts', async () => {
    routerMock.state = { pathname: '/artifacts', params: {} };
    const disconnect = await serve(null);
    getStorage().setState((state) => ({
      settings: {
        ...state.settings,
        collectionDisplayPreferencesV1: { ...state.settings.collectionDisplayPreferencesV1,
          artifact: { ...state.settings.collectionDisplayPreferencesV1.artifact, presentation: 'list' } },
      },
    }));
    try {
      const screen = await renderScreen(
        <AppPaneProvider>
          <ArtifactsBrowserScreen />
        </AppPaneProvider>,
      );
      try {
        await vi.waitFor(() =>
          expect(
            screen.findHostByTestId('artifacts:storageOpen'),
          ).not.toBeNull(),
        );
        await act(async () => {
          invokeTestInstanceHandler(
            screen.findHostByTestId('artifacts:storageOpen'),
            'onPress',
          );
        });
        expect(routerMock.spies.push).toHaveBeenCalledWith(
          '/settings/storage?kind=artifacts',
        );
      } finally {
        await screen.unmount();
      }
    } finally {
      await disconnect();
    }
  });
});
