#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureTermuxAndroidSourceFromEnvironment } from './termuxAndroidSource.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

try {
  const result = await ensureTermuxAndroidSourceFromEnvironment({
    vendorRoot: process.env.HAPPIER_TERMINAL_NATIVE_TERMUX_VENDOR
      ?? join(packageRoot, 'android', 'termux', 'vendor'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'ok') {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
