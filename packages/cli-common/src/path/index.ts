export {
  canonicalAbsolutePathsEqual,
  createCanonicalAbsolutePathComparator,
  expandHomeDirPath,
  isCanonicalAbsolutePathInsideRoot,
  resolveCanonicalAbsoluteChildPathComparisonIdentity,
  resolveCanonicalAbsolutePath,
  resolveCanonicalAbsolutePathComparisonIdentity,
  resolveHomeDirFromEnvironment,
} from './expandHomeDirPath.js';
export type { CanonicalAbsolutePath } from './expandHomeDirPath.js';

export { absolutePathFromWorkingDirectory } from './absolutePathFromWorkingDirectory.js';
