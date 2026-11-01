import { existsSync, readFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

export function readTypeScriptBuildInputFileNames(tsBuildInfoFile) {
  const buildInfo = JSON.parse(readFileSync(tsBuildInfoFile, 'utf8'));
  if (!Array.isArray(buildInfo?.fileNames)) throw new Error('Invalid TypeScript compiler input inventory');
  return buildInfo.fileNames;
}

export async function pruneRetiredCompilerOutputs({ packageDir, compilerWorkTree, compilerArgs }) {
  const { outputDir, tsBuildInfoFile, projectPath } = compilerWorkTree;
  // Without incremental metadata the next build already resets the output
  // tree. The compiler's full input inventory includes imported sources that
  // need not be roots of the project config.
  if (!existsSync(tsBuildInfoFile)) return;
  const configPath = join(compilerWorkTree.workDir, 'tsconfig.dist.json');
  const config = ts.getParsedCommandLineOfConfigFile(configPath, ts.parseCommandLine(compilerArgs).options, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  const sourcePathBases = [dirname(tsBuildInfoFile), dirname(projectPath), packageDir];
  config.fileNames = readTypeScriptBuildInputFileNames(tsBuildInfoFile)
    .filter(fileName => typeof fileName === 'string')
    .map(fileName => sourcePathBases.map(base => resolve(base, fileName)).find(path => existsSync(path)))
    .filter(path => path !== undefined)
    // getOutputFileNames looks inputs up in their TypeScript-normalized
    // (forward-slash) form, so native Windows paths must match it.
    .map(path => ts.normalizePath(path));
  // Resolve the shared output base once; getOutputFileNames otherwise derives
  // it from every input for every file when rootDir was implicit.
  config.options.rootDir ??= ts.getCommonSourceDirectoryOfConfig(config, !ts.sys.useCaseSensitiveFileNames);
  // Compiler paths and directory entries can differ in separators or casing
  // on Windows. Compare both through the filesystem's canonical path form.
  const canonicalOutputPath = path => {
    const normalized = ts.normalizePath(resolve(path));
    return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
  };
  const expected = new Set(config.fileNames.flatMap(fileName =>
    ts.getOutputFileNames(config, fileName, !ts.sys.useCaseSensitiveFileNames).map(canonicalOutputPath)));
  const prune = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await prune(path);
      else if (!expected.has(canonicalOutputPath(path))) await rm(path, { force: true });
    }
  };
  await prune(outputDir);
}
