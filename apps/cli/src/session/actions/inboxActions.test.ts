import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
} from '@happier-dev/protocol';
import {
  AccountNoticeArtifactBodyV1Schema,
  AccountNoticeArtifactHeaderV1Schema,
} from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createAccountArtifactStore, encodeAccountArtifactListCursor } from '@/api/artifacts/accountArtifactStore';
import {
  artifactKindListResponse,
  artifactReadResponse,
} from '@/testkit/http/artifactHome';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';

import { createCliInboxReadAction } from './inboxActions';

// The Home HTTP transport is the only substituted boundary; the real store, codec and selection run beneath it.
const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}));
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: Object.assign(actual.default.create(), actual.default, {
      get: mockGet,
      post: mockPost,
    }),
  };
});
vi.mock('@/configuration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return {
    ...actual,
    configuration: {
      ...actual.configuration,
      apiServerUrl: 'http://127.0.0.1:24599',
    },
  };
});

type Row = Readonly<
  Record<string, unknown> & {
    id: string;
    kind: string;
    kindHint: string;
    updatedAt: number;
  }
>;

function plainRow(
  id: string,
  kindHint: string,
  updatedAt: number,
  header: unknown,
  body?: unknown,
): Row {
  return {
    id,
    kind: 'other',
    kindHint,
    header: encodePlainArtifactStoredContent(header),
    ...(body === undefined
      ? {}
      : { body: encodePlainArtifactStoredContent(body), bodyVersion: 1 }),
    headerVersion: 1,
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    seq: 1,
    createdAt: updatedAt,
    updatedAt,
    ownerAccountId: 'owner',
    access: 'owner',
    encryptionMode: 'plain',
    publicAudience: 'none',
  };
}

function noticeRow(
  id: string,
  updatedAt: number,
  status: 'open' | 'dismissed',
) {
  const content = AccountNoticeArtifactBodyV1Schema.parse({
    v: 1,
    source: { kind: 'plugin', pluginId: 'qa.notice', itemId: id },
    type: 'update',
    resolved: status !== 'open',
    body: id,
  });
  return plainRow(
    id,
    'account_notice.v1',
    updatedAt,
    AccountNoticeArtifactHeaderV1Schema.parse({
      ...content,
      kind: 'account_notice.v1',
      status,
      title: id,
    }),
    { body: JSON.stringify(content) },
  );
}

/**
 * Home list semantics for the selectors the CLI sends: `kinds` is the server's indexed exact-kind
 * selection (artifactAccessService `kind IN (...)`), `kind` the coarse class; keyset pages of `limit`.
 */
function serveHome(rows: readonly Row[]) {
  const census = {
    listRequests: 0,
    headerRowsDelivered: 0,
    bodyRowsDelivered: 0,
  };
  const ordered = [...rows].sort(
    (left, right) =>
      right.updatedAt - left.updatedAt || right.id.localeCompare(left.id),
  );
  mockGet.mockImplementation(async (rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/v1/features')
      return { status: 200, data: FeaturesResponseSchema.parse({}) };
    if (url.pathname === '/v1/account/encryption')
      return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    expect(url.pathname).toBe('/v1/artifacts');
    census.listRequests += 1;
    const kinds = url.searchParams.has('kinds')
      ? new Set(JSON.parse(url.searchParams.get('kinds')!) as string[])
      : null;
    const coarse = url.searchParams.get('kind');
    const unclassified = url.searchParams.has('unclassified');
    const candidates = unclassified
      ? []
      : ordered.filter(
          (row) =>
            (!kinds || kinds.has(row.kindHint)) &&
            (!coarse || row.kind === coarse),
        );
    const cursor = url.searchParams.get('cursor');
    const index = cursor
      ? candidates.findIndex(
          (row) =>
            encodeAccountArtifactListCursor({ artifactId: row.id, updatedAt: row.updatedAt }) === cursor,
        )
      : -1;
    if (cursor && index < 0) return { status: 400, data: { error: 'invalid_cursor' } };
    const start = index + 1;
    const page = candidates
      .slice(
        start,
        start + Number(url.searchParams.get('limit') ?? candidates.length),
      )
      .map(({ body: _body, bodyVersion: _bodyVersion, ...header }) => header);
    census.headerRowsDelivered += page.length;
    return { status: 200, data: artifactKindListResponse(page) };
  });
  mockPost.mockImplementation(async (rawUrl: string, input: unknown) => {
    expect(new URL(rawUrl).pathname).toBe('/v1/artifacts/read');
    const response = artifactReadResponse(
      input,
      (id) => rows.find((row) => row.id === id) ?? null,
    );
    census.bodyRowsDelivered += (
      response.data as { items: unknown[] }
    ).items.length;
    return response;
  });
  return census;
}

async function readInboxOver(rows: readonly Row[]) {
  const census = serveHome(rows);
  const store = createAccountArtifactStore({
    credentials: { token: 'token', encryption: null },
    getAccountEncryptionMode: async () => 'plain',
  });
  const inbox = await createCliInboxReadAction({
    store,
    accountId: 'owner',
    serverId: 'home',
  })({
    actionId: 'inbox.get',
    input: {},
    context: { surface: 'cli', expectedAccountId: 'owner' },
  });
  return { inbox, census };
}

describe('createCliInboxReadAction inbox.get read cost', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    resetServerFeaturesClientForTests();
  });

  it("reads notice headers and bodies in proportion to notices, not to the Account's other Artifacts", async () => {
    const notices = [
      noticeRow('notice-open-1', 9_000_003, 'open'),
      noticeRow('notice-open-2', 9_000_002, 'open'),
      noticeRow('notice-dismissed', 9_000_001, 'dismissed'),
    ];
    // Account A (5e3a0581, 2026-11-15) holds ~70k coarse "other" Artifacts beside its notices: scale-shaped here as
    // 1 vs 3 full 500-row transport pages of unrelated Artifacts.
    const unrelated = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        plainRow(
          `workflow-${index}`,
          'workflow-definition.v1',
          1_000_000 - index,
          { kind: 'workflow-definition.v1', title: `w${index}` },
        ),
      );
    const small = await readInboxOver([...notices, ...unrelated(500)]);
    const large = await readInboxOver([...notices, ...unrelated(1_500)]);

    for (const { inbox } of [small, large]) {
      expect(inbox).toMatchObject({
        accountNoticeIds: ['notice-open-1', 'notice-open-2'],
        coverage: {
          sources: expect.arrayContaining([
            { source: 'notices', status: 'complete' },
          ]),
        },
        refreshFailed: false,
      });
    }
    // Cost contract: one indexed list request and only notice rows cross the wire, at any inventory size.
    expect(large.census).toEqual(small.census);
    expect(large.census).toEqual({
      listRequests: 1,
      headerRowsDelivered: notices.length,
      bodyRowsDelivered: notices.length,
    });
  });
});
