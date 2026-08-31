#!/usr/bin/env node
// @ts-check

import { appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/**
 * Fail closed for changed paths that the source-CI lane filters do not own.
 * Documentation is the only intentionally lane-less category; any other
 * unmatched path selects the broad source suite so a new executable source
 * location cannot silently receive a successful CI attestation.
 *
 * @param {{ changedPaths: string[]; classifiedPaths: string[]; documentationPaths: string[] }} input
 */
export function findUnmatchedSourcePaths({ changedPaths, classifiedPaths, documentationPaths }) {
  const known = new Set([...classifiedPaths, ...documentationPaths]);
  return [...new Set(changedPaths)].filter((path) => !known.has(path)).sort();
}

/** @param {string | undefined} raw @param {string} label */
function parsePathList(raw, label) {
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || value.some((path) => typeof path !== 'string')) {
    throw new Error(`${label} must be a JSON array of paths`);
  }
  return value;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: { 'github-output': { type: 'string', default: '' } },
    allowPositionals: false,
  });
  const changedPaths = parsePathList(env.CHANGED_PATHS_JSON, 'CHANGED_PATHS_JSON');
  const documentationPaths = parsePathList(env.DOCUMENTATION_PATHS_JSON, 'DOCUMENTATION_PATHS_JSON');
  const classifiedPaths = Object.entries(env)
    .filter(([key]) => key.startsWith('CLASSIFIED_PATHS_'))
    .flatMap(([key, raw]) => parsePathList(raw, key));
  const unmatchedPaths = findUnmatchedSourcePaths({ changedPaths, classifiedPaths, documentationPaths });
  const output = `all=${unmatchedPaths.length > 0}\nunmatched_paths=${JSON.stringify(unmatchedPaths)}\n`;
  const githubOutput = String(values['github-output'] ?? '').trim();
  if (githubOutput) await appendFile(githubOutput, output, 'utf8');
  else process.stdout.write(output);
  return unmatchedPaths;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
