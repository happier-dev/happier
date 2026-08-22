import { createHash } from 'node:crypto';

import {
    COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
    PluginError,
    type ComposerContentStageMediaRequestV1,
    type ComposerContentService,
    type PluginCancellationOptions,
} from '@happier-dev/plugin-sdk';
import type { FileSystemService } from '@happier-dev/plugin-sdk/fs';
import type { SessionExecutionTargetV1 } from '@happier-dev/protocol';

import type { PluginInvocationServicesSeed } from './types';
import type { RpcHandlerInvoker } from '@/api/rpc/types';
import {
    resolveSessionMediaMimeType,
    sessionMediaKindForMimeType,
} from '@/session/media/mime';
import { sanitizeSessionMediaFileName } from '@/session/media/names';
import {
    releaseComposerMediaStageViaLocalRpc,
    uploadComposerMediaStageViaLocalRpc,
} from '@/transfers/rpc/uploadComposerMediaStageViaLocalRpc';

/** Host-private binding for daemon-authored Composer media staging. */
export type StablePluginComposerContentOwner = Readonly<{
    bind(input: Readonly<{
        seed: PluginInvocationServicesSeed;
        fileSystem: FileSystemService;
    }>): ComposerContentService | null;
}>;

type ComposerContentUnavailableCode =
    | 'plugin_composer_content_aborted'
    | 'plugin_composer_content_target_unavailable'
    | 'plugin_generation_stale';

function sameExecutionTarget(
    left: SessionExecutionTargetV1 | null,
    right: SessionExecutionTargetV1,
): boolean {
    return left?.serverId === right.serverId && left.machineId === right.machineId;
}

function fail(code: string, message: string, details?: Readonly<{ reason: string }>): never {
    throw new PluginError({ code, message, ...(details ? { details } : {}) });
}

export function createStablePluginComposerContentOwner(input: Readonly<{
    executionTarget: SessionExecutionTargetV1;
    resolveCurrentExecutionTarget(): SessionExecutionTargetV1 | null;
    /** The daemon's existing local transfer RPC carrier; never plugin supplied. */
    resolveTransferRpcHandler(): RpcHandlerInvoker | null;
}>): StablePluginComposerContentOwner {
    const readBoundAvailabilityCode = (
        seed: PluginInvocationServicesSeed,
        operationSignal?: AbortSignal,
    ): ComposerContentUnavailableCode | null => {
        try {
            if (!seed.isGenerationCurrent()) return 'plugin_generation_stale';
        } catch {
            return 'plugin_generation_stale';
        }
        if (seed.signal.aborted || operationSignal?.aborted) {
            return 'plugin_composer_content_aborted';
        }
        try {
            if (!sameExecutionTarget(
                input.resolveCurrentExecutionTarget(),
                input.executionTarget,
            )) {
                return 'plugin_composer_content_target_unavailable';
            }
            return input.resolveTransferRpcHandler()
                ? null
                : 'plugin_composer_content_target_unavailable';
        } catch {
            return 'plugin_composer_content_target_unavailable';
        }
    };

    return Object.freeze({
        bind({ seed, fileSystem }) {
            const throwUnavailable = (code: ComposerContentUnavailableCode): never => {
                if (code === 'plugin_generation_stale') {
                    fail(code, 'Plugin generation is stale');
                }
                if (code === 'plugin_composer_content_aborted') {
                    fail(code, 'Composer content staging was cancelled');
                }
                fail(code, 'Composer content staging target is unavailable');
            };
            const guard = (operationSignal?: AbortSignal): void => {
                const code = readBoundAvailabilityCode(seed, operationSignal);
                if (code) throwUnavailable(code);
            };
            const owner = Object.freeze({
                pluginId: seed.plugin.id,
                localId: seed.contribution.id,
            });
            return Object.freeze({
                capabilities: () => {
                    const code = readBoundAvailabilityCode(seed);
                    return Object.freeze({
                        [COMPOSER_MEDIA_CONTENT_CAPABILITY_V1]: code
                            ? Object.freeze({ status: 'unavailable' as const, code })
                            : Object.freeze({ status: 'available' as const }),
                    });
                },
                stageMedia: async (
                    request: ComposerContentStageMediaRequestV1,
                    options?: PluginCancellationOptions,
                ) => {
                    guard(options?.signal);
                    const bytes = await fileSystem.readFile(request.source, {
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    guard(options?.signal);
                    const suggestedName = request.name ?? request.source.relativePath;
                    const mimeType = resolveSessionMediaMimeType({
                        bytes,
                        ...(request.mimeType ? { declaredMimeType: request.mimeType } : {}),
                        suggestedName,
                        allowVideoByDeclarationOrExtension: true,
                    });
                    if (!mimeType || (request.mimeType !== undefined && request.mimeType !== mimeType)) {
                        fail(
                            'plugin_composer_content_mime_invalid',
                            'Composer content media type is unsupported or does not match its bytes',
                        );
                    }
                    const name = sanitizeSessionMediaFileName(suggestedName, 'media');
                    const sha256 = createHash('sha256').update(bytes).digest('hex');
                    guard(options?.signal);
                    const rpc: RpcHandlerInvoker | null = (() => {
                        try {
                            return input.resolveTransferRpcHandler();
                        } catch {
                            return null;
                        }
                    })();
                    const activeRpc = rpc ?? throwUnavailable('plugin_composer_content_target_unavailable');
                    const staged = await uploadComposerMediaStageViaLocalRpc({
                        rpc: activeRpc,
                        bytes,
                        executionTarget: input.executionTarget,
                        owner,
                        mediaKind: sessionMediaKindForMimeType(mimeType),
                        mimeType,
                        name,
                        sha256,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    if (!staged.success) {
                        const lateCode = readBoundAvailabilityCode(seed, options?.signal);
                        if (lateCode) throwUnavailable(lateCode);
                        if (staged.code === 'aborted') {
                            throwUnavailable('plugin_composer_content_aborted');
                        }
                        fail(
                            'plugin_composer_content_stage_failed',
                            'Composer content media could not be staged',
                            { reason: staged.code },
                        );
                    }
                    const lateCode = readBoundAvailabilityCode(seed, options?.signal);
                    if (lateCode) {
                        await releaseComposerMediaStageViaLocalRpc({ rpc: activeRpc, handle: staged.handle });
                        throwUnavailable(lateCode);
                    }
                    return staged.handle;
                },
            });
        },
    });
}
