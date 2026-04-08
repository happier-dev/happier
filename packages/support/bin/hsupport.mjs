#!/usr/bin/env node
import { runSupportCli } from '../dist/cli/runSupportCli.js';

try {
  const result = await runSupportCli(process.argv.slice(2));
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
