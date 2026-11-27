export function buildPublicProfileRenderer(input?: { projectDir?: string; check?: boolean; printPatch?: boolean; traceInputs?: boolean }): Promise<{ inputPaths: string[] } | undefined>;
export function readPublicProfileAssetFiles(input?: { projectDir?: string }): Promise<Array<{ filename: string; sourcePath: string }>>;
export function stagePublicProfileAssets(input: { projectDir?: string; outDir: string }): Promise<string[]>;
