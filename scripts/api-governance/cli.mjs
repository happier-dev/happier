import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  renderApiGovernanceSummary,
  runApiGovernance,
} from './apiGovernance.mjs';

export function parseApiGovernanceCliArgs(args, cwd = process.cwd()) {
  let profileId;
  let packageRoot;
  let write = false;
  let check = false;
  let json = false;
  let sourcePrepared = false;
  let publishedVersion;
  let previousPublishedInventoryPath;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--profile') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--profile requires a value');
      profileId = value;
      index += 1;
      continue;
    }
    if (argument === '--package-root') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--package-root requires a value');
      packageRoot = resolve(cwd, value);
      index += 1;
      continue;
    }
    if (argument === '--write') {
      write = true;
      continue;
    }
    if (argument === '--check') {
      check = true;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--source-prepared') {
      sourcePrepared = true;
      continue;
    }
    if (argument === '--published-version') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--published-version requires a value');
      publishedVersion = value;
      index += 1;
      continue;
    }
    if (argument === '--previous-published-inventory') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--previous-published-inventory requires a value');
      previousPublishedInventoryPath = resolve(cwd, value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown API governance argument: ${argument}`);
  }
  if (profileId === undefined) throw new Error('--profile is required');
  if (write && check) throw new Error('--write and --check are mutually exclusive');
  if (previousPublishedInventoryPath !== undefined && publishedVersion === undefined) {
    throw new Error('--previous-published-inventory requires --published-version');
  }
  return Object.freeze({
    profileId,
    packageRoot,
    write,
    check,
    json,
    sourcePrepared,
    publishedVersion,
    previousPublishedInventoryPath,
  });
}

export async function main(args = process.argv.slice(2)) {
  const options = parseApiGovernanceCliArgs(args);
  const report = await runApiGovernance(options);
  process.stdout.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderApiGovernanceSummary(report));
  if (options.check && report.summary.changedFiles > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
