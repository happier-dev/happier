import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NativeBuildInputError,
  materializeNativeBuildInputs,
} from './materializeNativeBuildInputs.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

try {
  const result = await materializeNativeBuildInputs({
    platform: 'ios',
    packageRoot,
    destinationPath: process.env.HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_INSTALL_PATH?.trim() || undefined,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const payload = error instanceof NativeBuildInputError
    ? error.payload
    : {
      status: 'blocked',
      renderer: 'ios-ghosttykit',
      reason: 'ghosttykit-materialization-failed',
      fallbackRenderer: 'xterm-webview',
      fallbackRequired: true,
      detail: error instanceof Error ? error.message : String(error),
    };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
}
