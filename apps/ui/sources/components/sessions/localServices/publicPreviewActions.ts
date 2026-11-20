import * as React from 'react';

import { DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema, DaemonLocalServicePublicPreviewCreateResponseV1Schema, DaemonLocalServicePublicPreviewRevokeResponseV1Schema, type DaemonLocalServicePublicPreviewCopyUrlRequestV1, type DaemonLocalServicePublicPreviewCreateRequestV1, type DaemonLocalServicePublicPreviewRevokeRequestV1, type LocalServicePublicExposureAudienceV1, type LocalServicePublicExposureModeV1, type LocalServicePublicExposureV1 } from '@happier-dev/protocol/local/services/public/v1';
import type { LocalServiceLaunchTargetV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import type { FrontDoorRuntimeActionExecute as RuntimeActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';
import { LocalServicePreviewServiceTargetV1Schema } from '@happier-dev/protocol/local/services/preview/v1';

import {
    isPublicPreviewCopyUrlResponseForRequest,
    isPublicPreviewCreateResponseForRequest,
    isPublicPreviewRevokeResponseForRequest,
} from '@/sync/domains/local/services/publicPreview/api';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveLocalServiceBrowserTarget, type LocalServiceBrowserTargetResult } from '@/sync/domains/local/services/preview/resolveLaunchTarget';
import { executeLocalServiceActionWithAdmission, type LocalServiceActionAdmission, type LocalServiceActionInvocationOptions } from './localServiceActionAdmission';

type CopyToClipboard = (value: string) => Promise<boolean>;
export type LocalServicePublicPreviewActionTarget = LocalServiceLaunchTargetV1 | Extract<BrowserViewTargetV1, { kind: 'localServicePreview' }>;

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
    /** Who a `people` share admits: the resource-grant principals chosen on the share sheet. */
    audience?: LocalServicePublicExposureAudienceV1;
}>;

export type LocalServicePublicPreviewActions = Readonly<{
    /** Same Home used by the Action executor, including background-Home controls. */
    serverId?: string;
    /** Resolve the private preview through the same admitted registration used by Open. */
    preparePreview?: (target: LocalServiceLaunchTargetV1) => Promise<LocalServiceBrowserTargetResult>;
    create: (
        target: LocalServicePublicPreviewActionTarget,
        options?: LocalServicePublicPreviewCreateOptions,
    ) => Promise<unknown>;
    copyUrl: (exposure: LocalServicePublicExposureV1) => Promise<unknown>;
    revoke: (exposure: LocalServicePublicExposureV1, options?: LocalServiceActionInvocationOptions) => Promise<unknown>;
}>;

/** Fallback lifetime when neither the caller nor the policy names one. */
export const DEFAULT_LOCAL_SERVICE_PUBLIC_PREVIEW_TTL_MS = 600_000;

type CreateLocalServicePublicPreviewActionsInput = Readonly<{
    runtimeActionExecute?: RuntimeActionExecute | null;
    machineId?: string | null;
    sessionId?: string | null;
    serverId?: string | null;
    copyToClipboard?: CopyToClipboard;
}> & LocalServiceActionAdmission;

function normalizeNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function isTargetInHome(target: LocalServicePublicPreviewActionTarget, input: CreateLocalServicePublicPreviewActionsInput): boolean {
    if ('id' in target && target.workspace && input.serverId)
        return areServerProfileIdentifiersEquivalent(target.workspace.serverId, input.serverId);
    return true;
}

/**
 * The registered preview a share binds to: its id plus its Session or exact occurrence.
 * A stable browser locator (a declared service's Open identity) binds nothing.
 */
export function readLocalServicePublicPreviewBinding(target: LocalServicePublicPreviewActionTarget): Pick<DaemonLocalServicePublicPreviewCreateRequestV1, 'machineId' | 'sessionId' | 'serviceTarget' | 'previewId'> | null {
    const browserTarget = 'id' in target ? target.browserTarget : target;
    if (browserTarget?.kind !== 'localServicePreview') {
        return null;
    }
    const machineId = normalizeNonEmptyString(browserTarget.machineId)
        ?? normalizeNonEmptyString(target.machineId);
    const sessionId = normalizeNonEmptyString(browserTarget.sessionId)
        ?? normalizeNonEmptyString(target.sessionId);
    const previewId = normalizeNonEmptyString(browserTarget.targetId);
    if (browserTarget.serviceTarget !== undefined) {
        const service = LocalServicePreviewServiceTargetV1Schema.safeParse(browserTarget.serviceTarget);
        return service.success && machineId === service.data.machineId && previewId && browserTarget.sessionId === undefined
            ? { machineId, previewId, serviceTarget: service.data }
            : null;
    }
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
    target: LocalServicePublicPreviewActionTarget,
    input: CreateLocalServicePublicPreviewActionsInput,
    options?: LocalServicePublicPreviewCreateOptions,
): DaemonLocalServicePublicPreviewCreateRequestV1 | null {
    const preview = readLocalServicePublicPreviewBinding(target);
    if (preview?.serviceTarget) return {
        ...preview,
        mode: options?.mode ?? 'secret_link',
        ...(options?.mode === 'people' && options.audience ? { audience: options.audience } : {}),
        ttlMs: options?.ttlMs ?? DEFAULT_LOCAL_SERVICE_PUBLIC_PREVIEW_TTL_MS,
        confirmation: { acknowledged: true },
    };
    const machineId = preview?.machineId ?? normalizeNonEmptyString(input.machineId);
    const sessionId = preview?.sessionId ?? normalizeNonEmptyString(input.sessionId);
    const previewId = preview?.previewId;
    return machineId && sessionId && previewId
        ? {
            machineId,
            sessionId,
            previewId,
            mode: options?.mode ?? 'secret_link',
            ...(options?.mode === 'people' && options.audience ? { audience: options.audience } : {}),
            ttlMs: options?.ttlMs ?? DEFAULT_LOCAL_SERVICE_PUBLIC_PREVIEW_TTL_MS,
            // The create control follows the configurable Action approval policy.
            // This preserves the raw daemon acknowledgement format after either
            // the user's review or their policy waiver admits the Action.
            confirmation: { acknowledged: true },
        }
        : null;
}

function exposureRequest(
    exposure: LocalServicePublicExposureV1,
): DaemonLocalServicePublicPreviewRevokeRequestV1 {
    return {
        machineId: exposure.machineId,
        ...(exposure.serviceTarget ? { serviceTarget: exposure.serviceTarget } : { sessionId: exposure.sessionId }),
        previewId: exposure.previewId,
        exposureId: exposure.exposureId,
    };
}

export function createLocalServicePublicPreviewActions(
    input: CreateLocalServicePublicPreviewActionsInput & Readonly<{ copyToClipboard: CopyToClipboard }>,
): LocalServicePublicPreviewActions {
    const runtimeActionExecute = input.runtimeActionExecute
        ? (request: Parameters<RuntimeActionExecute>[0], options?: LocalServiceActionInvocationOptions) =>
            executeLocalServiceActionWithAdmission({ execute: input.runtimeActionExecute!, request, admission: input,
                confirmation: options?.confirmation })
        : undefined;
    const copyToClipboard = input.copyToClipboard;

    return {
        serverId: normalizeNonEmptyString(input.serverId),
        async preparePreview(target) {
            if (!runtimeActionExecute || !isTargetInHome(target, input))
                return { status: 'denied', reasonCode: 'browser_target_unavailable' };
            const result = await resolveLocalServiceBrowserTarget(target, {
                serverId: input.serverId, sessionId: input.sessionId,
                execute: (request, registrationContext) => runtimeActionExecute({
                    actionId: 'localServices.preview.openOrCreate', input: request,
                    context: { ...context(input), ...registrationContext },
                }),
            });
            // A share binds to what was registered, never to the Open locator.
            return 'status' in result && result.status === 'succeeded' && result.registeredTarget
                ? { ...result, target: result.registeredTarget } : result;
        },
        async create(target, options) {
            if (!isTargetInHome(target, input)) return undefined;
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
            if (!parsed.success) {
                return result;
            }
            if (!isPublicPreviewCopyUrlResponseForRequest(parsed.data, request)) {
                return false;
            }
            return await copyToClipboard(parsed.data.publicUrl);
        },
        async revoke(exposure, options) {
            if (!runtimeActionExecute) {
                return undefined;
            }
            const request = exposureRequest(exposure);
            const invocation = {
                actionId: 'localServices.publicPreview.revoke',
                input: request,
                context: context(input),
            } as const;
            const result = await runtimeActionExecute(invocation, options);
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
    const writeClipboard = useClipboardWrite(input.serverId ?? undefined);
    const copyToClipboard = input.copyToClipboard ?? writeClipboard;

    return React.useMemo(() => {
        if (!runtimeActionExecute) {
            return undefined;
        }
        return createLocalServicePublicPreviewActions({
            ...input,
            runtimeActionExecute,
            machineId,
            sessionId,
            serverId,
            copyToClipboard,
        });
    }, [copyToClipboard, machineId, runtimeActionExecute, serverId, sessionId,
        input.expectedAccountId, input.signal, input.isCurrent, input.onApprovalPending]);
}
