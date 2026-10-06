export const PLUGIN_AUTHOR_TRANSIENT_PNPM_WORKSPACE_MARKER = '# Happier transient public author workspace';

/** The installer owns empty/interrupted files and its exact first-line marker. */
export function isPluginAuthorTransientWorkspaceConfig(contents: string): boolean {
  return contents === '' || contents.startsWith(`${PLUGIN_AUTHOR_TRANSIENT_PNPM_WORKSPACE_MARKER}\n`);
}

export const PLUGIN_DEVELOPMENT_DEPENDENCY_INPUT_PATHS = Object.freeze([
  '.npmrc',
  '.pnpmfile.cjs',
  '.pnpmfile.js',
  '.yarnrc',
  '.yarnrc.yml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
] as const);

const pluginDevelopmentInstallOnlyInputPaths = new Set<string>([
  '.npmrc',
  '.pnpmfile.cjs',
  '.pnpmfile.js',
  '.yarnrc',
  '.yarnrc.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
]);

const pluginDevelopmentDependencyInputPaths = new Set<string>(
  PLUGIN_DEVELOPMENT_DEPENDENCY_INPUT_PATHS,
);

export function isPluginDevelopmentDependencyInputPath(path: string): boolean {
  return pluginDevelopmentDependencyInputPaths.has(
    path.replaceAll('\\', '/').replace(/^\.\//u, ''),
  );
}

export function isPluginDevelopmentInstallOnlyInputPath(path: string): boolean {
  return pluginDevelopmentInstallOnlyInputPaths.has(
    path.replaceAll('\\', '/').replace(/^\.\//u, ''),
  );
}
