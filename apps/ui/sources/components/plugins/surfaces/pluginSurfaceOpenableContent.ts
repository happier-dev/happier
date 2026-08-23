import {
    DEFAULT_OPENABLE_CONTENT_MAX_BYTES_V1,
    OpenableContentReadRequestV1Schema,
    OpenableContentReadResultV1Schema,
    OpenableContentRefV1Schema,
    OpenableContentStatRequestV1Schema,
    OpenableContentStatResultV1Schema,
    type OpenableContentBodyV1,
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
import { getImageMimeTypeFromPath, isBinaryContent, isKnownBinaryPath } from '@/scm/utils/filePresentation';
import {
    workspaceReadFile,
    workspaceStatFile,
    type WorkspaceFileSystemTarget,
} from '@/sync/ops/workspaceFileSystem';

import type {
    PluginSurfaceHostApiHandlers,
    PluginSurfaceHostApiRequestOptions,
} from './createPluginSurfaceHostApi';
import { createPluginSurfaceHostApiError } from './createPluginSurfaceHostApi';

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
    return createPluginSurfaceHostApiError('stale_surface', ['plugin_surface_retired']);
}

function invalidPayload(reason: string): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError('invalid_payload', [reason]);
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

type OpenableContentKind = Readonly<{
    contentClass: 'text' | 'image' | 'binary';
    mimeType: string;
    extension?: string;
}>;

/**
 * How far content classification may read.
 *
 * The daemon transfer refuses a file larger than the ceiling it is given, so a
 * cheap prefix probe does not exist: a probe reads the whole file or nothing.
 * `DEFAULT_OPENABLE_CONTENT_MAX_BYTES_V1` is therefore the honest bound — the
 * canonical default an openable read already delivers, so classification never
 * moves more bytes than the read it describes. Above it the filename answer
 * stands, and the read below remains authoritative for the bytes it holds.
 */
const CONTENT_CLASSIFICATION_PROBE_MAX_BYTES = DEFAULT_OPENABLE_CONTENT_MAX_BYTES_V1;

/**
 * A filename cannot decide whether bytes are text. The extension tables answer
 * only for the images and archives they list, and every unlisted extension —
 * including every extension nobody has thought of — currently lands on `text`.
 * `decidedByPath` marks that difference so only the undecided case pays for a
 * content probe.
 */
function deriveContentKind(filePath: string): Readonly<{
    kind: OpenableContentKind;
    decidedByPath: boolean;
}> {
    const normalizedPath = filePath.replaceAll('\\', '/');
    const imageMime = getImageMimeTypeFromPath(normalizedPath);
    const extension = privateWorkspaceFileExtension(normalizedPath);
    const withExtension = extension ? { extension } : {};
    if (imageMime) {
        return {
            kind: { contentClass: 'image', mimeType: imageMime, ...withExtension },
            decidedByPath: true,
        };
    }
    if (isKnownBinaryPath(normalizedPath)) {
        return {
            kind: { contentClass: 'binary', mimeType: 'application/octet-stream', ...withExtension },
            decidedByPath: true,
        };
    }
    return {
        kind: { contentClass: 'text', mimeType: 'text/plain', ...withExtension },
        decidedByPath: false,
    };
}

function decodeStrictUtf8(bytes: Uint8Array): string | null {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
}

/**
 * The one content question this owner answers from bytes: are they the UTF-8
 * text a text viewer will be handed? Stat and read below both decide it here,
 * so metadata and delivered content cannot disagree, and `isBinaryContent`
 * stays the shared owner of the control-byte rule the built-in file viewer
 * already applies.
 */
function classifyOpenableContentBytes(bytes: Uint8Array): 'text' | 'binary' {
    const text = decodeStrictUtf8(bytes);
    if (text === null) return 'binary';
    return isBinaryContent(text) ? 'binary' : 'text';
}

/**
 * One revision that answers for bytes, not just for metadata.
 *
 * Size and modification time alone were not a content identity: a rewrite that
 * preserves length and restores mtime — a formatter, a checkout, an rsync with
 * `--times` — and any filesystem whose mtime granularity is coarser than the
 * edit both produced the same revision for different bytes, so a viewer holding
 * it saw no change and kept presenting stale content as current.
 *
 * The status-change time closes that: a write always advances it, and no
 * `utimes` call can put it back. It also advances for a permission or rename
 * change, which produces a revision the viewer treats as changed and re-reads —
 * the safe direction. An older daemon does not report it, and this deliberately
 * keeps the previous two-part identity there rather than inventing a value:
 * degrading to the predecessor's guarantee is honest, and inventing one would
 * make every stat look like an edit.
 */
function revisionFromWorkspaceStat(
    sizeBytes: number,
    modifiedMs: number,
    changedMs: number | null,
): string {
    return changedMs === null
        ? `workspace-file:${sizeBytes}:${modifiedMs}`
        : `workspace-file:${sizeBytes}:${modifiedMs}:${changedMs}`;
}

type WorkspaceOpenableContentMetadata =
  | Readonly<{ status: 'ready'; sizeBytes: number; revision: string }>
  | Readonly<{ status: 'unavailable' | 'unsupported' | 'cancelled' }>;

/**
 * The cheap host-owned facts. The read path guards itself with this alone, so
 * its before/after revision checks never pay for content classification.
 */
async function statWorkspaceFileMetadata(input: Readonly<{
    target: WorkspaceFileSystemTarget;
    filePath: string;
    signal?: AbortSignal;
}>): Promise<WorkspaceOpenableContentMetadata> {
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
        const changedMs = typeof result.changedMs === 'number'
            && Number.isFinite(result.changedMs)
            && result.changedMs >= 0
            ? result.changedMs
            : null;
        return {
            status: 'ready',
            sizeBytes,
            revision: revisionFromWorkspaceStat(sizeBytes, result.modifiedMs, changedMs),
        };
    } catch {
        return input.signal?.aborted ? { status: 'cancelled' } : { status: 'unavailable' };
    }
}

/** One classification, bound to the exact revision whose bytes produced it. */
type OpenableContentClassificationMemo = {
    current: Readonly<{ revision: string; kind: OpenableContentKind }> | null;
};

async function classifyWorkspaceOpenableContent(input: Readonly<{
    target: WorkspaceFileSystemTarget;
    filePath: string;
    sizeBytes: number;
    revision: string;
    memo: OpenableContentClassificationMemo;
    signal?: AbortSignal;
}>): Promise<OpenableContentKind> {
    const derived = deriveContentKind(input.filePath);
    // An empty file is valid UTF-8, so it needs no probe to be called text.
    if (derived.decidedByPath || input.sizeBytes === 0) return derived.kind;
    const memo = input.memo.current;
    if (memo && memo.revision === input.revision) return memo.kind;
    if (input.sizeBytes > CONTENT_CLASSIFICATION_PROBE_MAX_BYTES) return derived.kind;

    const probe = await awaitCancellable(
        workspaceReadFile(input.target, input.filePath, {
            maxBytes: CONTENT_CLASSIFICATION_PROBE_MAX_BYTES,
            ...(input.signal ? { signal: input.signal } : {}),
        }),
        input.signal,
    );
    // A failed, cancelled or raced probe is deliberately not memoized: the
    // filename answer stands for this call and the next stat probes again.
    if (probe === CANCELLED || !probe.success) return derived.kind;
    const bytes = decodeBase64(probe.content, 'base64');
    if (bytes.byteLength !== input.sizeBytes) return derived.kind;

    const kind: OpenableContentKind = classifyOpenableContentBytes(bytes) === 'binary'
        ? {
            contentClass: 'binary',
            mimeType: 'application/octet-stream',
            ...(derived.kind.extension ? { extension: derived.kind.extension } : {}),
        }
        : derived.kind;
    input.memo.current = Object.freeze({ revision: input.revision, kind });
    return kind;
}

async function statWorkspaceOpenableContent(input: Readonly<{
    target: WorkspaceFileSystemTarget;
    filePath: string;
    memo: OpenableContentClassificationMemo;
    signal?: AbortSignal;
}>): Promise<OpenableContentStatResultV1> {
    const metadata = await statWorkspaceFileMetadata({
        target: input.target,
        filePath: input.filePath,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (metadata.status !== 'ready') return metadata;
    const kind = await classifyWorkspaceOpenableContent({
        target: input.target,
        filePath: input.filePath,
        sizeBytes: metadata.sizeBytes,
        revision: metadata.revision,
        memo: input.memo,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (input.signal?.aborted) return { status: 'cancelled' };
    return {
        status: 'ready',
        ...kind,
        sizeBytes: metadata.sizeBytes,
        revision: metadata.revision,
    };
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
    // One slot, holding one revision's classification. A later revision
    // replaces it rather than accumulating, so this binding never describes an
    // edit it has not read.
    const classification: OpenableContentClassificationMemo = { current: null };

    const stat = async (options?: PluginSurfaceHostApiRequestOptions): Promise<OpenableContentStatResultV1> => (
        await statWorkspaceOpenableContent({
            target: input.target,
            filePath,
            memo: classification,
            ...(options?.signal ? { signal: options.signal } : {}),
        })
    );

    const statMetadata = async (signal: AbortSignal | undefined): Promise<WorkspaceOpenableContentMetadata> => (
        await statWorkspaceFileMetadata({
            target: input.target,
            filePath,
            ...(signal ? { signal } : {}),
        })
    );

    const read = async (
        request: OpenableContentReadRequestV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<OpenableContentReadResultV1> => {
        const signal = options?.signal;
        const before = await statMetadata(signal);
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

            const after = await statMetadata(signal);
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

            // The bytes in hand are the authority, and they are classified by
            // the same rule the stat metadata used. A file the filename could
            // not decide is therefore delivered as the text or binary it
            // actually is, instead of being refused as `unsupported` because a
            // filename promised text.
            const derived = deriveContentKind(filePath);
            const text = derived.decidedByPath ? null : decodeStrictUtf8(bytes);
            const content: OpenableContentBodyV1 = text !== null && !isBinaryContent(text)
                ? { kind: 'utf8', text }
                : { kind: 'base64', base64: encodeBase64(bytes, 'base64') };
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
