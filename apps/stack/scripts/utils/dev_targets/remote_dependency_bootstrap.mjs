import { join, resolve } from 'node:path';

import { ensureDepsInstalled } from '../proc/pm.mjs';

const repoDir = resolve(process.cwd());
await ensureDepsInstalled(
  join(repoDir, 'apps', 'stack'),
  'remote Happier workspace',
  { env: process.env },
);
