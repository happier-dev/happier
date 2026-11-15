import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type ValidateExtensionImportBoundariesResult,
  validateExtensionImportBoundaries,
} from './lib/extensionImportBoundaries.ts';

export function runValidateExtensionImportBoundaries(options?: Parameters<typeof validateExtensionImportBoundaries>[0]): ValidateExtensionImportBoundariesResult {
  return validateExtensionImportBoundaries(options);
}

export async function main(): Promise<void> {
  let rootDir = process.cwd();
  let changedFiles: string[] | undefined;
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith('--root-dir=') && argument.slice('--root-dir='.length)) {
      rootDir = resolve(argument.slice('--root-dir='.length));
    } else if (argument.startsWith('--file=') && argument.slice('--file='.length)) {
      (changedFiles ??= []).push(argument.slice('--file='.length));
    } else if (argument.startsWith('--files-from0=') && argument.slice('--files-from0='.length)) {
      (changedFiles ??= []).push(...readFileSync(argument.slice('--files-from0='.length), 'utf8').split('\0').filter(Boolean));
    } else {
      throw new Error(`Unknown boundary validator argument: ${argument}`);
    }
  }
  const result = runValidateExtensionImportBoundaries({ rootDir, changedFiles });

  if (result.ok) {
    const scanned = result.violations.length === 0 ? 'no violations' : `${result.violations.length} violation(s)`;
    console.log(`Extension import boundary: OK (${scanned}).`);
    return;
  }

  console.error('Extension import boundary: FAILED');
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
