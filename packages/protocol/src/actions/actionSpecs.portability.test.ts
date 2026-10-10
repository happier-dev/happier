import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

import { getActionSpec } from './actionSpecs.js';
import {
  ExternalSessionOperationStatusInputV1Schema,
} from '../sessions/external/operationActionSchemasV1.js';

vi.mock('../sessions/external/operationActionsV1.js', () => {
  throw new Error(
    'ActionSpec registry initialized the mixed External Sessions operation owner',
  );
});

vi.mock('../machines/peer/mediation/stream/index.js', () => {
  throw new Error(
    'ActionSpec registry initialized the mixed live-stream transport barrel',
  );
});

describe('ActionSpec registry portability', () => {
  it('bundles the canonical schema closure without runtime crypto or Node dependencies', async () => {
    const source = fileURLToPath(new URL('./actionSpecs.ts', import.meta.url));
    const forbiddenModules: string[] = [];
    const forbiddenImportChains: string[][] = [];
    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [{
        name: 'protocol-action-schema-portability',
        resolveId(id) {
          return id === 'virtual:protocol-actions' ? `\0${id}` : null;
        },
        load(id) {
          return id === '\0virtual:protocol-actions'
            ? `export { getActionSpec } from ${JSON.stringify(source)};`
            : null;
        },
        generateBundle() {
          for (const id of this.getModuleIds()) {
            if (
              id.includes('/tweetnacl/')
              || id.startsWith('node:')
              || id.includes('__vite-browser-external')
              || id.endsWith('/crypto/accountScopedCipher.ts')
              || id.endsWith('/sessions/metadata/sessionMetadataEnvelopesV1.ts')
              || id.endsWith('/machines/peer/mediation/tunnel/authorization.ts')
            ) {
              forbiddenModules.push(id);
              const chain = [id];
              let current = id;
              while (current !== source) {
                const importer = this.getModuleInfo(current)?.importers.find((candidate) => !chain.includes(candidate));
                if (!importer) break;
                chain.unshift(importer);
                current = importer;
              }
              forbiddenImportChains.push(chain);
            }
          }
        },
      }],
      build: {
        target: 'es2022',
        minify: false,
        write: false,
        rollupOptions: {
          input: 'virtual:protocol-actions',
          preserveEntrySignatures: 'strict',
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    expect(forbiddenModules, JSON.stringify(forbiddenImportChains, null, 2)).toEqual([]);
  }, 30_000);

  it('retains schema identity through the incumbent crypto facades', async () => {
    const [metadata, portableMetadata, authorization, portableAuthorization, usage, portableUsage, usageRefs,
      profileTransfer, profileTransferSchema] = await Promise.all([
      import('../sessions/metadata/sessionMetadataEnvelopesV1.js'),
      import('../sessions/metadata/sessionMetadataSchemasV1.js'),
      import('../machines/peer/mediation/tunnel/authorization.js'),
      import('../machines/peer/mediation/tunnel/authorizationSchemas.js'),
      import('../connect/accountUsage.js'),
      import('../connect/providerAccountUsagePrimitives.js'),
      import('../sessions/metadata/providerAccountUsageRefsV1.js'),
      import('../profiles/profileTransferV1.js'),
      import('../profiles/profileTransferSchemaV1.js'),
    ]);
    expect(metadata.SessionSharedMetadataV1Schema).toBe(portableMetadata.SessionSharedMetadataV1Schema);
    expect(metadata.SessionOwnerMetadataV1Schema).toBe(portableMetadata.SessionOwnerMetadataV1Schema);
    expect(metadata.SessionOwnerMetadataEnvelopeV1Schema).toBe(portableMetadata.SessionOwnerMetadataEnvelopeV1Schema);
    expect(authorization.PeerTcpTunnelRelayAuthorizationV2Schema).toBe(portableAuthorization.PeerTcpTunnelRelayAuthorizationV2Schema);
    expect(authorization.ProviderBrokerExternalApiKeyRelayBindingV1Schema).toBe(portableAuthorization.ProviderBrokerExternalApiKeyRelayBindingV1Schema);
    expect(usage.ProviderAccountUsageSnapshotV1Schema).toBe(portableUsage.ProviderAccountUsageSnapshotV1Schema);
    expect(usageRefs.ProviderAccountUsageRefsV1Schema.shape.recordIds.element).toBe(portableUsage.ProviderAccountUsageRecordIdSchema);
    expect(profileTransfer.ProfileTransferContentV1Schema).toBe(profileTransferSchema.ProfileTransferContentV1Schema);
    expect(profileTransfer.ProfileTransferMutationV1Schema).toBe(profileTransferSchema.ProfileTransferMutationV1Schema);
  });

  it('initializes without evaluating mixed socket, persistence, or transport owners', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const {
      ExternalSessionOperationStatusInputV1Schema,
    } = await import('../sessions/external/operationActionSchemasV1.js');

    const spec = getActionSpec('sessions.external.operation.status.get');
    expect(spec.id).toBe('sessions.external.operation.status.get');
    expect(spec.inputSchema).toBe(ExternalSessionOperationStatusInputV1Schema);
  });
});
