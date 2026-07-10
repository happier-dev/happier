import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeDistExecutableWrapper } from './writeDistExecutableWrapper.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptDir);
const outputDir = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR
  ? resolve(packageRoot, process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR)
  : join(packageRoot, 'dist');

await writeDistExecutableWrapper({
  targetPath: join(outputDir, 'bin', 'hsetup'),
});
