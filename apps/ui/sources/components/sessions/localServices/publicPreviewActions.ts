import * as React from 'react';

import {
    DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema,
    DaemonLocalServicePublicPreviewCreateResponseV1Schema,
    DaemonLocalServicePublicPreviewRevokeResponseV1Schema,
    type DaemonLocalServicePublicPreviewCopyUrlRequestV1,
    type DaemonLocalServicePublicPreviewCreateRequestV1,
    type DaemonLocalServicePublicPreviewRevokeRequestV1,
    type LocalServiceLaunchTargetV1,
    type LocalServicePublicExposureModeV1,
    type LocalServicePublicExposureV1,
    type RuntimeActionExecute,
} from '@happier-dev/protocol';

import {
    isPublicPreviewCopyUrlResponseForRequest,
    isPublicPreviewCreateResponseForRequest,
    isPublicPreviewRevokeResponseForRequest,
} from '@/sync/domains/local/services/publicPreview/api';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

type CopyToClipboard = (value: string) => Promise<boolean>;

/**
 * Exposure shape chosen by the user at create time (UB-4).
 *
 * The server policy has always carried `allowedModes` and `maxTtlMs`; the UI hard-coded
 * `secret_link` + 10 minutes and offered no choice, which is what made G15's silent expiry
 * unavoidable. Both stay optional so a caller with no preference still gets a working default.
 */
export type LocalServicePublicPreviewCreateOptions = Readonly<{
    mode?: LocalServicePublicExposureModeV1;
    ttlMs?: number;
}>;

export type LocalServicePublicPreviewActions = Readonly<{
    create: (
        target: LocalServiceLaunchTargetV1,
        options?: LocalServicePublicPreviewCreateOptions,
    ) => Promise<unknown>;
    copyUrl: (exposure: LocalServicePublicExposureV1) => Promise<boolean>;
    revoke: (exposure: LocalServicePublicExposureV1) => Promise<unknown>;
}>;

/** Fallback lifetime when neither the caller nor the policy names one. */
export const DEFAULT_LOCAL_SERVICE_PUBLIC_PREVIEW_TTL_MS = 600_000;

type CreateLocalServicePublicPreviewActionsInput = Readonly<{
    runtimeActionExecute?: RuntimeActionExecute | null;
    machineId?: string | null;
    sessionId?: string | null;
    serverId?: string | null;
    copyToClipboard?: CopyToClipboard;
}>;

function normalizeNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function readPreviewTarget(target: LocalServiceLaunchTargetV1): Readonly<{
    machineId: string;
    sessionId: string;
    previewId: string;
}> | null {
    const browserTarget = target.browserTarget;
    if (browserTarget?.kind !== 'localServicePreview') {
        return null;
    }
    const machineId = normalizeNonEmptyString(browserTarget.machineId)
        ?? normalizeNonEmptyString(target.machineId);
    const sessionId = normalizeNonEmptyString(browserTarget.sessionId)
        ?? normalizeNonEmptyString(target.sessionId);
    const previewId = normalizeNonEmptyString(browserTarget.targetId);
    return machineId && sessionId && previewId
        ? { machineId, sessionId, previewId }
        : null;
}

function context(input: CreateLocalServicePublicPreviewActionsInput) {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const serverId = normalizeNonEmptyString(input.serverId);
    return {
        ...(sessionId ? { defaultSessionId: sessionId } : {}),
        ...(serverId ? { serverId } : {}),
        surface: 'ui' as const,
    };
}

function defaultCreateRequest(
    target: LocalServiceLaunchTargetV1,
    input: CreateLocalServicePublicPreviewActionsInput,
    options?: LocalServicePublicPreviewCreateOptions,
): DaemonLocalServicePublicPreviewCreateRequestV1 | null {
    const preview = readPreviewTarget(target);
    const machineId = preview?.machineId ?? normalizeNonEmptyString(input.machineId);
    const sessionId = preview?.sessionId ?? normalizeNonEmptyString(input.sessionId);
    const previewId = preview?.previewId;
    return machineId && sessionId && previewId
        ? {
            machineId,
            sessionId,
            previewId,
            mode: options?.mode ?? 'secret_link',
            ttlMs: options?.ttlMs ?? DEFAULT_LOCAL_SERVICE_PUBLIC_PREVIEW_TTL_MS,
            // UX-5: the create control is gated behind a `Modal.confirm` in
            // `LocalServicePublicPreviewControls`, so reaching this builder means the user
            // acknowledged the public-exposure consent. The daemon `publicPreview.create`
            // chokepoint rejects any create request without this acknowledgement.
            confirmation: { acknowledged: true },
        }
        : null;
}

function exposureRequest(
    exposure: LocalServicePublicExposureV1,
): DaemonLocalServicePublicPreviewRevokeRequestV1 {
    return {
        machineId: exposure.machineId,
        sessionId: exposure.sessionId,
        previewId: exposure.previewId,
        exposureId: exposure.exposureId,
    };
}

export function createLocalServicePublicPreviewActions(
    input: CreateLocalServicePublicPreviewActionsInput,
): LocalServicePublicPreviewActions {
    const runtimeActionExecute = input.runtimeActionExecute ?? undefined;
    const copyToClipboard = input.copyToClipboard ?? setClipboardStringSafe;

    return {
        async create(target, options) {
            const request = defaultCreateRequest(target, input, options);
            if (!runtimeActionExecute || !request) {
                return undefined;
            }
            const result = await runtimeActionExecute({
                actionId: 'localServices.publicPreview.create',
                input: request,
                context: context(input),
            });
            const parsed = DaemonLocalServicePublicPreviewCreateResponseV1Schema.safeParse(result);
            if (!parsed.success || !isPublicPreviewCreateResponseForRequest(parsed.data, request)) {
                return result;
            }
            return parsed.data;
        },
        async copyUrl(exposure) {
            if (!runtimeActionExecute) {
                return false;
            }
            const request: DaemonLocalServicePublicPreviewCopyUrlRequestV1 = exposureRequest(exposure);
            const result = await runtimeActionExecute({
                actionId: 'localServices.publicPreview.copyUrl',
                input: request,
                context: context(input),
            });
            const parsed = DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema.safeParse(result);
            if (!parsed.success || !isPublicPreviewCopyUrlResponseForRequest(parsed.data, request)) {
                return false;
            }
            return await copyToClipboard(parsed.data.publicUrl);
        },
        async revoke(exposure) {
            if (!runtimeActionExecute) {
                return undefined;
            }
            const request = exposureRequest(exposure);
            const result = await runtimeActionExecute({
                actionId: 'localServices.publicPreview.revoke',
                input: request,
                context: context(input),
            });
            const parsed = DaemonLocalServicePublicPreviewRevokeResponseV1Schema.safeParse(result);
            if (!parsed.success || !isPublicPreviewRevokeResponseForRequest(parsed.data, request)) {
                return result;
            }
            return parsed.data;
        },
    };
}

export function useLocalServicePublicPreviewActions(
    input: CreateLocalServicePublicPreviewActionsInput,
): LocalServicePublicPreviewActions | undefined {
    const runtimeActionExecute = input.runtimeActionExecute ?? undefined;
    const machineId = normalizeNonEmptyString(input.machineId);
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const serverId = normalizeNonEmptyString(input.serverId);
    const copyToClipboard = input.copyToClipboard;

    return React.useMemo(() => {
        if (!runtimeActionExecute) {
            return undefined;
        }
        return createLocalServicePublicPreviewActions({
            runtimeActionExecute,
            machineId,
            sessionId,
            serverId,
            copyToClipboard,
        });
    }, [copyToClipboard, machineId, runtimeActionExecute, serverId, sessionId]);
}
