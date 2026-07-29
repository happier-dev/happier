import { describe, expect, it } from 'vitest';
import {
  ConnectedServiceCredentialRecordV1Schema,
  openQualifiedConnectedAccountContentEnvelope,
  parseQualifiedConnectedAccountCredentialPlaintextV1,
  projectQualifiedConnectedAccountCredentialPlaintextV1,
  sealQualifiedConnectedAccountContentEnvelope,
} from '@happier-dev/protocol';

import {
  resealQualifiedConnectedAccountMigrationCredentials,
} from './resealQualifiedConnectedAccountMigrationCredentials';

const ref = {
  service: {
    pluginId: 'happier.voice.openai',
    localId: 'openai',
  },
  accountId: 'work',
} as const;
const metadata: { scopes: string[] } = { scopes: [] };
const payload = { v: 1 as const, values: { apiKey: 'sk-test' } };
const material = {
  type: 'legacy' as const,
  secret: new Uint8Array(32).fill(7),
};

describe('resealQualifiedConnectedAccountMigrationCredentials', () => {
  it.each(['e2ee', 'plain'] as const)(
    'reseals a mapped built-in to %s through the historical plaintext codec',
    async (toMode) => {
      const sourceMode = toMode === 'e2ee' ? 'plain' : 'e2ee';
      const plaintext =
        projectQualifiedConnectedAccountCredentialPlaintextV1({
          ref,
          authenticationModeId: 'api-key',
          payload,
          metadata,
          now: 1_700_000_000_000,
        });
      const sourceContent = sourceMode === 'plain'
        ? sealQualifiedConnectedAccountContentEnvelope({
            kind: 'credential',
            accountMode: 'plain',
            payload: plaintext,
            randomBytes: (length) => new Uint8Array(length).fill(1),
          })
        : sealQualifiedConnectedAccountContentEnvelope({
            kind: 'credential',
            accountMode: 'e2ee',
            material,
            payload: plaintext,
            randomBytes: (length) => new Uint8Array(length).fill(1),
          });
      const configurationPlaintext = {
        values: { tenant: 'acme' },
        secretRefs: { clientSecret: 'saved-secret-1' },
      };
      const sourceConfigurationContent = sourceMode === 'plain'
        ? sealQualifiedConnectedAccountContentEnvelope({
            kind: 'configuration',
            accountMode: 'plain',
            payload: configurationPlaintext,
            randomBytes: (length) => new Uint8Array(length).fill(1),
          })
        : sealQualifiedConnectedAccountContentEnvelope({
            kind: 'configuration',
            accountMode: 'e2ee',
            material,
            payload: configurationPlaintext,
            randomBytes: (length) => new Uint8Array(length).fill(1),
          });

      const [migration] =
        await resealQualifiedConnectedAccountMigrationCredentials({
          toMode,
          material,
          accounts: [{
            ref,
            status: 'connected',
            authenticationModeId: 'api-key',
            credentialRevision: 'csr_1234567890123456789012',
            configurationReady: true,
            configurationRevision: 'configuration-7',
            scopes: [],
          }],
          fetchCredential: async () => ({
            ref,
            authenticationModeId: 'api-key',
            credentialRevision: 'csr_1234567890123456789012',
            configurationRevision: 'configuration-7',
            content: sourceContent,
            metadata,
          }),
          fetchConfiguration: async () => ({
            target: { kind: 'account', ref },
            authenticationModeId: 'api-key',
            credentialRevision: 'csr_1234567890123456789012',
            configurationRevision: 'configuration-7',
            configurationContent: sourceConfigurationContent,
          }),
          randomBytes: (length) => new Uint8Array(length).fill(2),
        });

      expect(migration).toMatchObject({
        ref,
        expectedCredentialRevision: 'csr_1234567890123456789012',
        expectedConfigurationRevision: 'configuration-7',
        authenticationModeId: 'api-key',
        metadata,
      });
      const migratedPlaintext = toMode === 'plain'
        ? openQualifiedConnectedAccountContentEnvelope({
            kind: 'credential',
            accountMode: 'plain',
            envelope: migration!.replacementCredentialContentEnvelope,
          })
        : openQualifiedConnectedAccountContentEnvelope({
            kind: 'credential',
            accountMode: 'e2ee',
            material,
            envelope: migration!.replacementCredentialContentEnvelope,
          });
      expect(migratedPlaintext).toEqual(plaintext);
      expect(ConnectedServiceCredentialRecordV1Schema.parse(migratedPlaintext))
        .toMatchObject({
        serviceId: 'openai',
        profileId: 'work',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        kind: 'token',
      });
      expect(parseQualifiedConnectedAccountCredentialPlaintextV1({
        ref,
        authenticationModeId: 'api-key',
        plaintext: migratedPlaintext,
        metadata,
      })).toEqual(payload);
      const migratedConfiguration = toMode === 'plain'
        ? openQualifiedConnectedAccountContentEnvelope({
            kind: 'configuration',
            accountMode: 'plain',
            envelope:
              migration!.replacementConfigurationContentEnvelope!,
          })
        : openQualifiedConnectedAccountContentEnvelope({
            kind: 'configuration',
            accountMode: 'e2ee',
            material,
            envelope:
              migration!.replacementConfigurationContentEnvelope!,
          });
      expect(migratedConfiguration).toEqual(configurationPlaintext);
    },
  );
});
