import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { resolveSessionSpawnConnectedServicesDefaultsPayload, resolveSpawnConnectedServicesDefaultDisposition } from './spawnConnectedServicesDefaults';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

function declaredPurpose() {
  const purpose = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'codex',
    contributions: readCurrentContributionRegistry() })?.authorizedPurposes.find(scope => scope.serviceRefs[0]?.localId === 'openai-codex');
  if (!purpose) throw new Error('Bundled Codex purpose is unavailable');
  return purpose;
}

describe('spawn defaults from the current purpose catalog', () => {
  it('reports a disconnected live observation despite healthy HTTP and recovers the same invocation on reconnect', async () => {
    const accountId = 'spawn-default-observation';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const base = 'https://purpose-observation.example';
    const currentness = { mode: 'plain', version: 1, settingsVersion: 7,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };
    const purposeRow = { status: 'present', revision: 32,
      content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } };
    const channel = await createRequesterCurrentnessSocketHarness();
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/currentness')) return { status: 200, data: currentness };
      if (path.endsWith('/connected-accounts/purposes')) return { status: 200, data: purposeRow };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      return { status: 404, data: { error: 'unsupported' } };
    });
    const holder = acquireRequesterAccountEncryptionCurrentness({ accountId, token: credentials.token, serverBaseUrl: base });
    try {
      await holder.read();
      await runWithServerHttpBaseUrl(base, async () => {
        const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: base,
          snapshot: { source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials), loadedAtMs: 1,
            settingsVersion: 7, settings: accountSettingsParse({}), rawSettings: {}, settingsSecretsReadKeys: [],
            connectedPurposeCatalog: { status: 'unavailable', reason: 'unreachable' } },
          isCurrent: async () => true });
        const admit = () => resolveSessionSpawnConnectedServicesDefaultsPayload({ agentId: 'codex', credentials, operationContext });
        await expect(admit()).resolves.toBeNull();
        await channel.disconnect();
        expect((await axios.get(`${base}/v1/account/encryption/currentness`)).status).toBe(200);
        expect((await axios.get(`${base}/v1/account/entity-rows/connected-accounts/purposes`)).data).toEqual(purposeRow);
        const refusal = await admit().then(() => { throw new Error('Expected disconnected observation refusal'); },
          error => normalizeActionExecutorThrownError(error));
        expect(refusal).toMatchObject({ errorCode: 'connected_services_default_unavailable', details: {
          reason: 'connected_account_purpose_catalog_unavailable', catalogReason: 'unreachable',
        } });
        await channel.reconnect();
        await expect(admit()).resolves.toBeNull();
      });
    } finally {
      await holder.dispose();
      await channel.close();
    }
  });

  it.each(['forbidden', 'account-mode-mismatch'] as const)(
    'preserves the %s purpose admission refusal through the Action boundary', async catalogReason => {
      const credentials = { token: `purpose-refusal-${catalogReason}`, encryption: null };
      vi.spyOn(axios, 'get').mockImplementation(async input => {
        const path = new URL(String(input)).pathname;
        if (path === '/v2/account/settings') return { status: 200,
          data: { version: 7, content: { t: 'plain', v: {} } } };
        if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path.endsWith('/connected-accounts/purposes')) return catalogReason === 'forbidden'
          ? { status: 403, data: { error: 'forbidden' } }
          : { status: 200, data: { status: 'present', revision: 32, content: { t: 'encrypted', c: 'synthetic-invalid-content' } } };
        if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 404, data: { error: 'unsupported' } };
        throw new Error(`Unexpected Home demand: ${path}`);
      });
      await runWithServerHttpBaseUrl('https://purpose-refusal.example', async () => {
        const operationContext = createInvocationSavedSecretOperationContextV1({ credentials,
          serverHttpBaseUrl: 'https://purpose-refusal.example',
          snapshot: { source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials), loadedAtMs: 1,
            settingsVersion: 7, settings: accountSettingsParse({}), rawSettings: {}, settingsSecretsReadKeys: [] },
          isCurrent: async () => true });
        const refusal = await resolveSessionSpawnConnectedServicesDefaultsPayload({ agentId: 'codex', credentials, operationContext })
          .then(() => { throw new Error('Expected purpose admission refusal'); }, error => normalizeActionExecutorThrownError(error));
        expect(refusal).toMatchObject({ errorCode: 'connected_services_default_unavailable', details: {
          v: 1, source: 'account_default', reason: 'connected_account_purpose_catalog_unavailable',
          phase: 'purpose_binding', catalogReason,
        } });
      });
    },
  );

  it('preserves the qualified declared group from an opened row without a Settings mirror', () => {
    const scope = declaredPurpose();
    const service = scope.serviceRefs[0]!;
    expect(resolveSpawnConnectedServicesDefaultDisposition({ accountSettings: {}, agentId: 'codex',
      ...{ purposeCatalog: { status: 'ready' as const, revision: 3, record: { key: 'purposes' as const,
        value: { v: 1 as const, bindings: [{ purpose: scope.purpose, target: { kind: 'group' as const, service, groupId: 'selected-group' } }] } } } },
    })).toEqual({ kind: 'connected', bindings: { v: 2, bindingsByServiceId: {
      [`${service.pluginId}/${service.localId}`]: { source: 'connected', selection: 'group', groupId: 'selected-group' },
    } } });
  });

  it('refuses unavailable catalog truth instead of using a retained legacy default', () => {
    expect(resolveSpawnConnectedServicesDefaultDisposition({ agentId: 'codex', accountSettings: {
      connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: { codex: { v: 1, bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'legacy-account' },
      } } } },
    }, ...{ purposeCatalog: { status: 'unavailable' as const, reason: 'account-mode-mismatch' as const } },
    })).toEqual({ kind: 'unavailable', reason: 'connected_account_purpose_catalog_unavailable', catalogReason: 'account-mode-mismatch' });
  });

  it.each(['connectedServicesDefaultAuthByAgentIdV1', 'connectedServicesAdditionalDefaultAuthByAgentIdV1'] as const)(
    'does not resurrect predecessor %s after an opened purpose row is cleared', carrier => {
      expect(resolveSpawnConnectedServicesDefaultDisposition({ agentId: 'codex', accountSettings: {
        [carrier]: { v: 1, bindingsByAgentId: { codex: { v: 1, bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'legacy-account' },
        } } } },
      }, ...{ purposeCatalog: { status: 'ready' as const, revision: 3, record: { key: 'purposes' as const,
        value: { v: 1 as const, bindings: [] } } } },
      })).toEqual({ kind: 'native' });
    },
  );

  it('does not resurrect a predecessor default cleared after bootstrap but before the purpose row is opened', async () => {
    const credentials = { token: 'spawn-carrier-retirement', encryption: null };
    const initialRaw = { connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {
      codex: { v: 1, bindingsByServiceId: { 'openai-codex': {
        source: 'connected', selection: 'profile', profileId: 'retired-default',
      } } },
    } } };
    const currentRaw = { connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} } };
    let settingsReads = 0;
    // Real bootstrap, invocation custody and catalog loading; only Home HTTP
    // is replaced to expose the actual paired-clear frontier between reads.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v2/account/settings') {
        settingsReads += 1;
        return { status: 200, data: { version: settingsReads === 1 ? 7 : 9,
          content: { t: 'plain', v: settingsReads === 1 ? initialRaw : currentRaw } } };
      }
      if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path.endsWith('/connected-accounts/purposes')) return { status: 200, data: { status: 'present', revision: 4,
        content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } };
      if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 404, data: { error: 'unsupported' } };
      throw new Error(`Unexpected Home demand: ${path}`);
    });
    await runWithServerHttpBaseUrl('https://spawn-home.example', async () => {
      const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://spawn-home.example',
        snapshot: { source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials), loadedAtMs: 1,
          settingsVersion: 7, settings: accountSettingsParse(initialRaw), rawSettings: initialRaw, settingsSecretsReadKeys: [] },
        isCurrent: async () => true });
      await expect(resolveSessionSpawnConnectedServicesDefaultsPayload({ agentId: 'codex', credentials, operationContext })).resolves.toBeNull();
      // The opened row is authoritative at admission, even while the obsolete
      // Settings carrier is retained. Source/history cleanup must not block it.
      expect(operationContext.readSnapshot()).toMatchObject({ connectedPurposeCatalog: {
        status: 'ready', revision: 4, record: { key: 'purposes', value: { v: 1, bindings: [] } },
      } });
      // Observe the independent cleanup publication rather than assuming its
      // Settings read completed before the admission promise settled.
      await vi.waitFor(() => {
        expect(operationContext.readSnapshot()).toMatchObject({ settingsVersion: 9, rawSettings: currentRaw });
      });
    });
  });
});
