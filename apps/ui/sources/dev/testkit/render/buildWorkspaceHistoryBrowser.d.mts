export function buildWorkspaceHistoryBrowser(options?: {
    entryFile?: string;
    boundaryFiles?: Record<string, string>;
    boundaryModules?: Record<string, string>;
    realExpoRouter?: boolean;
    asyncRoutes?: boolean;
    lazy?: boolean;
    production?: boolean;
}): Promise<string>;
