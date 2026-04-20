import { pathToFileURL } from 'node:url';

import {
  type ValidateExtensionImportBoundariesResult,
  validateExtensionImportBoundaries,
} from './lib/extensionImportBoundaries.ts';
import { type InventoryFile } from './lib/migrationTypes.ts';

export function runValidateExtensionImportBoundaries(options?: {
  rootDir?: string;
  inventory?: readonly InventoryFile[];
}): ValidateExtensionImportBoundariesResult {
  return validateExtensionImportBoundaries(options);
}

export async function main(): Promise<void> {
  const result = runValidateExtensionImportBoundaries({
    rootDir: process.cwd(),
  });

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
