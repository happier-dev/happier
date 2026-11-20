import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { artifactKindListResponse } from '@/testkit/http/artifactHome';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
} from '@happier-dev/protocol/storage/artifactStoredContent';
import {
  ArtifactReadBatchInputV1Schema,
  ArtifactReadBatchResponseV1Schema,
} from '@happier-dev/protocol/artifacts/artifactAccessV1';
import {
  buildSessionApprovalConsentsHeaderV1,
  SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
} from '@happier-dev/protocol/actions/sessionApprovalConsentsV1';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { refreshDemandedSessionApprovalConsents } from '@/settings/profiles/sessionApprovalConsentsCatalog';
import { createCliActionDeps } from './createCliActionDeps';

const accountId = 'consent-owner';
const credentials = {
  token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
  encryption: null,
};
const sessionId = 'bound-session';
const row = {
  actionId: 'deployments.deploy',
  audience: 'agent',
  mode: 'allowed',
} as const;

/** HTTP is the only replaced boundary: the Account Artifact store and the consent reader stay real. */
function serveConsents(sessionRows: () => readonly unknown[]) {
  const reads: string[] = [];
  const stored = (rows: readonly unknown[]) => ({
    id: 'consents-1',
    ownerAccountId: accountId,
    access: 'owner',
    encryptionMode: 'plain',
    publicAudience: 'none',
    kind: 'other',
    kindHint: SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
    header: encodePlainArtifactStoredContent(
      buildSessionApprovalConsentsHeaderV1(sessionId),
    ),
    body: encodePlainArtifactStoredContent({
      body: JSON.stringify({
        v: 1,
        kind: SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
        sessionId,
        rows,
      }),
    }),
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    headerVersion: 1,
    bodyVersion: 1,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const get = vi.spyOn(axios, 'get').mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/account/encryption/currentness')
      return {
        status: 200,
        data: {
          mode: 'plain',
          version: 1,
          settingsVersion: 1,
          signingKeyFingerprint: null,
          contentKeyFingerprint: null,
          updatedAt: 1,
        },
      };
    if (url.pathname === '/v1/account/encryption')
      return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (url.pathname === '/v1/artifacts') {
      reads.push(`list:${url.searchParams.get('approvalSessionIds')}`);
      const { body: _body, ...header } = stored(sessionRows());
      return { status: 200, data: artifactKindListResponse([header]) };
    }
    throw new Error(`Unexpected consent HTTP boundary: ${url.pathname}`);
  });
  const post = vi
    .spyOn(axios, 'post')
    .mockImplementation(async (input, body) => {
      const path = new URL(String(input)).pathname;
      if (path !== '/v1/artifacts/read')
        throw new Error(`Unexpected consent HTTP boundary: ${path}`);
      const ids = ArtifactReadBatchInputV1Schema.parse(body).artifactIds;
      reads.push('read');
      return {
        status: 200,
        data: ArtifactReadBatchResponseV1Schema.parse({
          items: ids.map((artifactId) => ({
            artifactId,
            ok: true,
            artifact: stored(sessionRows()),
            recipientCensus: null,
          })),
        }),
      };
    });
  return {
    reads,
    restore: () => {
      get.mockRestore();
      post.mockRestore();
    },
  };
}

describe('Session consent binding on the Session host', () => {
  const deps = () =>
    createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId,
      mode: 'plain',
      ctx: null,
    });
  const agent = {
    surface: 'agent',
    authority: 'account_automation',
    runtimeAccountId: accountId,
  } as const;

  it("applies rows only for the host-stamped caller that is this host's bound Session (F-2)", async () => {
    const http = serveConsents(() => [row]);
    try {
      const read = deps().readSessionApprovalConsents!;
      const bound: ActionExecutorContext = {
        ...agent,
        actionCaller: { kind: 'session', sessionId },
      };
      expect(await read(bound)).toEqual({ sessionId, rows: [row] });
      // Selectors are never Session identity: a default, an input Session or another caller kind.
      for (const context of [
        { ...agent, defaultSessionId: sessionId },
        { ...agent, actionCaller: { kind: 'host' } },
        {
          ...agent,
          actionCaller: { kind: 'session', sessionId: 'other-session' },
        },
        {
          ...agent,
          actionCaller: { kind: 'session', sessionId },
          runtimeAccountId: 'another-account',
        },
      ] satisfies ActionExecutorContext[])
        expect(await read(context), JSON.stringify(context)).toBeNull();
      expect(http.reads.filter((entry) => entry.startsWith('list:'))).toEqual([
        `list:${JSON.stringify([sessionId])}`,
      ]);
    } finally {
      http.restore();
    }
  });

  it('holds the rows for later admissions and refreshes them on the Account change wake', async () => {
    let rows: readonly unknown[] = [row];
    const http = serveConsents(() => rows);
    const otherToken = `header.${Buffer.from(JSON.stringify({ sub: accountId, n: 2 })).toString('base64url')}.signature`;
    const local = { ...credentials, token: otherToken };
    try {
      const read = createCliActionDeps({
        token: otherToken,
        credentials: local,
        sessionId,
        mode: 'plain',
        ctx: null,
      }).readSessionApprovalConsents!;
      const bound: ActionExecutorContext = {
        ...agent,
        actionCaller: { kind: 'session', sessionId },
      };
      expect(await read(bound)).toEqual({ sessionId, rows: [row] });
      const afterFirst = http.reads.length;
      // One in-memory lookup per later admission: zero network reads.
      expect(await read(bound)).toEqual({ sessionId, rows: [row] });
      expect(await read(bound)).toEqual({ sessionId, rows: [row] });
      expect(http.reads.length).toBe(afterFirst);
      // The person removes the row; the wake refreshes and the next call asks.
      rows = [];
      await refreshDemandedSessionApprovalConsents({ credentials: local });
      expect(await read(bound)).toEqual({ sessionId, rows: [] });
    } finally {
      http.restore();
    }
  });

  it('applies no rows when the record cannot be read', async () => {
    const get = vi
      .spyOn(axios, 'get')
      .mockRejectedValue(new Error('Home unavailable'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, n: 3 })).toString('base64url')}.signature`;
    try {
      const read = createCliActionDeps({
        token,
        credentials: { ...credentials, token },
        sessionId,
        mode: 'plain',
        ctx: null,
      }).readSessionApprovalConsents!;
      expect(
        await read({ ...agent, actionCaller: { kind: 'session', sessionId } }),
      ).toBeNull();
    } finally {
      get.mockRestore();
    }
  });
});
