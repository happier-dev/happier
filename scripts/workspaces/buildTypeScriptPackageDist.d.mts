import type { CompilerOptions } from 'typescript';

/** Config produced for the canonical package declaration/build runner. */
export function createDistTypeScriptProjectConfig(input: {
  projectPath: string;
  compilerOptions?: CompilerOptions;
}): {
  extends: string;
  compilerOptions: CompilerOptions;
  exclude: string[];
  files?: string[];
};
