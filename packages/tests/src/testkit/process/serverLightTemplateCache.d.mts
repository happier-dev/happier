export type PrepareCachedDataDirParams = {
    cacheRootDir: string;
    templateKey: string;
    targetDir: string;
    buildTemplateInto: (templateDataDir: string) => Promise<void>;
};

export type PrepareCachedDataDirResult = {
    cacheEntryDir: string;
    cacheHit: boolean;
};

export function resolveServerLightTemplateCacheRoot(rootDir: string): string;
export function prepareCachedDataDir(params: PrepareCachedDataDirParams): Promise<PrepareCachedDataDirResult>;
export function createServerLightTemplateCacheKey(params: {
    rootDir: string;
    provider: 'sqlite' | 'pglite';
    migrationsDir?: string;
}): Promise<string>;
