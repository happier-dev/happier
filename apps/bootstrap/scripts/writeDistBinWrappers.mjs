import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeDistExecutableWrapper } from '../dist/bin/writeDistExecutableWrapper.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptDir);

await writeDistExecutableWrapper({
  targetPath: join(packageRoot, 'dist', 'bin', 'hsetup'),
});
