export function getSyncSingleton(): typeof import('@/sync/sync').sync {
    return require('../sync.ts').sync as typeof import('@/sync/sync').sync;
}
