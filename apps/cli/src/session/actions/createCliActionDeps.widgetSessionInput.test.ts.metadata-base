import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { isWidgetAdmissionUndecidableHereV1 } from '@happier-dev/protocol/widgets/executeWidgetInstanceActionV1';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol';
import { createCliActionDeps } from './createCliActionDeps';
import { createCounterWidgetFixture } from './widgetApproval.testkit';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/**
 * A Session picked from the `sessions` options source must be admitted by the same Home decision that
 * the widget validator applies: a device-local profile id plus the Home's portable identity.
 */
describe('CLI widget Session input scope', () => {
  const home = 'https://widget-session-home.test';
  const sessionId = 'c111111111111111111111111';
  const homeIdentity = 'srv_widget_session_home';
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'viewer' })).toString('base64url')}.signature`;

  it('admits the Session the options resolver offers for the portable Home identity', async () => {
    const session = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 1, share: null,
      dataEncryptionKey: null, metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: { path: '/repo', host: 'host', machineId: 'machine' } }) });
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
    // Machine RPC is the process boundary that serves the Machine's plugin projection; Built-in widgets stay host-owned.
    vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ protocolVersion: 1, projection: createCounterWidgetFixture().projection });
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId, mode: 'plain', ctx: null,
      serverId: 'local-profile', serverIdentityId: homeIdentity, serverHttpBaseUrl: home });
    const picked = { serverId: homeIdentity, sessionId };
    const resolved = await deps.widgetInputs!.resolve({
      ref: { surface: { serverId: homeIdentity, accountId: 'viewer', owner: { kind: 'home' } }, instanceId: 'summary' },
      instance: { v: 1, id: 'summary', definition: { kind: 'builtin', id: 'session_summary' }, bindings: { session: { kind: 'value', value: picked } } },
      context: { surface: 'cli', authority: 'present_user', serverId: homeIdentity, serverIdentityId: homeIdentity },
    });
    expect(resolved, JSON.stringify(resolved)).toEqual({ status: 'ready', input: { session: picked } });
  });

  /**
   * An agent's Session caller executes with the Home-minted authorization of its root Action. Home admits
   * a signed read only for that root (or a few named preparation effects), so the Session read of the
   * admission answers "not authenticated" for a Session that is real and owned. Admission must hand that
   * to the approved execution instead of refusing the pick.
   */
  it('reports a Session read that its root authorization cannot make as undecidable here, not as a refusal', async () => {
    const session = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 1, share: null,
      dataEncryptionKey: null, metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: { path: '/repo', host: 'host', machineId: 'machine' } }) });
    const rootActionId = 'widgets.item.add';
    // Home verifies a signed effect against the root authorization and refuses any other effect; the
    // daemon's own bearer reads (no effect header) are not signed and stay admitted.
    const signedOtherEffect = (config?: { headers?: Record<string, string> }) => {
      const effect = config?.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER];
      return effect !== undefined && effect !== rootActionId;
    };
    const refusedEffect = { status: 401, data: { error: 'invalid_connection_credential' } };
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const path = String(url);
      const headers = config as { headers?: Record<string, string> } | undefined;
      if (path.endsWith('/v1/account/encryption/currentness')) return signedOtherEffect(headers) ? refusedEffect : { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path.endsWith(`/v2/sessions/${sessionId}`)) return signedOtherEffect(headers) ? refusedEffect : { status: 200, data: { session } };
      if (path.endsWith('/v2/account/settings')) return { status: 200, data: AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 1 }) };
      if (path.includes('/v1/artifacts/')) return { status: 404, data: { error: 'not_found' } };
      throw new Error(`Unexpected Home read: ${url}`);
    });
    vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ protocolVersion: 1, projection: createCounterWidgetFixture().projection });
    const installation = { installationId: 'installation-1', privateKey: Buffer.alloc(64, 7).toString('base64url') };
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId, mode: 'plain', ctx: null,
      serverId: 'local-profile', serverIdentityId: homeIdentity, serverHttpBaseUrl: home,
      externalActionMachineRequestPrivateKey: installation.privateKey, externalActionMachineInstallationId: installation.installationId });
    // Home mints this; the CLI only forwards its token, request id and Home identity into the signed headers.
    const authorization = { v: 1, token: 'home-minted-authorization', binding: { actionId: rootActionId, requestId: 'req-1',
      serverIdentityId: homeIdentity } } as unknown as ExternalActionExecutionAuthorizationV1;
    const picked = { serverId: homeIdentity, sessionId };
    const resolved = await deps.widgetInputs!.resolve({
      ref: { surface: { serverId: homeIdentity, accountId: 'viewer', owner: { kind: 'home' } }, instanceId: 'summary' },
      instance: { v: 1, id: 'summary', definition: { kind: 'builtin', id: 'session_summary' }, bindings: { session: { kind: 'value', value: picked } } },
      admission: 'configuration',
      context: { surface: 'cli', authority: 'account_automation', serverId: homeIdentity, serverIdentityId: homeIdentity,
        externalActionExecutionAuthorization: authorization, externalActionTarget: { kind: 'machine', machineId: 'machine' } },
    });
    expect(resolved, JSON.stringify(resolved)).toMatchObject({ status: 'unavailable', fields: [{ path: 'session', reasonCode: 'not_authenticated' }] });
    expect(isWidgetAdmissionUndecidableHereV1({ ok: false, errorCode: 'widget_inputs_invalid', error: 'widget_inputs_invalid', details: resolved })).toBe(true);
  });
});
