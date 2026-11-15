import { describe, expect, it } from 'vitest';

// Import-boundary enforcement belongs to scripts/testing/migrations. These
// assertions cover SDK API ownership, which a source-import fence cannot prove.
const apiSurfaceSourceModulePath: string = '../scripts/apiSurfaceCli.mjs';
type PublicSdkInventory = Readonly<{
  symbols: readonly Readonly<{
    specifier: string;
    exportName: string;
    kind: string;
  }>[];
}>;
// Generate the shared API fixture during collection, like the other API
// inventory contracts; its work is not part of the first assertion's lifetime.
const publisher = await import(apiSurfaceSourceModulePath) as Readonly<{
  readCurrentApiSurfaceInventory(): Promise<PublicSdkInventory>;
}>;
const publicSdkInventory = await publisher.readCurrentApiSurfaceInventory();

async function readPublicSdkOwners(kind: 'type' | 'value', symbols: readonly string[]) {
  const inventory = publicSdkInventory;
  return Object.fromEntries(symbols.map((symbol) => [
    symbol,
    inventory.symbols.filter((entry) => entry.exportName === symbol && entry.kind === kind)
      .map((entry) => entry.specifier).sort(),
  ]));
}

describe('public SDK domain ownership', () => {
  it('publishes Account storage and dynamic Resource types from their one public domain', async () => {
    expect(await readPublicSdkOwners('type', [
      'PluginAccountStorageScope',
      'PluginDynamicResourceInvocationOptionsV1',
      'PluginDynamicResourceRuntime',
    ])).toEqual({
      PluginAccountStorageScope: ['./storage'],
      PluginDynamicResourceInvocationOptionsV1: ['./resources'],
      PluginDynamicResourceRuntime: ['./resources'],
    });
  });

  it('publishes generic provider-limit evidence from Connected Accounts alone', async () => {
    expect(await readPublicSdkOwners('type', [
      'ProviderLimitCategory',
      'ProviderLimitEvidenceClassification',
      'ProviderLimitEvidenceConfidence',
      'ProviderLimitEvidenceProvenance',
    ])).toEqual({
      ProviderLimitCategory: ['./connected-accounts'],
      ProviderLimitEvidenceClassification: ['./connected-accounts'],
      ProviderLimitEvidenceConfidence: ['./connected-accounts'],
      ProviderLimitEvidenceProvenance: ['./connected-accounts'],
    });
    expect(await readPublicSdkOwners('value', [
      'PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1',
      'classifyProviderLimitEvidence',
    ])).toEqual({
      PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1: ['./connected-accounts'],
      classifyProviderLimitEvidence: ['./connected-accounts'],
    });
  });

  it('keeps retired executable aliases and Provider runtime vocabulary out of the Agent runtime API', async () => {
    const inventory = publicSdkInventory;
    const names = new Set(inventory.symbols
      .filter((entry) => entry.specifier === './agents/runtime')
      .map((entry) => entry.exportName));
    for (const retired of [
      'AcpSessionRuntimeV1',
      'AgentRuntimeV1',
      'AgentSessionRuntimeEventV1',
      'AgentSessionRuntimeEventV1Schema',
      'ExecutionRunBackend',
      'ExecutionRunBackendV1',
      'RuntimeControlContribution',
      'RuntimeCoreV1',
      'RuntimeEventV1',
      'RuntimeEventV1Schema',
      'Provider',
      'ProviderRuntime',
      'ProviderSessionRuntime',
    ]) expect(names.has(retired), retired).toBe(false);
  });
});
