/** Reserved namespaces never belong to the external author API. */
export const AUTHOR_EXCLUDED_ENTRYPOINT_ROOTS = Object.freeze({
  '@happier-dev/plugin-sdk': Object.freeze(['./host', './first-party']),
  '@happier-dev/plugin-ui': Object.freeze(['./presentation']),
});

export function isAuthorPackageExport(packageName, specifier) {
  return !(AUTHOR_EXCLUDED_ENTRYPOINT_ROOTS[packageName] ?? []).some((root) => (
    specifier === root || specifier.startsWith(`${root}/`)
  ));
}
