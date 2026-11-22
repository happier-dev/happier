import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '@happier-dev/protocol/bots/templates/botTemplateActionIdsV1';
import { BotTemplateReleaseV1Schema, projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from '../createCliActionDeps';

describe('Bot template requester Artifact custody', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prepares an Agent Copy of an owned template using the Artifact credential captured for its original requester', async () => {
    const accountId = 'requester-account';
    const homeId = 'requester-home';
    const serverUrl = 'https://requester-home.test';
    const target = { kind: 'machine', machineId: 'copy-machine' } as const;
    const installationId = 'copy-installation';
    const credential = (label: string) => ({
      token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.${label}`,
      encryption: null,
    });
    const executorCredentials = credential('approval-executor');
    const requesterCredentials = credential('original-requester');
    const artifactId = randomUUID();
    const release = BotTemplateReleaseV1Schema.parse({ v: 1, version: '1.0.0', changelog: '', releasedAtMs: 1,
      content: { v: 1, identity: { name: 'Owned Bot', description: '' }, instructions: { markdown: 'Help' },
        memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } });
    const document = { v: 1 as const, state: 'released' as const, release };
    const input = {
      source: { kind: 'artifact', serverId: homeId, artifactId },
      expectedVersion: release.version,
      creation: { creationKey: randomUUID(), directory: { kind: 'managed' }, memoryEnabled: false,
        executionTarget: { serverId: homeId, machineId: target.machineId },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
    };
    const actionId = BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1;
    const envelope = { v: 1 as const, requestId: randomUUID(), target, input };
    const sessionId = 'requesting-session';
    const origin = { v: 1, caller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
      sourceTurnId: 'requesting-turn', callerPermissionMode: 'default', causalPermissionAuthority: null,
      requestId: envelope.requestId };
    const source = { machineId: target.machineId, installationId };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-copy-root', binding: {
      accountId, custodianAccountId: accountId,
      authentication: { kind: 'account', tokenEpoch: 0 },
      serverIdentityId: homeId, machineId: target.machineId, installationId,
      sessionActionOrigin: origin, sessionActionSource: source,
      target, actionId, requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    const artifactReads: Array<string | null> = [];
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path === `/v1/artifacts/${artifactId}/access/grants`) {
        return { status: 200, data: { artifactId, ownerAccountId: accountId, access: 'owner', grants: [] } };
      }
      if (path === `/v1/artifacts/${artifactId}`) {
        artifactReads.push(String(config?.headers?.Authorization ?? '') === `Bearer ${requesterCredentials.token}`
          ? String(config?.headers?.[AUTHORITY_CEILING_HEADER_V1] ?? '') : null);
        return { status: 200, data: { id: artifactId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
          publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
          header: encodePlainArtifactStoredContent(projectBotTemplateArtifactHeaderV1(document)),
          body: encodePlainArtifactStoredContent({ body: JSON.stringify(document) }),
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        } };
      }
      throw new Error(`Unexpected template Home GET ${path}`);
    });
    const authorization = await projectRequesterAccountActionAuthorization({ authorization: root, serverIdentityId: homeId,
      bootstrap: { credentials: requesterCredentials, serverHttpBaseUrl: serverUrl, isCurrent: async () => true,
        getBoundSessionId: () => sessionId, attribution: { serverId: homeId, accountId, machineId: target.machineId, installationId } } });
    if (!authorization) throw new Error('Expected admitted Agent requester custody');
    const deps = createCliActionDeps({ token: executorCredentials.token, credentials: executorCredentials,
      sessionId, mode: 'plain', ctx: null, serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl });

    const prepared = await deps.prepareBotTemplateInstantiation!({ input, context: {
      surface: 'agent', authority: 'account_automation', serverId: homeId, externalActionTarget: target,
      externalActionExecutionAuthorization: authorization,
    } });

    expect(prepared).toMatchObject({ children: expect.arrayContaining([
      expect.objectContaining({ role: 'create_bot', input: expect.objectContaining({ title: 'Owned Bot' }) }),
    ]) });
    expect(artifactReads).toEqual(['account_automation']);
  });
});
