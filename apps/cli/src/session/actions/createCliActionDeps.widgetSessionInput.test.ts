import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { buildHomeHubArtifactIdV1, HOME_HUB_ARTIFACT_KIND_V1, HomeHubLayoutV1Schema } from '@happier-dev/protocol/home';
import { artifactReadResponse } from '@/testkit/http/artifactHome';
import { createCliActionDeps } from './createCliActionDeps';
import { createCounterWidgetFixture } from './widgetApproval.testkit';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';

beforeEach(() => { installAxiosRequestMethodAdapter(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reads the exact public declaration without saved layout or Artifact inventory reads and rejects a retired capture', async () => {
  const fixture = createCounterWidgetFixture();
  const publicPresentation = { kind: 'declarative' as const, document: { version: 1 as const,
    root: { kind: 'text' as const, text: 'Reviewed public template' } } };
  const projection = PluginProjectionV2Schema.parse({ ...fixture.projection,
    familiesById: { ...fixture.projection.familiesById, pluginUi: { family: 'pluginUi', entriesById: {
      counter: { ...fixture.projection.familiesById.pluginUi!.entriesById.counter, publicPresentation,
        availability: { state: 'disabled', reason: 'offline', diagnostics: [] } },
    } } } });
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'viewer' })).toString('base64url')}.signature`;
  const contentReads: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v2/account/settings') return { status: 200, data: AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 1 }) };
    if (path.startsWith('/v1/artifacts') || path.includes('/system-records')) contentReads.push(path);
    throw new Error(`Unexpected declaration HTTP read: ${path}`);
  });
  let current = true;
  let retireDuringRead = false;
  const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain', ctx: null,
    serverId: 'local-profile', serverIdentityId: 'srv_public_template', serverHttpBaseUrl: 'https://public-template.test',
    isCredentialCurrent: () => current,
    machineActionDirectTargetTransport: { machineId: 'widget-machine', invoke: async () => {
      if (retireDuringRead) current = false;
      return { protocolVersion: 1, projection };
    } } });
  const surface = { serverId: 'srv_public_template', accountId: 'viewer',
    owner: { kind: 'corePage' as const, pageId: 'public-profile', area: 'main' } };
  const request = { surface, definition: fixture.definition, context: { surface: 'cli' as const, authority: 'present_user' as const } };
  const read = () => deps.widgetCatalog!.readInstalledDescriptor!(request);
  expect(await read()).toMatchObject({ title: 'Directory count', publicPresentation, availability: 'unavailable',
    sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [{ path: 'filter' }] } });
  expect(contentReads).toEqual([]);
  expect(await deps.widgetCatalog!.readInstalledDescriptor!({ ...request,
    surface: { ...surface, owner: { kind: 'home' } } })).toMatchObject({ title: 'Directory count', availability: 'unavailable' });
  await expect(createActionExecutor(deps).execute('action.options.resolve', {
    consumer: { kind: 'widget', surface: { ...surface, owner: { kind: 'home' } }, definition: fixture.definition }, fieldPath: 'filter',
  }, { surface: 'cli', authority: 'present_user', serverId: surface.serverId }))
    .resolves.toMatchObject({ ok: false, errorCode: 'input_type_consumer_unavailable' });
  expect(contentReads).toEqual([]);
  expect(await deps.widgetCatalog!.readInstalledDescriptor!({ ...request,
    surface: { ...surface, accountId: 'another-account' } })).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
  retireDuringRead = true;
  expect(await read()).toMatchObject({ ok: false, errorCode: 'widget_scope_unavailable' });
});

/**
 * A Session picked from the `sessions` options source must be admitted by the same Home decision that
 * the widget validator applies: a device-local profile id plus the Home's portable identity.
 */
describe('CLI widget Session input scope', () => {
  const home = 'https://widget-session-home.test';
  const sessionId = 'c111111111111111111111111';
  const homeIdentity = 'srv_widget_session_home';
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'viewer' })).toString('base64url')}.signature`;
  const sessionFixture = () => {
    const fields = buildSessionMetadataEnvelopeFields({ credentials: { token, encryption: null }, accountEncryptionMode: 'plain',
      storedContentMode: 'plain', metadata: { path: '/repo', host: 'host', machineId: 'machine' }, agentState: null });
    return createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', share: null, metadataVersion: 0,
      metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
      ownerMetadata: fields.ownerMetadata, displayProjectionV1: fields.displayProjectionV1 });
  };

  it('admits the Session the options resolver offers for the portable Home identity', async () => {
    const session = sessionFixture();
    // Only Home HTTP is substituted; Action dispatch, scope admission and the widget input owner stay real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = String(url);
      if (path.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session } };
      if (path.endsWith('/v2/account/settings')) return { status: 200, data: AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 1 }) };
      // The Home layout Artifact does not exist yet: a definite absence, not a failure.
      if (path.includes('/v1/artifacts/')) return { status: 404, data: { error: 'not_found' } };
      throw new Error(`Unexpected Home read: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(String(url)).toBe(`${home}/v1/artifacts/read`);
      return artifactReadResponse(body, () => null);
    });
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'local-profile', serverIdentityId: homeIdentity, serverHttpBaseUrl: home,
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: async () => ({
        protocolVersion: 1, projection: createCounterWidgetFixture().projection,
      }) } });
    const picked = { serverId: homeIdentity, sessionId };
    const resolved = await deps.widgetInputs!.resolve({
      ref: { surface: { serverId: homeIdentity, accountId: 'viewer', owner: { kind: 'home' } }, instanceId: 'summary' },
      instance: { v: 1, id: 'summary', definition: { kind: 'builtin', id: 'session_summary' }, bindings: { session: { kind: 'value', value: picked } } },
      context: { surface: 'cli', authority: 'present_user', serverId: homeIdentity, serverIdentityId: homeIdentity },
    });
    expect(resolved, JSON.stringify(resolved)).toEqual({ status: 'ready', input: { session: picked } });
  });

  it.each([true, false])('uses requester authority for Session input admission (requester can read: %s)', async canRead => {
    const session = sessionFixture();
    const rootActionId = 'widgets.item.inputs.validate';
    const picked = { serverId: homeIdentity, sessionId };
    const instance = { v: 1 as const, id: 'summary', definition: { kind: 'builtin' as const, id: 'session_summary' },
      bindings: { session: { kind: 'value' as const, value: picked } } };
    const layout = HomeHubLayoutV1Schema.parse({ v: 1, order: [instance.id], hidden: [], items: [{ kind: 'widget', instance }] });
    const homeArtifactId = buildHomeHubArtifactIdV1('viewer');
    const homeArtifact = { id: homeArtifactId, ownerAccountId: 'viewer', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
      header: encodePlainArtifactStoredContent({ kind: HOME_HUB_ARTIFACT_KIND_V1, v: 1 }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(layout) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    const sessionReadAuthorities: Array<'requester' | 'daemon'> = [];
    const isRequester = (config?: { headers?: Record<string, string> }) =>
      config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'home-minted-authorization';
    const refusedEffect = { status: 401, data: { error: 'invalid_connection_credential' } };
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const path = String(url);
      const headers = config as { headers?: Record<string, string> } | undefined;
      if (path.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path.endsWith(`/v2/sessions/${sessionId}`)) {
        sessionReadAuthorities.push(isRequester(headers) ? 'requester' : 'daemon');
        if (isRequester(headers)) {
          expect(headers?.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe(rootActionId);
          expect(headers?.headers?.Authorization).toBeUndefined();
          return canRead ? { status: 200, data: { session } } : refusedEffect;
        }
        return { status: 200, data: { session } };
      }
      if (path.endsWith('/v2/account/settings')) return { status: 200, data: AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 1 }) };
      if (path.endsWith(`/v1/artifacts/${homeArtifactId}`)) return { status: 200, data: homeArtifact };
      throw new Error(`Unexpected Home read: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(String(url)).toBe(`${home}/v1/artifacts/read`);
      return artifactReadResponse(body, id => id === homeArtifactId ? homeArtifact : null);
    });
    const installation = { installationId: 'installation-1', privateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey };
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'local-profile', serverIdentityId: homeIdentity, serverHttpBaseUrl: home,
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: async () => ({
        protocolVersion: 1, projection: createCounterWidgetFixture().projection,
      }) },
      externalActionMachineRequestPrivateKey: installation.privateKey, externalActionMachineInstallationId: installation.installationId });
    // Home mints this; the CLI only forwards its token, request id and Home identity into the signed headers.
    const authorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'home-minted-authorization', binding: {
      actionId: rootActionId, requestId: 'req-1', serverIdentityId: homeIdentity,
      accountId: 'requester', accountEncryptionMode: 'plain', authentication: { kind: 'account', tokenEpoch: 0 },
      machineId: 'machine', custodianAccountId: 'viewer', installationId: installation.installationId,
      requestEnvelopeDigest: 'd'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
    } };
    const result = await createActionExecutor(deps).execute(rootActionId, {
      ref: { surface: { serverId: homeIdentity, accountId: 'viewer', owner: { kind: 'home' } }, instanceId: instance.id },
      bindings: instance.bindings,
    }, { surface: 'cli', authority: 'account_automation', serverId: homeIdentity, serverIdentityId: homeIdentity,
      bypassApprovals: true, externalActionExecutionAuthorization: authorization, externalActionTarget: { kind: 'machine', machineId: 'machine' } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: canRead
      ? { status: 'ready', input: { session: picked } }
      : { status: 'unavailable', fields: [{ path: 'session', reasonCode: 'not_authenticated' }] } });
    expect(sessionReadAuthorities).toContain('requester');
    expect(sessionReadAuthorities).not.toContain('daemon');
  });
});
