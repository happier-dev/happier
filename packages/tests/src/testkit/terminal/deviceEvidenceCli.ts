import { readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  formatTerminalNativeDeviceEvidenceValidation,
  type TerminalNativeDeviceEvidenceValidation,
} from './deviceEvidence';
import { validateTerminalNativeDeviceEvidenceWithArtifacts } from './deviceEvidenceArtifacts';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

export function terminalNativeDeviceEvidenceCliExitCode(
  result: TerminalNativeDeviceEvidenceValidation,
  deviceAcceptanceOnly: boolean,
): 0 | 1 {
  return (deviceAcceptanceOnly ? result.deviceAcceptanceReady : result.accepted) ? 0 : 1;
}

export function runTerminalNativeDeviceEvidenceCli(args: readonly string[]): number {
  const helpRequested = args.includes('--help') || args.includes('-h');
  const deviceAcceptanceOnly = args.includes('--device-acceptance');
  const paths = args.filter((arg) => !arg.startsWith('--'));
  const unknownOptions = args.filter((arg) => arg.startsWith('--')
    && arg !== '--device-acceptance'
    && arg !== '--help');
  if (helpRequested || paths.length !== 1 || unknownOptions.length > 0) {
    console.log('Usage: validate-device-evidence.mjs [--device-acceptance] <evidence.json>');
    return helpRequested && unknownOptions.length === 0 ? 0 : 2;
  }
  const evidencePath = resolve(paths[0] as string);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    console.error(`TERM-7b loaded-device evidence: unreadable ${evidencePath}`);
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let result = validateTerminalNativeDeviceEvidenceWithArtifacts(value, REPOSITORY_ROOT);
  const relativeEvidencePath = relative(REPOSITORY_ROOT, realpathSync(evidencePath)).split(sep).join('/');
  if (relativeEvidencePath.startsWith('../')
    || !/(?:^|\/)\.project\/logs\/e2e\/terminal-native\/.+\.json$/.test(relativeEvidencePath)) {
    result = {
      ...result,
      schemaValid: false,
      deviceAcceptanceReady: false,
      accepted: false,
      issues: [
        ...result.issues,
        {
          code: 'invalid-evidence-output-path',
          path: '$',
          message: 'evidence JSON must live under a repository .project/logs/e2e/terminal-native directory',
        },
      ],
    };
  }
  console.log(formatTerminalNativeDeviceEvidenceValidation(result));
  return terminalNativeDeviceEvidenceCliExitCode(result, deviceAcceptanceOnly);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = runTerminalNativeDeviceEvidenceCli(process.argv.slice(2));
}
