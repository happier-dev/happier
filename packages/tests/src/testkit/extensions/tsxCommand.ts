import { join } from 'node:path';

import { repoRootDir } from '../paths';

export function resolveRepositoryTsxCommand(): string {
    return join(
        repoRootDir(),
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
    );
}
