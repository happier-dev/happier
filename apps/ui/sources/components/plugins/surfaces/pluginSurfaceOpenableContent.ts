import {
    OpenableContentReadRequestV1Schema,
    OpenableContentReadResultV1Schema,
    OpenableContentRefV1Schema,
    OpenableContentStatRequestV1Schema,
    OpenableContentStatResultV1Schema,
    type OpenableContentReadRequestV1,
    type OpenableContentReadResultV1,
    type OpenableContentRefV1,
    type OpenableContentStatResultV1,
} from '@happier-dev/protocol';
import type {
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { randomUUID } from '@/platform/randomUUID';
import { getImageMimeTypeFromPath, isKnownBinaryPath } from '@/scm/utils/filePresentation';
import {
    workspaceReadFile,
    workspaceStatFile,
    type WorkspaceFileSystemTarget,
} from '@/sync/ops/workspaceFileSystem';

import type {
    PluginSurfaceHostApiHandlers,
    PluginSurfaceHostApiRequestOptions,
} from './createPluginSurfaceHostApi';

/**
 * The only private host binding a selected workspace-file viewer receives.
 * `ref` is freshly generated at the host and the target/path stay in this
 * closure; no renderer, SDK method, or transport is given a path-shaped value.
 */
export type PluginSurfaceOpenableContentBinding = Readonly<{
    ref: OpenableContentRefV1;
    stat: (options?: PluginSurfaceHostApiRequestOptions) => Promise<OpenableContentStatResultV1>;
    read: (
        request: OpenableContentReadRequestV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ) => Promise<OpenableContentReadResultV1>;
}>;

const CANCELLED = Symbol('openable-content-cancelled');

type CancellableResult<T> = T | typeof CANCELLED;

function sameRef(left: OpenableContentRefV1, right: OpenableContentRefV1): boolean {
    return left.kind === right.kind && left.handle === right.handle;
}

function staleSurface(): PluginUiJsonValueV1 {
    return { code: 'stale_surface', diagnostics: ['plugin_surface_retired'] };
}

function invalidPayload(reason: string): PluginUiJsonValueV1 {
    return { code: 'invalid_payload', diagnostics: [reason] };
}

function currentOrStale(isCurrent: (() => boolean) | undefined): PluginUiJsonValueV1 | null {
    return isCurrent?.() === false ? staleSurface() : null;
}

async function awaitCancellable<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
): Promise<CancellableResult<T>> {
    if (!signal) return await promise;
    if (signal.aborted) return CANCELLED;
    return await new Promise<CancellableResult<T>>((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            resolve(CANCELLED);
        };
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        void promise.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (error) => {
                cleanup();
                reject(error);
            },
        );
    });
}

function privateWorkspaceFileExtension(filePath: string): string | undefined {
    const basename = filePath.replaceAll('\\', '/').split('/').pop() ?? '';
    const dot = basename.lastIndexOf('.');
    if (dot <= 0 || dot === basename.length - 1) return undefined;
    return `.${basename.slice(dot + 1).toLowerCase()}`;
}

function deriveContentKind(filePath: string): Readonly<{
    contentClass: 'text' | 'image' | 'binary';
    mimeType: string;
    extension?: string;
}> {
    const normalizedPath = filePath.replaceAll('\\', '/');
    const imageMime = getImageMimeTypeFromPath(normalizedPath);
    const extension = privateWorkspaceFileExtension(normalizedPath);
    if (imageMime) {
        return {
            contentClass: 'image',
            mimeType: imageMime,
            ...(extension ? { extension } : {}),
        };
    }
    if (isKnownBinaryPath(normalizedPath)) {
        return {
            contentClass: 'binary',
            mimeType: 'application/octet-stream',
            ...(extension ? { extension } : {}),
        };
    }
    return {
        contentClass: 'text',
        mimeType: 'text/plain',
        ...(extension ? { extension } : {}),
    };
}

function revisionFromWorkspaceStat(sizeBytes: number, modifiedMs: number): string {
    return `workspace-file:${sizeBytes}:${modifiedMs}`;
}

async function statWorkspaceOpenableContent(input: Readonly<{
    target: WorkspaceFileSystemTarget;
    filePath: string;
    signal?: AbortSignal;
}>): Promise<OpenableContentStatResultV1> {
    try {
        const result = await awaitCancellable(
            workspaceStatFile(input.target, input.filePath, {
                ...(input.signal ? { signal: input.signal } : {}),
            }),
            input.signal,
        );
        if (result === CANCELLED) return { status: 'cancelled' };
        if (!result.success || !result.exists) return { status: 'unavailable' };
        if (result.kind !== 'file') return { status: 'unsupported' };
        if (
            typeof result.sizeBytes !== 'number'
            || !Number.isFinite(result.sizeBytes)
            || result.sizeBytes < 0
            || typeof result.modifiedMs !== 'number'
            || !Number.isFinite(result.modifiedMs)
            || result.modifiedMs < 0
        ) {
            return { status: 'unavailable' };
        }

        const sizeBytes = Math.floor(result.sizeBytes);
        const modifiedMs = result.modifiedMs;
        const content = deriveContentKind(input.filePath);
        return {
            status: 'ready',
            ...content,
            sizeBytes,
            revision: revisionFromWorkspaceStat(sizeBytes, modifiedMs),
        };
    } catch {
        return input.signal?.aborted ? { status: 'cancelled' } : { status: 'unavailable' };
    }
}

function validatedStatResult(value: unknown): OpenableContentStatResultV1 {
    const parsed = OpenableContentStatResultV1Schema.safeParse(value);
    return parsed.success ? parsed.data : { status: 'unavailable' };
}

function validatedReadResult(value: unknown): OpenableContentReadResultV1 {
    const parsed = OpenableContentReadResultV1Schema.safeParse(value);
    return parsed.success ? parsed.data : { status: 'unavailable' };
}

/**
 * Creates an opaque, mount-bound workspace-file binding. The opaque reference
 * is intentionally only returned to the UI selection/presentation owner; its
 * private target/path closure is consumed solely by the host handlers below.
 */
export function createWorkspaceFileOpenableContentBinding(input: Readonly<{
    target: WorkspaceFileSystemTarget;
    filePath: string;
}>): PluginSurfaceOpenableContentBinding {
    const filePath = input.filePath;
    if (!filePath.trim()) {
        throw new Error('Workspace openable content requires a non-empty workspace file path.');
    }
    const ref = OpenableContentRefV1Schema.parse({
        kind: 'workspaceFile',
        handle: `workspaceFile_${randomUUID()}`,
    });

    const stat = async (options?: PluginSurfaceHostApiRequestOptions): Promise<OpenableContentStatResultV1> => (
        await statWorkspaceOpenableContent({
            target: input.target,
            filePath,
            ...(options?.signal ? { signal: options.signal } : {}),
        })
    );

    const read = async (
        request: OpenableContentReadRequestV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<OpenableContentReadResultV1> => {
        const signal = options?.signal;
        const before = await stat({ ...(signal ? { signal } : {}) });
        if (before.status !== 'ready') return before;
        const readyBefore = before;
        if (readyBefore.revision !== request.expectedRevision) return { status: 'changed' };
        if (readyBefore.sizeBytes > request.maxBytes) {
            return { status: 'tooLarge', sizeBytes: readyBefore.sizeBytes };
        }

        try {
            const readResult = await awaitCancellable(
                workspaceReadFile(input.target, filePath, {
                    maxBytes: request.maxBytes,
                    ...(signal ? { signal } : {}),
                }),
                signal,
            );
            if (readResult === CANCELLED) return { status: 'cancelled' };

            const after = await stat({ ...(signal ? { signal } : {}) });
            if (after.status !== 'ready') return after;
            const readyAfter = after;
            if (readyAfter.revision !== readyBefore.revision) return { status: 'changed' };
            if (readyAfter.sizeBytes > request.maxBytes) {
                return { status: 'tooLarge', sizeBytes: readyAfter.sizeBytes };
            }
            if (!readResult.success) return { status: 'unavailable' };

            const bytes = decodeBase64(readResult.content, 'base64');
            if (bytes.byteLength > request.maxBytes) {
                return { status: 'tooLarge', sizeBytes: bytes.byteLength };
            }
            // A response whose decoded length conflicts with the owner stat is
            // not a stable snapshot. Do not reinterpret it as a usable read.
            if (bytes.byteLength !== readyAfter.sizeBytes) return { status: 'changed' };

            const content = readyAfter.contentClass === 'text'
                ? (() => {
                    try {
                        return { kind: 'utf8' as const, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
                    } catch {
                        return null;
                    }
                })()
                : { kind: 'base64' as const, base64: encodeBase64(bytes, 'base64') };
            if (!content) return { status: 'unsupported' };
            return {
                status: 'ready',
                content,
                revision: readyAfter.revision,
            };
        } catch {
            return signal?.aborted ? { status: 'cancelled' } : { status: 'unavailable' };
        }
    };

    return Object.freeze({ ref, stat, read });
}

/**
 * Host-adapter parser for the two exact public Openable methods. The selected
 * binding is the authority for the one opaque reference; a foreign ref cannot
 * reach a reader even if it has a syntactically valid handle.
 */
export function createPluginSurfaceOpenableContentHandlers(input: Readonly<{
    binding: PluginSurfaceOpenableContentBinding;
    isCurrent?: () => boolean;
}>): Pick<PluginSurfaceHostApiHandlers, 'statOpenableContent' | 'readOpenableContent'> {
    return {
        statOpenableContent: async (request, options): Promise<PluginUiJsonValueV1> => {
            const stale = currentOrStale(input.isCurrent);
            if (stale) return stale;
            const parsed = OpenableContentStatRequestV1Schema.safeParse(request.payload);
            if (!parsed.success) return invalidPayload('plugin_surface_openable_content_ref_invalid');
            if (!sameRef(parsed.data.ref, input.binding.ref)) return { status: 'unsupported' };

            const result = validatedStatResult(await input.binding.stat(options));
            return currentOrStale(input.isCurrent) ?? result;
        },
        readOpenableContent: async (request, options): Promise<PluginUiJsonValueV1> => {
            const stale = currentOrStale(input.isCurrent);
            if (stale) return stale;
            const parsed = OpenableContentReadRequestV1Schema.safeParse(request.payload);
            if (!parsed.success) return invalidPayload('plugin_surface_openable_content_read_invalid');
            if (!sameRef(parsed.data.ref, input.binding.ref)) return { status: 'unsupported' };

            const result = validatedReadResult(await input.binding.read(parsed.data, options));
            return currentOrStale(input.isCurrent) ?? result;
        },
    };
}
