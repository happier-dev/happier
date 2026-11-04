export type DaemonOptionalCapability = 'account_catalogs' | 'plugin_runtime' | 'connected_service_reconcile';

export type DaemonOptionalCapabilityResult =
  | Readonly<{ status: 'ready'; capability: DaemonOptionalCapability }>
  | Readonly<{ status: 'unavailable'; capability: DaemonOptionalCapability; error: unknown }>;

/** Startup consumes the settled capability result separately from its readiness. */
export function settleDaemonOptionalCapability(
  capability: DaemonOptionalCapability,
  operation: Promise<unknown>,
  reportUnavailable: (result: Extract<DaemonOptionalCapabilityResult, { status: 'unavailable' }>) => void,
): Promise<DaemonOptionalCapabilityResult> {
  return operation.then(
    () => ({ status: 'ready', capability }),
    (error: unknown) => {
      const result = { status: 'unavailable', capability, error } as const;
      reportUnavailable(result);
      return result;
    },
  );
}
