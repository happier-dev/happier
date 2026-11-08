import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { isRegistryObject } from './commitRecordSchema';

const needsReapproval: PluginCompatibilityDiagnostic = {
  code: 'plugin_trust_approval_required',
  message: 'The stored approved authority no longer matches the current plugin contract. Review and approve the plugin again.',
  details: { reason: 'needs_reapproval' },
};

function withoutApproval(record: Record<string, unknown>): Record<string, unknown> {
  const { approvedAuthorityManifest: _approval, trust: _trust, ...rest } = record;
  return rest;
}

function unavailableCatalogRecord(value: unknown): unknown {
  if (!isRegistryObject(value) || !isRegistryObject(value.install) || !isRegistryObject(value.compatibility)) return value;
  const { trust: _trust, ...install } = value.install;
  return {
    ...value,
    install,
    compatibility: {
      ...value.compatibility,
      status: 'load_error',
      diagnostics: [
        ...(Array.isArray(value.compatibility.diagnostics) ? value.compatibility.diagnostics : []),
        needsReapproval,
      ],
    },
  };
}

/**
 * A failed approval is never accepted as a manifest. Withdraw only that row's
 * execution authority and project the existing repair diagnostic. The caller
 * still validates the complete remaining revision; framing/identity corruption
 * cannot be converted into a successful read. No stored bytes are changed.
 */
export function isolateInstallationApprovalFailures(
  value: unknown,
  issues: readonly Readonly<{ path: readonly PropertyKey[] }>[],
): unknown {
  if (!isRegistryObject(value) || !isRegistryObject(value.plugins)) return value;
  const plugins = { ...value.plugins };
  const runtimeCatalog = isRegistryObject(value.runtimeCatalog) && isRegistryObject(value.runtimeCatalog.plugins)
    ? { ...value.runtimeCatalog, plugins: { ...value.runtimeCatalog.plugins } }
    : null;
  const rollbackRetention = Array.isArray(value.rollbackRetention) ? [...value.rollbackRetention] : null;
  const retainedRuntimeCatalog = isRegistryObject(value.retainedRuntimeCatalog) ? { ...value.retainedRuntimeCatalog } : null;
  const rejected = new Set<string | number>();
  for (const { path } of issues) {
    const [collection, key, field] = path;
    if (field !== 'approvedAuthorityManifest') continue;
    if (collection === 'plugins' && typeof key === 'string' && !rejected.has(key)) {
      const record = plugins[key];
      if (!isRegistryObject(record)) continue;
      rejected.add(key);
      plugins[key] = withoutApproval(record);
      if (runtimeCatalog && Object.hasOwn(runtimeCatalog.plugins, key)) {
        runtimeCatalog.plugins[key] = unavailableCatalogRecord(runtimeCatalog.plugins[key]);
      }
    } else if (collection === 'rollbackRetention' && typeof key === 'number' && !rejected.has(key)) {
      const record = rollbackRetention?.[key];
      if (!isRegistryObject(record)) continue;
      rejected.add(key);
      rollbackRetention![key] = { ...withoutApproval(record), byteAvailability: 'sourceIneligible' };
      if (retainedRuntimeCatalog && typeof record.immutableGenerationId === 'string'
        && Object.hasOwn(retainedRuntimeCatalog, record.immutableGenerationId)) {
        retainedRuntimeCatalog[record.immutableGenerationId] = unavailableCatalogRecord(retainedRuntimeCatalog[record.immutableGenerationId]);
      }
    }
  }
  if (rejected.size === 0) return value;
  return {
    ...value,
    plugins,
    ...(runtimeCatalog ? { runtimeCatalog } : {}),
    ...(rollbackRetention ? { rollbackRetention } : {}),
    ...(retainedRuntimeCatalog ? { retainedRuntimeCatalog } : {}),
  };
}
