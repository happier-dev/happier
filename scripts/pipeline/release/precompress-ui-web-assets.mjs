#!/usr/bin/env node
// @ts-check

import { precompressUiWebAssets } from './lib/precompress-ui-web-assets.mjs';

function readDirArg(argv) {
  const index = argv.indexOf('--dir');
  if (index < 0 || !argv[index + 1]) return '';
  return argv[index + 1];
}

function readEncodingsArg(argv) {
  if (argv.includes('--gzip-only')) return ['gzip'];
  const index = argv.indexOf('--encodings');
  if (index < 0 || !argv[index + 1]) return undefined;
  return argv[index + 1].split(',').map((encoding) => encoding.trim()).filter(Boolean);
}

try {
  const argv = process.argv.slice(2);
  const result = await precompressUiWebAssets({
    dir: readDirArg(argv),
    encodings: readEncodingsArg(argv),
  });
  process.stdout.write(`[release] precompressed UI web assets: scanned=${result.scannedFiles} br=${result.brotliFiles} gz=${result.gzipFiles}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
