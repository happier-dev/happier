import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, SavedSecretSchema } from '@happier-dev/protocol';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import * as persistence from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDaemonPluginRawCredentialMaterializer } from './daemonRawCredentialMaterializer';

const contribution = { pluginId: 'acme.voice', localId: 'speech' };
const request = { kind: 'httpHeaders' as const, origin: 'https://speech.example.test', headerNames: ['authorization'] };
const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({ id: contribution.pluginId,
  contributes: { voiceProviders: [{ id: contribution.localId, title: 'Speech', kind: 'speech', roles: ['conversation_tts'],
    platforms: ['web'], settings: { schemaVersion: 2, fields: [{ id: 'voiceName', title: 'Voice', schema: { type: 'string', minLength: 1, maxLength: 256 },
      default: 'test', presentation: { control: 'text' } }, { id: 'format', title: 'Format', schema: { type: 'string', enum: ['mp3', 'wav'] },
      default: 'mp3', presentation: { control: 'select', options: [{ value: 'mp3', title: 'MP3' }, { value: 'wav', title: 'WAV' }] } }] },
    credentials: { slot: { id: 'api_key', purpose: 'voice.speech', title: 'API key' }, requirement: { kind: 'always' },
      sources: [{ kind: 'savedSecret', secretKinds: ['apiKey'], rawGrants: [{ realm: 'daemon', phase: 'speech', request }] }] },
  }] },
}));

describe('daemon raw Voice source admission from a Connected purpose catalog', () => {
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

  it.each(['ready', 'mode-mismatch'] as const)(
    'admits %s purpose authority before inspecting credentials when genuine Settings already exist', async outcome => {
      const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'raw-voice-owner' })).toString('base64url')}.signature`, encryption: null };
      const raw = { futurePreference: { retained: true }, secrets: [SavedSecretSchema.parse({ id: 'voice-key', name: 'Voice key',
        kind: 'apiKey', encryptedValue: { _isSecretValue: true, value: 'private-voice-material' }, createdAt: 1, updatedAt: 1 })],
        voiceSettingsV1: { credentialBindings: [{ contribution, credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' }, credentialBindings: { account: { api_key: 'voice-key' } } }] } };
      setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
        settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], settings: accountSettingsParse(raw), rawSettings: raw });
      // HTTP and stored credentials are the system boundaries. Declaration,
      // source selection, purpose opening and permission inspection stay real.
      vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
      vi.spyOn(axios, 'get').mockImplementation(async input => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path.endsWith('/connected-accounts/purposes')) return { status: 200, data: { status: 'present', revision: 4,
          content: outcome === 'ready' ? { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } }
            : { t: 'encrypted', c: 'opaque-other-mode-content' } } };
        if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: raw } } };
        if (path === PROFILE_TRANSFER_ROUTE_V1 || path.includes('/settings/history')) return { status: 404, data: { error: 'unsupported' } };
        throw new Error(`Unexpected Home request: ${path}`);
      });
      const inspector = createDaemonPluginRawCredentialMaterializer({ mode: 'authorization',
        binding: { manifest, contribution, realm: 'daemon', phase: 'speech', machineId: null,
          materialization: { pluginId: contribution.pluginId, machineId: 'machine-a', materializationId: 'materialization-a' },
          isRuntimeAuthorityCurrent: () => true },
        readStoredCredentials: persistence.readStoredCredentials,
        // The host supplies its current OS installation identity at this port.
        readCurrentGrantAuthoritySource: async () => ({ kind: 'machine_installation', machineId: 'machine-a', installationId: 'installation-a' }),
      });
      if (outcome === 'ready') {
        await expect(inspector.inspectAuthorization(request)).resolves.toMatchObject({ capability: 'credentials.materialize.raw',
          subject: { kind: 'credential_access_disclosure' } });
        expect(getActiveAccountSettingsSnapshot()?.connectedPurposeCatalog).toMatchObject({ status: 'ready', revision: 4 });
      } else {
        await expect(inspector.inspectAuthorization(request)).rejects.toMatchObject({ code: 'plugin_voice_credential_access_unavailable' });
        expect(getActiveAccountSettingsSnapshot()?.connectedPurposeCatalog).toMatchObject({ status: 'unavailable', reason: 'account-mode-mismatch' });
      }
      expect(getActiveAccountSettingsSnapshot()?.settings.voiceSettingsV1).toEqual(accountSettingsParse(raw).voiceSettingsV1);
      expect(getActiveAccountSettingsSnapshot()?.rawSettings).toEqual(raw);
    },
  );
});
