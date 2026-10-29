export {
  WORKSPACE_PACKAGE_BUILD_INPUT_RECORD,
  collectPackageBuildOutputTargets,
  isLocalPackageBuildOutputTarget,
  isPackageBuildDistOutputTarget,
  resolvePackageBuildOutputTargetMatches,
  resolvePackageBuildOutputTargetPath,
} from '../../packages/cli-common/packageBuildOutputTargets.mjs';

export function resolvePackageDeclarationTarget(value) {
  if (typeof value === 'string') return /\.d\.[cm]?ts$/.test(value) ? value : undefined;
  if (!value || typeof value !== 'object') return;
  return resolvePackageDeclarationTarget(value.types)
    ?? Object.values(value).map(resolvePackageDeclarationTarget).find(Boolean);
}
