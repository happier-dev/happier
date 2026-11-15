/** Reserved namespaces never belong to the external author API. */
export const AUTHOR_EXCLUDED_ENTRYPOINT_ROOTS = Object.freeze({
  '@happier-dev/plugin-sdk': Object.freeze(['./host', './first-party']),
  '@happier-dev/plugin-ui': Object.freeze(['./presentation']),
});

// The host root also carries these deliberate host adapters. Keep this
// classification beside the namespace exclusions, never in individual reports.
const HOST_ROOT_EXPORTS = Object.freeze({
  '@happier-dev/plugin-ui': Object.freeze(['HostCollection', 'HostCollectionProps']),
});

export function isAuthorPackageSymbol(packageName, { specifier, exportName }) {
  return !(specifier === '.' && (HOST_ROOT_EXPORTS[packageName] ?? []).includes(exportName));
}

export function isAuthorPackageExport(packageName, specifier) {
  return !(AUTHOR_EXCLUDED_ENTRYPOINT_ROOTS[packageName] ?? []).some((root) => (
    specifier === root || specifier.startsWith(`${root}/`)
  ));
}
