import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';
import type { TriageEntryRefV1 } from '@happier-dev/protocol/tasks/entryRefV1';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { MENTION_KIND_V1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';

import {
  changeTextTestInstance,
  flushHookEffects,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import {
  primeServerFeaturesSnapshot,
  resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';
import {
  setActiveServerId,
  upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { clearDiscussionRepositoryRegistryForTests } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';

import { ItemDiscussionThread } from './ItemDiscussionThread';
import { seedDiscussionDraft } from './useDiscussionDraft';

const credentials = vi.hoisted(() => ({
  serverId: '',
  accountId: 'item-thread-account',
}));
const discussionApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));

vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

// HTTP is the replaced boundary: the item lookup, the one create path (repository, draft, composer)
// and the Discussion page stay real. An opened thread's reads stay pending, so the page holds its frame.
vi.mock('@/sync/api/discussions/discussionActions', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/sync/api/discussions/discussionActions')
  >()),
  createDiscussionClient: () => ({
    list: discussionApi.list,
    create: discussionApi.create,
    get: () => new Promise(() => {}),
    read: () => new Promise(() => {}),
    readState: () => new Promise(() => {}),
    post: vi.fn(),
    rename: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
  }),
}));

// Device credential storage is the boundary; scope resolution stays real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
  const { createTokenStorageModuleMock } =
    await import('@/dev/testkit/mocks/tokenStorage');
  return createTokenStorageModuleMock({
    importOriginal,
    tokenStorage: {
      getCredentialsForServerUrl: async (_url, options) =>
        options?.serverId === credentials.serverId
          ? {
              token: `header.${Buffer.from(JSON.stringify({ sub: credentials.accountId })).toString('base64')}.signature`,
              secret: 'test-secret',
            }
          : null,
    },
  });
});

afterEach(() => {
  standardCleanup();
  clearDiscussionRepositoryRegistryForTests();
  resetSessionDraftRepositoryForTests();
  storage.setState(storage.getInitialState(), true);
  resetServerFeaturesClientForTests();
  vi.clearAllMocks();
});

const TASK: TriageEntryRefV1 = {
  source: { pluginId: 'happier.triage', localId: 'internal' },
  kindId: 'task',
  collisionScope: 'personal',
  entryId: 'task-7',
} as TriageEntryRefV1;
const ID = 'item-discussion-thread';

function thread(id: string): DiscussionOpenedSummaryV1 {
  return {
    id,
    ownerAccountId: credentials.accountId,
    encryptionMode: 'plain',
    access: 'owner',
    keyReadiness: true,
    dataEncryptionKey: null,
    anchor: { kind: 'task', entry: TASK },
    creationLocalId: null,
    title: 'Fix the login',
    latestMessage: {
      id: `${id}-1`,
      localId: null,
      seq: 1,
      authorAccountId: credentials.accountId,
      accountActor: null,
      producerV1: null,
      createdAt: 1,
    },
    messageSeq: 1,
    lastReadSeq: 1,
    unreadCount: 0,
    unreadMentionCount: 0,
    recentAuthorAccountIds: [credentials.accountId],
    archivedAt: null,
    capabilities: {
      postMessages: true,
      rename: true,
      archive: true,
      restore: false,
      askAgent: true,
      sendToSession: true,
      manageAccess: true,
      leave: false,
    },
  } as DiscussionOpenedSummaryV1;
}

const listed = (discussions: readonly DiscussionOpenedSummaryV1[]) =>
  Promise.resolve({
    kind: 'succeeded' as const,
    value: {
      v: 1 as const,
      serverId: credentials.serverId,
      discussions: [...discussions],
      nextCursor: null,
      incomplete: false,
    },
  });

async function mount(
  props: Partial<React.ComponentProps<typeof ItemDiscussionThread>> = {},
) {
  await loadSyncSingletonForTests();
  const profile = await upsertServerProfile({
    name: 'Item Home',
    serverUrl: 'https://item-thread.example.test',
  });
  const features = createRootLayoutFeaturesResponse();
  for (const feature of [
    'sharing.session',
    'sessions.conversations',
  ] as const) {
    if (!tryWriteServerEnabledBitInPlace(features, feature, true))
      throw new Error(`Unable to enable ${feature}`);
  }
  primeServerFeaturesSnapshot({
    serverId: profile.id,
    snapshot: { status: 'ready', features },
  });
  credentials.serverId = profile.id;
  await setActiveServerId(profile.id, { scope: 'device' });
  const scope = { serverId: profile.id, accountId: credentials.accountId };
  storage.setState(() => ({
    profileScope: scope,
    settingsScope: scope,
    settingsVersion: 1,
  }));
  // The item thread always mounts inside the app's panes (a Triage page or detail), as the Discussion page needs.
  const screen = await renderScreen(
    <AppPaneProvider>
      <ItemDiscussionThread serverId={profile.id} anchor={TASK} {...props} />
    </AppPaneProvider>,
  );
  await flushHookEffects(4);
  return { screen, scope };
}

function composerInput(screen: Awaited<ReturnType<typeof renderScreen>>) {
  const input = screen.root
    .findAll(
      (node) =>
        node.props.testID === 'new-session-composer-input' &&
        (typeof node.props.onChangeText === 'function' ||
          typeof node.props.onComposerChange === 'function'),
    )
    .at(-1);
  expect(input).toBeDefined();
  return input!;
}

describe('ItemDiscussionThread', () => {
  it('finds the item’s one thread through the exact item filter and draws the Discussion page', async () => {
    discussionApi.list.mockImplementation(() => listed([thread('thread-1')]));
    const { screen } = await mount();
    expect(discussionApi.list).toHaveBeenCalledWith(
      { anchorTask: TASK },
      expect.anything(),
    );
    expect(screen.findByTestId(`${ID}.timeline`)).not.toBeNull();
    expect(screen.findByTestId('new-session-composer-input')).toBeNull();
  });

  it('offers a first comment when the item has no thread, and only says so when the item is View only', async () => {
    discussionApi.list.mockImplementation(() => listed([]));
    const writable = await mount();
    expect(writable.screen.findByTestId(`${ID}.timeline`)).toBeNull();
    expect(
      writable.screen.findByTestId('new-session-composer-input'),
    ).not.toBeNull();
    await writable.screen.unmount();
    const readOnly = await mount({ readOnly: true });
    expect(readOnly.screen.findByTestId(`${ID}.empty`)).not.toBeNull();
    expect(
      readOnly.screen.findByTestId('new-session-composer-input'),
    ).toBeNull();
  });

  it('creates the thread anchored to the item on the first Send, then opens it', async () => {
    discussionApi.list.mockImplementation(() => listed([]));
    discussionApi.create.mockImplementation(
      async (input: {
        creationLocalId: string;
        messageLocalId: string;
        content: unknown;
      }) => ({
        kind: 'succeeded' as const,
        value: {
          v: 1,
          serverId: credentials.serverId,
          discussion: {
            ...thread('created-thread'),
            creationLocalId: input.creationLocalId,
          },
          firstMessage: {
            id: 'created-thread-1',
            discussionId: 'created-thread',
            localId: input.messageLocalId,
            seq: 1,
            authorAccountId: credentials.accountId,
            accountActor: null,
            producerV1: null,
            content: input.content,
            mentionedAccountIds: [],
            createdAt: 1,
          },
        },
      }),
    );
    const onPosted = vi.fn();
    const { screen } = await mount({ onPosted });
    await act(async () => {
      changeTextTestInstance(composerInput(screen), 'Can someone take this?');
    });
    await screen.pressByTestIdAsync('new-session-composer-send');
    await flushHookEffects(4);
    expect(discussionApi.create).toHaveBeenCalledOnce();
    expect(discussionApi.create.mock.calls[0]![0]).toMatchObject({
      anchor: { kind: 'task', entry: TASK },
    });
    expect(onPosted).toHaveBeenCalledOnce();
    expect(screen.findByTestId(`${ID}.timeline`)).not.toBeNull();
  });

  it('opens the thread another device created first instead of leaving the refusal in place', async () => {
    discussionApi.list
      .mockImplementationOnce(() => listed([]))
      .mockImplementation(() => listed([thread('other-device')]));
    discussionApi.create.mockResolvedValue({
      kind: 'failed',
      errorCode: 'discussion_task_thread_exists',
    });
    const { screen } = await mount();
    await act(async () => {
      changeTextTestInstance(composerInput(screen), 'First!');
    });
    await screen.pressByTestIdAsync('new-session-composer-send');
    await flushHookEffects(4);
    expect(discussionApi.list).toHaveBeenCalledTimes(2);
    expect(screen.findByTestId(`${ID}.timeline`)).not.toBeNull();
  });

  it('tells an Internal thread’s writer that an addressed agent answers only here, and stays quiet otherwise', async () => {
    discussionApi.list.mockImplementation(() => listed([thread('thread-1')]));
    const { screen, scope } = await mount({
      audience: 'internal',
      sourceName: 'Linear',
    });
    expect(screen.findByTestId(`${ID}.audience`)).not.toBeNull();
    expect(screen.findByTestId(`${ID}.agentGuard`)).toBeNull();
    const ref = 'session:reviewer-session';
    const token = formatInlineReferenceTokenV1({ ref, label: 'Reviewer' });
    await act(async () => {
      seedDiscussionDraft({
        scope,
        address: { kind: 'discussion', discussionId: 'thread-1' },
        text: `Ask ${token}`,
        mentions: [
          {
            kind: MENTION_KIND_V1.session,
            ref,
            label: 'Reviewer',
            tokenText: token,
            start: 4,
            end: 4 + token.length,
          },
        ],
      });
    });
    await flushHookEffects(2);
    expect(screen.findByTestId(`${ID}.agentGuard`)).not.toBeNull();
  });
});
