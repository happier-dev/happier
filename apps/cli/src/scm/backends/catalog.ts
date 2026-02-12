import type { ScmBackend } from '../types';
import { createGitBackend } from './git/backend';
import { createSaplingBackend } from './sapling/backend';

export function createScmBackendCatalog(): readonly ScmBackend[] {
    return [createGitBackend(), createSaplingBackend()];
}
