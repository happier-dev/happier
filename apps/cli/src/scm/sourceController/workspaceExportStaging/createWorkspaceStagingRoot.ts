import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const WORKSPACE_TRANSFER_STAGING_ROOT_PREFIX = 'workspace-transfer-staging-';
const stagingMarkerFileName = 'workspace-staging-root.json';

export type WorkspaceStagingRoot = Readonly<{
    stagingId: string;
    rootDirectory: string;
    workspaceDirectory: string;
    blobsDirectory: string;
    metadataDirectory: string;
    markerFilePath: string;
}>;

export const WorkspaceStagingRootMarkerSchema = z.object({
    schemaVersion: z.literal(1),
    stagingId: z.string().min(1),
    rootDirectory: z.string().min(1),
}).strict();
export type WorkspaceStagingRootMarker = z.infer<typeof WorkspaceStagingRootMarkerSchema>;

export function resolveWorkspaceStagingRootDirectory(params: Readonly<{
    parentDirectory: string;
    stagingId: string;
}>): string {
    return join(params.parentDirectory, `${WORKSPACE_TRANSFER_STAGING_ROOT_PREFIX}${params.stagingId}`);
}

export function resolveWorkspaceStagingMarkerFilePath(params: Readonly<{ rootDirectory: string }>): string {
    return join(params.rootDirectory, stagingMarkerFileName);
}

export function createWorkspaceStagingDescriptor(params: Readonly<{
    parentDirectory: string;
    stagingId: string;
}>): WorkspaceStagingRoot {
    const rootDirectory = resolveWorkspaceStagingRootDirectory(params);

    return {
        stagingId: params.stagingId,
        rootDirectory,
        workspaceDirectory: join(rootDirectory, 'workspace'),
        blobsDirectory: join(rootDirectory, 'blobs'),
        metadataDirectory: join(rootDirectory, 'metadata'),
        markerFilePath: resolveWorkspaceStagingMarkerFilePath({ rootDirectory }),
    };
}

export async function readWorkspaceStagingRootMarker(params: Readonly<{ rootDirectory: string }>): Promise<WorkspaceStagingRootMarker> {
    const markerFilePath = resolveWorkspaceStagingMarkerFilePath({ rootDirectory: params.rootDirectory });

    let markerContent: string;
    try {
        markerContent = await readFile(markerFilePath, 'utf8');
    } catch {
        throw new Error(`Workspace staging root marker is missing for ${params.rootDirectory}`);
    }

    let parsedMarkerContent: unknown;
    try {
        parsedMarkerContent = JSON.parse(markerContent);
    } catch {
        throw new Error(`Workspace staging root marker is invalid for ${params.rootDirectory}`);
    }

    const marker = WorkspaceStagingRootMarkerSchema.safeParse(parsedMarkerContent);
    if (!marker.success) {
        throw new Error(`Workspace staging root marker is invalid for ${params.rootDirectory}`);
    }

    return marker.data;
}

export async function createWorkspaceStagingRoot(params: Readonly<{
    parentDirectory: string;
    stagingId: string;
}>): Promise<WorkspaceStagingRoot> {
    const stagingRoot = createWorkspaceStagingDescriptor(params);

    try {
        const existingMarker = await readWorkspaceStagingRootMarker({ rootDirectory: stagingRoot.rootDirectory });
        if (existingMarker.rootDirectory !== stagingRoot.rootDirectory || existingMarker.stagingId !== stagingRoot.stagingId) {
            throw new Error(`Workspace staging root marker does not match descriptor for ${stagingRoot.rootDirectory}`);
        }

        return stagingRoot;
    } catch (error) {
        if (!(error instanceof Error) || !/workspace staging root marker is missing/i.test(error.message)) {
            throw error;
        }
    }

    await mkdir(stagingRoot.workspaceDirectory, { recursive: true });
    await mkdir(stagingRoot.blobsDirectory, { recursive: true });
    await mkdir(stagingRoot.metadataDirectory, { recursive: true });
    await writeFile(
        stagingRoot.markerFilePath,
        JSON.stringify({
            schemaVersion: 1,
            stagingId: stagingRoot.stagingId,
            rootDirectory: stagingRoot.rootDirectory,
        }, null, 2),
        { encoding: 'utf8' },
    );

    return stagingRoot;
}
