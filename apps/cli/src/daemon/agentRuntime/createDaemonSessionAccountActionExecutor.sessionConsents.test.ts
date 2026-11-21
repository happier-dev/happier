import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import {
  normalizeActionsSettingsV1,
  type ActionsSettingsV1,
} from '@happier-dev/protocol/actions/actionSettings';
import {
  ArtifactReadBatchInputV1Schema,
  ArtifactReadBatchResponseV1Schema,
} from '@happier-dev/protocol/artifacts/artifactAccessV1';
import {
  buildSessionApprovalConsentsHeaderV1,
  SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
} from '@happier-dev/protocol/actions/sessionApprovalConsentsV1';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
} from '@happier-dev/protocol/storage/artifactStoredContent';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { artifactKindListResponse } from '@/testkit/http/artifactHome';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

import { createDaemonSessionAccountActionExecutor } from './createDaemonSessionAccountActionExecutor';

type Operation = Extract<
  AgentRuntimeDaemonServiceRequestV1['operation'],
  { kind: 'action.execute' }
>;

afterEach(() => vi.restoreAllMocks());

const serverHttpBaseUrl = 'https://session-consents-forwarded.test';
const sessionId = 'forwarded-session';
const accountAskFirst = normalizeActionsSettingsV1({
  v: 1,
  actions: { 'machines.list': { approvalRequiredSurfaces: ['agent'] } },
});

/** HTTP is the only replaced boundary: the daemon executor, the consent owner and the ladder stay real. */
function serveSession(
  record: Readonly<{ boundSessionId: string; mode: 'allowed' | 'ask_first' }>,
) {
  const stored = () => ({
    id: 'consents-1',
    ownerAccountId: 'owner',
    access: 'owner',
    encryptionMode: 'plain',
    publicAudience: 'none',
    kind: 'other',
    kindHint: SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
    header: encodePlainArtifactStoredContent(
      buildSessionApprovalConsentsHeaderV1(record.boundSessionId),
    ),
    body: encodePlainArtifactStoredContent({
      body: JSON.stringify({
        v: 1,
        kind: SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
        sessionId: record.boundSessionId,
        rows: [
          { actionId: 'machines.list', audience: 'agent', mode: record.mode },
        ],
      }),
    }),
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    headerVersion: 1,
    bodyVersion: 1,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  vi.spyOn(axios, 'get').mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === `/v2/sessions/${sessionId}`)
      return {
        status: 200,
        data: {
          session: createSessionRecordFixture({ id: sessionId, share: null }),
        },
      };
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
      // The server's approvalSessionIds index returns only the queried Session's record.
      const queried = JSON.parse(
        url.searchParams.get('approvalSessionIds') ?? '[]',
      ) as string[];
      const { body: _body, ...header } = stored();
      return {
        status: 200,
        data: artifactKindListResponse(
          queried.includes(record.boundSessionId) ? [header] : [],
        ),
      };
    }
    throw new Error(`Unexpected forwarded consent GET ${url.pathname}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
    const path = new URL(String(input)).pathname;
    if (path !== '/v1/artifacts/read')
      throw new Error(`Unexpected forwarded consent POST ${path}`);
    return {
      status: 200,
      data: ArtifactReadBatchResponseV1Schema.parse({
        items: ArtifactReadBatchInputV1Schema.parse(body).artifactIds.map(
          (artifactId) => ({
            artifactId,
            ok: true,
            artifact: stored(),
            recipientCensus: null,
          }),
        ),
      }),
    };
  });
}

/**
 * The daemon's Account-Action executor, as the Session runner reaches it for an account-placed
 * Action: its credentialed executor is not Session-bound (`cli-global`), the same as the
 * production factory, and the Session comes only from the daemon's verified caller witness.
 */
async function forwardMachinesList(
  settings: ActionsSettingsV1,
  tokenSalt: string,
) {
  const credentials = {
    token: `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', salt: tokenSalt })).toString('base64url')}.signature`,
    encryption: null,
  };
  const approvals: unknown[] = [];
  let listed = 0;
  const execute = createDaemonSessionAccountActionExecutor({
    serverId: 'consent-home',
    serverHttpBaseUrl,
    token: credentials.token,
    credentials,
    machineId: 'consent-machine',
    createExecutor: () => {
      const cliDeps = createCliActionDeps({
        token: credentials.token,
        credentials,
        sessionId: 'cli-global',
        mode: 'plain',
        ctx: null,
        serverHttpBaseUrl,
      });
      const executor = createActionExecutor({
        readActionsSettings: () => settings,
        readSessionApprovalConsents: cliDeps.readSessionApprovalConsents,
        approvalsCreate: async ({ request }) => {
          approvals.push(request);
          return { artifactId: 'consent-approval' };
        },
        machinesList: async () => {
          listed++;
          return { items: [] };
        },
      });
      return {
        execute: (id, input, context) => executor.execute(id, input, context),
      };
    },
  });
  const operation: Operation = {
    kind: 'action.execute',
    requestId: `request-${tokenSalt}`,
    actionId: 'machines.list',
    input: {},
    toolCallId: `tool-${tokenSalt}`,
    witness: {
      turnId: 'turn-1',
      inputId: 'input-1',
      userMessageSeq: 1,
      userMessageSeqs: [1],
      workDepth: 1,
      agentStartCaller: {
        kind: 'session',
        sessionId,
        starterDepth: 1,
        turnDepth: 1,
      },
    },
  };
  const outcome = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () =>
    execute(operation, {
      sessionId,
      isCurrent: async () => true,
    }),
  );
  return { outcome, approvals, listed };
}

describe('Session approval rows on Actions the Session forwards to the daemon', () => {
  it('asks when the calling Session has "Ask first", even though the Account allows it', async () => {
    serveSession({ boundSessionId: sessionId, mode: 'ask_first' });
    const { outcome, approvals, listed } = await forwardMachinesList(
      normalizeActionsSettingsV1({ v: 1 }),
      'ask',
    );
    expect(outcome).toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created' },
    });
    expect(approvals).toHaveLength(1);
    expect(listed).toBe(0);
  });

  it('runs without asking when the calling Session has "Allowed" over the Account "Ask first"', async () => {
    serveSession({ boundSessionId: sessionId, mode: 'allowed' });
    const { outcome, approvals, listed } = await forwardMachinesList(
      accountAskFirst,
      'allowed',
    );
    expect(outcome).toMatchObject({ ok: true });
    expect(approvals).toHaveLength(0);
    expect(listed).toBe(1);
  });

  it("never applies another Session's row", async () => {
    serveSession({ boundSessionId: 'another-session', mode: 'allowed' });
    const { outcome, approvals, listed } = await forwardMachinesList(
      accountAskFirst,
      'other',
    );
    expect(outcome).toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created' },
    });
    expect(approvals).toHaveLength(1);
    expect(listed).toBe(0);
  });
});
