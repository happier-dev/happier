import { createExpoFileSystemFileMock } from './expoFileSystem';

// One native filesystem boundary for imports, including concurrent imports
// while Vitest is resolving its module mock.
const boundary = createExpoFileSystemFileMock();
export const { Directory, File, Paths } = boundary.module;
