import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { projectPrivateLabelForRecipientV1, sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { TeamCredentialResourceCreateInputV1Schema, TeamCredentialResourceSummaryV1Schema,
  teamCredentialDisplayNamePrivateLabelBindingV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { teamCredentialMutationRequiresUiConfirmation } from '@happier-dev/protocol/actions/specs/teamCredentialApproval';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { handleActionsCommand } from '@/cli/commands/actions';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import { openCliPrivateLabel } from './privateLabels';

const accountId = 'credential-author';
const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
const accountKey = new Uint8Array(32).fill(8);
const publicKey = tweetnacl.box.keyPair.fromSecretKey(accountKey).publicKey;
const encryption = { type: 'dataKey' as const, machineKey: accountKey, publicKey };
const draft = {
  teamId: 'team-1', resourceId: 'resource-1', displayName: 'Shared CLI provider',
  source: { v: 1, kind: 'provider_connection', connectionId: 'connection-1',
    connectionSecurityFingerprint: 'connection-security:v1:test', credentialSlotId: 'api-key' },
  sessionUsePolicy: 'personal_allowed', brokerPlacement: null, requestPolicy: null,
  allMembersAllowedRoutes: null, groupGrants: [], memberGrants: [], usageLimits: [],
};

describe('Team credential create label intent through captured Account Actions', () => {
  let app = fastify();
  let restore = () => {};
  beforeEach(() => {
    app = fastify();
    restore = installAxiosFastifyAdapter({ app, origin: 'https://account.test' });
  });
  afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); process.exitCode = undefined; restore(); await app.close(); });

  it('creates from CLI text through the plain label owner and only its Team census', async () => {
    let routeError: Error | undefined;
    app.setErrorHandler((error, _request, reply) => { routeError = error; return reply.code(500).send({ error: 'fixture_failed' }); });
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain',
      contentKeyFingerprint: null }));
    // Account HTTP and census transport are boundaries; Action parsing and encryption stay real.
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ owner: { kind: 'team', teamId: draft.teamId } });
      return Response.json({ contentEncryptionMode: 'plain', recipients: [] });
    });
    let writes = 0;
    app.post('/v1/teams/credential-resources/create', async request => {
      writes++;
      const wire = TeamCredentialResourceCreateInputV1Schema.parse(request.body);
      expect(wire.displayName.content.t).toBe('plain');
      expect(wire.displayName.recipients).toEqual([]);
      const label = projectPrivateLabelForRecipientV1({ stored: wire.displayName, recipientAccountId: accountId });
      expect(openCliPrivateLabel({ binding: teamCredentialDisplayNamePrivateLabelBindingV1(draft.resourceId), label,
        readPolicy: { kind: 'team-resource' } })).toBe(draft.displayName);
      const { usageLimits: _limits, resourceId, ...fields } = wire;
      return TeamCredentialResourceSummaryV1Schema.parse({ ...fields, id: resourceId,
        custodianAccountId: accountId, displayName: label, enabled: true, revision: 0,
        sourcePresentation: null, readiness: { kind: 'broker_unavailable' }, recoveryAction: 'select_broker',
        brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
        createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z' });
    });
    const credentials = { token, encryption: null };
    const executor = createActionExecutor(createAccountServerActionDeps({ token, credentials,
      serverId: 'home', serverHttpBaseUrl: 'https://account.test' }));
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    await seedTestServerProfile({ id: 'home', homeId: 'srv_credential_home', serverUrl: 'https://account.test' });
    await handleActionsCommand(['invoke', 'teams.credentials.create', '--server-id', 'home', '--input-json', JSON.stringify(draft), '--json'], {
      readCredentialsFn: async () => credentials,
      readCredentialsForServerIdFn: async () => credentials,
      createExecutorFn: () => ({ execute: (actionId, input, context) => executor.execute(actionId, input,
        { ...context, bypassApprovals: true }), resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } }),
    });
    if (routeError) throw routeError;
    expect(JSON.parse(output), output).toMatchObject({ ok: true, data: { id: draft.resourceId } });
    expect(writes).toBe(1);
  });

  it('refuses unavailable E2EE material before sending an authored label', async () => {
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }));
    let writes = 0;
    app.post('/v1/teams/credential-resources/create', async () => { writes++; return {}; });
    const executor = createActionExecutor(createAccountServerActionDeps({ token, credentials: { token, encryption: null },
      serverId: 'home', serverHttpBaseUrl: 'https://account.test' }));
    await expect(executor.execute('teams.credentials.create', draft, { surface: 'agent', bypassApprovals: true }))
      .resolves.toMatchObject({ ok: false, errorCode: 'account_storage_currentness_unavailable' });
    expect(writes).toBe(0);
  });

  it('requires the captured private-label client for authored text', async () => {
    const { privateLabelPrepare: _prepare, ...deps } = createAccountServerActionDeps({ token,
      credentials: { token, encryption }, serverId: 'home', serverHttpBaseUrl: 'https://account.test' });
    const executor = createActionExecutor(deps);
    await expect(executor.execute('teams.credentials.create', draft, { surface: 'agent', bypassApprovals: true }))
      .resolves.toMatchObject({ ok: false, errorCode: 'client_required' });
  });

  it('preserves prepared UI labels and native disclosure approval for authored text', async () => {
    const displayName = sealPrivateLabelV1({ mode: 'plain',
      binding: teamCredentialDisplayNamePrivateLabelBindingV1(draft.resourceId), value: draft.displayName });
    let received: unknown;
    app.post('/v1/teams/credential-resources/create', async request => {
      received = TeamCredentialResourceCreateInputV1Schema.parse(request.body).displayName;
      return { error: 'resource_conflict' };
    });
    const executor = createActionExecutor(createAccountServerActionDeps({ token, credentials: { token, encryption: null },
      serverId: 'home', serverHttpBaseUrl: 'https://account.test' }));
    await executor.execute('teams.credentials.create', { ...draft, displayName }, { surface: 'ui', bypassApprovals: true });
    expect(received).toEqual(displayName);
    expect(teamCredentialMutationRequiresUiConfirmation('teams.credentials.create', draft)).toBe(false);
    expect(teamCredentialMutationRequiresUiConfirmation('teams.credentials.create', { ...draft,
      deliveryPolicy: { preferredAllowedModes: ['vendor-native'] } })).toBe(true);
  });
});
