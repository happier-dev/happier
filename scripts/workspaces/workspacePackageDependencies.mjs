export function collectInternalWorkspaceDependencyNames(
  packageJson,
  currentPackageName,
  { includeDevDependencies = true, workspacePackageNames = null } = {},
) {
  const knownWorkspacePackageNames = workspacePackageNames
    ? new Set(workspacePackageNames)
    : null;
  const names = [];
  const dependencyFields = [packageJson?.dependencies, packageJson?.optionalDependencies];
  if (includeDevDependencies) dependencyFields.push(packageJson?.devDependencies);
  for (const dependencies of dependencyFields) {
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) {
      const isInternalWorkspace = knownWorkspacePackageNames
        ? knownWorkspacePackageNames.has(name)
        : name.startsWith('@happier-dev/');
      if (!isInternalWorkspace || name === currentPackageName) continue;
      names.push(name);
    }
  }
  return names;
}

export function collectAdmittedInternalWorkspacePeerDependencyNames(
  packageJson,
  currentPackageName,
  { admittedWorkspacePackageNames, workspacePackageNames },
) {
  const peers = packageJson?.peerDependencies;
  if (!peers || typeof peers !== 'object' || Array.isArray(peers)) return [];
  return Object.keys(peers).filter((name) => (
    name !== currentPackageName
    && workspacePackageNames.has(name)
    && admittedWorkspacePackageNames.has(name)
  ));
}
