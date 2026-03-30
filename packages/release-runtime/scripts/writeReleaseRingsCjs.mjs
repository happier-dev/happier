import fs from 'node:fs';
import path from 'node:path';

const pkgDir = process.cwd();
const inputPath = path.join(pkgDir, 'dist', '_cjs', 'releaseRings.js');
const outputPath = path.join(pkgDir, 'dist', 'releaseRings.cjs');

if (!fs.existsSync(inputPath)) {
  throw new Error(`Missing CJS build output at: ${inputPath}`);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.copyFileSync(inputPath, outputPath);

