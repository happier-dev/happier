/** Exported host seams are available to first-party hosts, not external authors. */
export const AUTHOR_EXCLUDED_ENTRYPOINT_ROOTS = Object.freeze({
  '@happier-dev/plugin-sdk': Object.freeze(['./host']),
  '@happier-dev/plugin-ui': Object.freeze(['./presentation']),
});

export function isAuthorPackageExport(packageName, specifier) {
  return !(AUTHOR_EXCLUDED_ENTRYPOINT_ROOTS[packageName] ?? []).some((root) => (
    specifier === root || specifier.startsWith(`${root}/`)
  ));
}
