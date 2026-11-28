import { execFileSync } from 'node:child_process';

export const AFFECTED_TEST_USAGE = 'Usage: pnpm test:affected -- <changed file>... | --commit <sha> | --base <ref> [--journeys | --units] [--list | --plan]';
const GIT_REF_OPTIONS = new Set(['--commit', '--base']);
const OPTIONS_WITH_VALUES = new Set([...GIT_REF_OPTIONS, '--owners']);
const CHANGED_FILES_RESOLVED = '--changed-files-resolved';
const CHANGED_FILE = '--changed-file=';

/** @param {readonly string[]} args @param {string} name */
export function readOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

/** @param {string} rootDir @param {readonly string[]} args */
export function readAffectedFileSelection(rootDir, args) {
  if (args.includes(CHANGED_FILES_RESOLVED)) {
    return { files: args.filter(arg => arg.startsWith(CHANGED_FILE)).map(arg => arg.slice(CHANGED_FILE.length)), ref: null };
  }
  const commit = readOption(args, '--commit');
  const base = commit ? null : readOption(args, '--base');
  if (commit || base) {
    /** @param {string[]} gitArgs */
    const git = gitArgs => execFileSync('git', gitArgs, { cwd: rootDir, encoding: 'utf8', maxBuffer: 64 << 20 });
    const revision = git(['rev-parse', '--verify', '--end-of-options', `${commit ?? base}^{commit}`]).trim();
    const names = commit
      ? git(['diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-z', '-r', '--root', revision])
      : git(['diff', '--no-renames', '--name-only', '-z', revision, 'HEAD', '--']);
    return { files: names.split('\0').filter(Boolean), ref: commit ? '--commit' : '--base' };
  }
  return {
    files: args.filter((arg, index) => !arg.startsWith('--') && !OPTIONS_WITH_VALUES.has(args[index - 1] ?? '')),
    ref: null,
  };
}

/** @param {readonly string[]} args */
export function allowsEmptyAffectedFileSelection(args) {
  return args.includes('--base') || args.includes(CHANGED_FILES_RESOLVED);
}

/** @param {string} rootDir @param {readonly string[]} args */
export function resolveAffectedDispatchArguments(rootDir, args) {
  const { files, ref } = readAffectedFileSelection(rootDir, args);
  if (!ref) return args;
  if (!files.length && !allowsEmptyAffectedFileSelection(args)) throw new Error(AFFECTED_TEST_USAGE);
  const withoutRefs = args.filter((arg, index) => !GIT_REF_OPTIONS.has(arg)
    && !GIT_REF_OPTIONS.has(args[index - 1] ?? ''));
  return [...withoutRefs, CHANGED_FILES_RESOLVED, ...files.map(file => CHANGED_FILE + file)];
}
