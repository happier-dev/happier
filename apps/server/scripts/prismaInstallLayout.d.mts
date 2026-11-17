type ResolveInstalledPath = (specifier: string) => string;

export function resolveServerPrismaInstallLayout(params: Readonly<{
    serverRoot: string;
    resolveInstalledPath?: ResolveInstalledPath;
}>): Readonly<{
    clientPackageDir: string;
    clientRuntimePath: string;
    /** The installed `@prisma/client` lies inside this checkout; otherwise `defaultClientDir` is run-local. */
    ownsInstalledClient: boolean;
    defaultClientDir: string;
}>;

export function resolveServerPrismaMigrationToolLayout(params: Readonly<{
    serverRoot: string;
    resolveInstalledPath?: ResolveInstalledPath;
}>): Readonly<{
    cliPackageJsonPath: string;
    cliPackageDir: string;
    cliEntrypoint: string;
    schemaWasmPath: string;
    nodeFetchNativeDir: string;
    proxyStubPath: string;
}>;
