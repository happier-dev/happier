import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';

import { getActionSpec } from './actionSpecs.js';
import {
  ExternalSessionOperationStatusInputV1Schema,
} from '../sessions/external/operationActionSchemasV1.js';

describe('ActionSpec registry portability', () => {
  it('runs the bundled canonical schemas without Node globals or external runtime imports', async () => {
    const source = fileURLToPath(new URL('./actionSpecs.ts', import.meta.url));
    const chunks: string[] = [];
    const externalImports: string[] = [];
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
            ? `import { getActionSpec } from ${JSON.stringify(source)};
              const spec = getActionSpec('session.spawn_new');
              const input = {
                creationKey: 'browser-attempt',
                executionTarget: { serverId: 'server', machineId: 'machine' },
                directory: { kind: 'path', path: '/workspace' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
              };
              globalThis.actionSchemaResult = {
                id: spec.id,
                accepted: spec.inputSchema.safeParse(input).success,
                unknownFieldAccepted: spec.inputSchema.safeParse({ ...input, callerAuthority: 'present_user' }).success,
                rpcMissingKeyAccepted: spec.surfaceBindings.rpc.inputSchema.safeParse({ ...input, creationKey: undefined }).success,
              };`
            : null;
        },
        generateBundle(_options, bundle) {
          for (const chunk of Object.values(bundle)) {
            if (chunk.type !== 'chunk') continue;
            externalImports.push(...chunk.imports, ...chunk.dynamicImports);
            chunks.push(chunk.code);
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
          output: { format: 'iife', inlineDynamicImports: true },
        },
      },
    });
    expect(externalImports).toEqual([]);
    expect(chunks).toHaveLength(1);
    const browser = { URL, TextEncoder, TextDecoder, actionSchemaResult: undefined };
    runInNewContext(chunks[0]!, browser);
    expect(browser.actionSchemaResult).toEqual({
      id: 'session.spawn_new',
      accepted: true,
      unknownFieldAccepted: false,
      rpcMissingKeyAccepted: false,
    });
  }, 30_000);

  it('retains schema identity through the incumbent crypto facades', async () => {
    const [metadata, portableMetadata, authorization, portableAuthorization, usage, portableUsage, usageRefs] = await Promise.all([
      import('../sessions/metadata/sessionMetadataEnvelopesV1.js'),
      import('../sessions/metadata/sessionMetadataSchemasV1.js'),
      import('../machines/peer/mediation/tunnel/authorization.js'),
      import('../machines/peer/mediation/tunnel/authorizationSchemas.js'),
      import('../connect/accountUsage.js'),
      import('../connect/providerAccountUsagePrimitives.js'),
      import('../sessions/metadata/providerAccountUsageRefsV1.js'),
    ]);
    expect(metadata.SessionSharedMetadataV1Schema).toBe(portableMetadata.SessionSharedMetadataV1Schema);
    expect(metadata.SessionOwnerMetadataV1Schema).toBe(portableMetadata.SessionOwnerMetadataV1Schema);
    expect(metadata.SessionOwnerMetadataEnvelopeV1Schema).toBe(portableMetadata.SessionOwnerMetadataEnvelopeV1Schema);
    expect(authorization.PeerTcpTunnelRelayAuthorizationV2Schema).toBe(portableAuthorization.PeerTcpTunnelRelayAuthorizationV2Schema);
    expect(authorization.ProviderBrokerExternalApiKeyRelayBindingV1Schema).toBe(portableAuthorization.ProviderBrokerExternalApiKeyRelayBindingV1Schema);
    expect(usage.ProviderAccountUsageSnapshotV1Schema).toBe(portableUsage.ProviderAccountUsageSnapshotV1Schema);
    expect(usageRefs.ProviderAccountUsageRefsV1Schema.shape.recordIds.element).toBe(portableUsage.ProviderAccountUsageRecordIdSchema);
  });

  it('retains the canonical external-operation schema in the registry', () => {
    const spec = getActionSpec('sessions.external.operation.status.get');
    expect(spec.id).toBe('sessions.external.operation.status.get');
    expect(spec.inputSchema).toBe(ExternalSessionOperationStatusInputV1Schema);
  });
});
