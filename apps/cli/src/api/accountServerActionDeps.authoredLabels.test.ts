import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import {
  ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1, ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
  AccountApiTokensCreateHttpInputV1Schema, AccountApiTokensUpdateHttpInputV1Schema,
} from '@happier-dev/protocol/auth/accountApiTokens';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { projectPrivateLabelForRecipientV1, type PrivateLabelBindingV1, type PrivateLabelStoredV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { PRIVATE_LABEL_RECIPIENT_CENSUS_PATH, PrivateLabelRecipientCensusResponseV1Schema } from '@happier-dev/protocol/crypto/privateLabelRecipientCensusV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { NO_TEAM_GROUP_CAPABILITIES_V1, TeamGroupCreateInputV1Schema } from '@happier-dev/protocol/teams/group';
import { teamGroupLabelBinding } from '@happier-dev/protocol/teams/groupLabel';
import { TeamCredentialResourceUpdateInputV1Schema, teamCredentialDisplayNamePrivateLabelBindingV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { TeamCredentialExternalApiKeyCreateInputV1Schema, teamCredentialExternalApiKeyLabelPrivateLabelBindingV1 } from '@happier-dev/protocol/teams/credentials/externalApiKeyV1';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import { openCliPrivateLabel } from './privateLabels';

const accountId = 'author-account';
const teamId = 'owning-team';
const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
const accountKey = new Uint8Array(32).fill(8);
const publicKey = tweetnacl.box.keyPair.fromSecretKey(accountKey).publicKey;
const contentPublicKeyFingerprint = computeContentPublicKeyFingerprint(publicKey);
const encryption = { type: 'dataKey' as const, machineKey: accountKey, publicKey };
const id = '11111111-1111-4111-8111-111111111111';
const label = 'Authored private name';
const date = '2026-11-18T00:00:00Z';

describe.each(['plain', 'e2ee'] as const)('authored labels through the CLI Account host (%s)', mode => {
  let app: ReturnType<typeof fastify>;
  let restore: () => void;
  let expectedOwner: { kind: 'team'; teamId: string } | { kind: 'account'; accountId: string };
  let routeError: Error | undefined;
  beforeEach(() => {
    routeError = undefined;
    app = fastify();
    restore = installAxiosFastifyAdapter({ app, origin: 'https://account.test' });
    app.setErrorHandler((error, _request, reply) => {
      routeError = error;
      return reply.code(500).send({ error: 'fixture_failed' });
    });
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({
      mode, contentKeyFingerprint: mode === 'e2ee'
        ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(contentPublicKeyFingerprint) : null,
    }));
    const census = PrivateLabelRecipientCensusResponseV1Schema.parse({ contentEncryptionMode: mode,
      recipients: mode === 'plain' ? [] : [{
        account: { kind: 'account', accountId, firstName: null, lastName: null, username: null, avatarUrl: null },
        readiness: { status: 'available', contentPublicKey: Buffer.from(publicKey).toString('base64'), contentPublicKeyFingerprint },
        envelopeStatus: 'missing',
      }],
    });
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`https://account.test${PRIVATE_LABEL_RECIPIENT_CENSUS_PATH}`);
      expect(JSON.parse(String(init?.body))).toEqual({ owner: expectedOwner });
      return Response.json(census);
    });
  });
  afterEach(async () => { vi.unstubAllGlobals(); restore(); await app.close(); });

  const execute = async (actionId: ActionId, input: unknown) => {
    const executor = createActionExecutor(createAccountServerActionDeps({
      token, credentials: { token, encryption: mode === 'e2ee' ? encryption : null },
      serverId: 'home', serverHttpBaseUrl: 'https://account.test',
    }));
    const result = await executor.execute(actionId, input, { surface: 'cli', authority: 'present_user',
      actionCaller: { kind: 'host' }, bypassApprovals: true, runtimeAccountId: accountId });
    if (routeError) throw routeError;
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  };

  const assertLabel = (stored: PrivateLabelStoredV1, binding: PrivateLabelBindingV1, value = label) => {
    expect(stored.content.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
    if (mode === 'e2ee') expect(JSON.stringify(stored)).not.toContain(value);
    const projected = projectPrivateLabelForRecipientV1({ stored, recipientAccountId: accountId });
    expect(openCliPrivateLabel({ label: projected, binding, readPolicy: { kind: 'team-resource' },
      ...(mode === 'e2ee' ? { accountKey } : {}) })).toBe(value);
    return projected;
  };

  it('creates a Group from its name and description', async () => {
    expectedOwner = { kind: 'team', teamId };
    const description = 'Authored private description';
    app.post('/v1/teams/groups/create', async request => {
      const wire = TeamGroupCreateInputV1Schema.parse(request.body);
      expect(wire).toMatchObject({ groupId: id, requestKey: 'create-group' });
      return { v: 1, id, teamId, name: { kind: 'available', label: assertLabel(wire.name, teamGroupLabelBinding(id, 'name')) },
        description: { kind: 'available', label: assertLabel(wire.description!, teamGroupLabelBinding(id, 'description'), description) },
        archivedAt: null, memberCount: 0, management: { kind: 'native' }, capabilities: NO_TEAM_GROUP_CAPABILITIES_V1 };
    });
    await execute('teams.groups.create', { v: 1, groupId: id, teamId, name: label, description, requestKey: 'create-group' });
  });

  it.each([
    ['account.apiTokens.create', ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1, AccountApiTokensCreateHttpInputV1Schema],
    ['account.apiTokens.update', ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1, AccountApiTokensUpdateHttpInputV1Schema],
  ] as const)('%s accepts a label from the CLI', async (actionId, path, schema) => {
    expectedOwner = { kind: 'account', accountId };
    app.post(path, async request => {
      const wire = schema.parse(request.body);
      const projected = assertLabel(wire.label!, { entity: 'account_api_token', field: 'label', id });
      const apiToken = { tokenId: id, label: projected, displayPrefix: 'hap_v1_11111111', createdAt: date,
        lastUsedAt: null, expiresAt: null, hasEncryptionAccess: false, hasUnattendedTeamAccess: false,
        grant: API_TOKEN_FULL_GRANT_V1, parentTokenId: null, activeChildCount: 0, embedConfig: null };
      return actionId.endsWith('.create') ? { token: `hap_v1_${id}_${'A'.repeat(43)}`, apiToken } : { apiToken };
    });
    await execute(actionId, { tokenId: id, label });
  });

  const registerCredentialGet = () => {
    app.post('/v1/teams/credential-resources/get', async request => {
      expect(request.body).toEqual({ resourceId: id });
      return { id, teamId, custodianAccountId: accountId, displayName: { content: { t: 'plain', v: 'Previous name' }, recipientEnvelope: null },
        source: { v: 1, kind: 'provider_connection', connectionId: 'connection-1',
          connectionSecurityFingerprint: 'connection-security:v1:test', credentialSlotId: 'api-key' },
        enabled: true, revision: 0, deliveryPolicy: { preferredAllowedModes: ['brokered'] }, sessionUsePolicy: 'personal_allowed', brokerPlacement: null, requestPolicy: null,
        allMembersAllowedRoutes: null, groupGrants: [], memberGrants: [], sourcePresentation: null,
        readiness: { kind: 'broker_unavailable' }, recoveryAction: 'select_broker',
        brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
        createdAt: date, updatedAt: date };
    });
  };

  it.each(['patch', 'replacement'] as const)('updates a credential name in its %s', async shape => {
    expectedOwner = { kind: 'team', teamId };
    registerCredentialGet();
    app.post('/v1/teams/credential-resources/update', async request => {
      const wire = TeamCredentialResourceUpdateInputV1Schema.parse(request.body);
      assertLabel((shape === 'patch' ? wire.displayName : wire.replacement?.displayName)!,
        teamCredentialDisplayNamePrivateLabelBindingV1(id));
      return { resourceId: id, revision: 1 };
    });
    await execute('teams.credentials.update', { resourceId: id, expectedRevision: 0,
      ...(shape === 'patch' ? { displayName: label } : { replacement: { displayName: label } }) });
  });

  it('creates a Team credential external key from an authored label', async () => {
    expectedOwner = { kind: 'team', teamId };
    registerCredentialGet();
    app.post('/v1/teams/credential-resources/external-keys/create', async request => {
      const wire = TeamCredentialExternalApiKeyCreateInputV1Schema.parse(request.body);
      return { token: `hapek_v1_${id}_${'A'.repeat(43)}`,
        key: { keyId: id, resourceId: id, teamMembershipId: wire.teamMembershipId,
          label: assertLabel(wire.label, teamCredentialExternalApiKeyLabelPrivateLabelBindingV1(id)),
          displayPrefix: 'hapek_v1_11111111', createdAt: date, lastUsedAt: null, expiresAt: null,
          authenticationStatus: 'satisfied', canAuthorize: false } };
    });
    await execute('teams.credentials.externalKeys.create', { resourceId: id, teamMembershipId: 'team-membership', keyId: id, label });
  });
});
