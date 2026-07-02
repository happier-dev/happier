export type CatalogAcpBackendOwner = Readonly<{
  getAcpBackendFactory?: unknown;
  getAcpRuntimeDefinitionBridge?: unknown;
}>;

export function hasCatalogAcpBackendOwner(
  entry: CatalogAcpBackendOwner | null | undefined,
): boolean {
  return (
    typeof entry?.getAcpRuntimeDefinitionBridge === 'function' ||
    typeof entry?.getAcpBackendFactory === 'function'
  );
}
