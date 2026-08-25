export type UnresolvedVitestPathArgReason = 'missing' | 'no-test-files';

export type UnresolvedVitestPathArg = {
  arg: string;
  reason: UnresolvedVitestPathArgReason;
};

export declare const VITEST_OPTIONS_WITH_VALUES: ReadonlySet<string>;

export declare function collectPositionalArgs(args: readonly string[]): string[];
export declare function isPathShapedArg(value: string): boolean;
export declare function findUnresolvedVitestPathArgs(
  args: readonly string[],
  options: { packageRoot: string },
): UnresolvedVitestPathArg[];
export declare function formatUnresolvedVitestPathArgs(
  unresolved: readonly UnresolvedVitestPathArg[],
): string;
