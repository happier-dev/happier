import packageJson from '../../package.json' with { type: 'json' };
import { installConsoleWriteErrorGuards, shouldInstallConsoleWriteErrorGuards } from '../utils/writeConsoleBestEffort';

export function isTopLevelVersionRequest(args: readonly string[]): boolean {
  return args.length === 1 && (args[0] === '--version' || args[0] === '-v');
}

export function printCliVersion(): void {
  if (shouldInstallConsoleWriteErrorGuards({ processVersions: process.versions })) {
    installConsoleWriteErrorGuards();
  }
  console.log(packageJson.version);
}
