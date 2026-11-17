import type { BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';
import type { LocalServiceLaunchTargetV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import {
    DaemonLocalServicePreviewOpenOrCreateResponseV1Schema,
    LocalServicePreviewServiceTargetV1Schema,
    type DaemonLocalServicePreviewOpenOrCreateRequestV1,
    type LocalServiceDeclarationPreviewLocatorV1,
} from '@happier-dev/protocol/local/services/preview/v1';
import {
    ActionApprovalRequestCreatedResultSchema,
    ActionExecuteFailureSchema,
    type ActionApprovalRequestCreatedResult,
    type ActionExecuteResult,
} from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveLocalServiceStartFailure } from '../serviceFailure';
import { normalizeLocalServicePreviewSnapshotPayload } from './api';

export type LocalServiceBrowserTargetResult =
    | Readonly<{ status: 'succeeded'; target: BrowserViewTargetV1; currentUrl?: string }>
    | Readonly<{ status: 'denied'; reasonCode: string }>
    | Extract<ActionExecuteResult, { ok: false }>
    | ActionApprovalRequestCreatedResult;

export type LocalServiceBrowserOpenTarget = LocalServiceLaunchTargetV1 | LocalServiceDeclarationPreviewLocatorV1;

function isSourceQualifiedService(target: LocalServiceLaunchTargetV1): boolean {
    return target.sourceClass?.kind === 'managed_service' && target.sessionId === undefined
        && (target.declaration !== undefined || target.cwd !== undefined);
}

/** Registration intent, shared by Open and Share; the Action still owns admission. */
export function canRegisterLocalServicePreview(target: LocalServiceLaunchTargetV1): boolean {
    return target.state !== 'unavailable' && target.actions.includes('register_preview');
}

/** Resolve the private preview once before the caller opens it or chooses an exposure. */
export async function resolveLocalServiceBrowserTarget(target: LocalServiceBrowserOpenTarget, deps: Readonly<{
    serverId?: string | null;
    sessionId?: string | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    execute?: (request: DaemonLocalServicePreviewOpenOrCreateRequestV1, context: ActionExecutorContext) => Promise<unknown>;
}>): Promise<LocalServiceBrowserTargetResult> {
    if (deps.accountLifetime !== undefined && deps.accountLifetime?.isCurrent() !== true) return { ok: false,
        errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
    let request: DaemonLocalServicePreviewOpenOrCreateRequestV1;
    if ('targetId' in target) {
        // The stable locator selects a Home and declaration, never an access URL or process.
        if (!deps.accountLifetime || !areServerProfileIdentifiersEquivalent(target.serverId, deps.accountLifetime.scope.serverId))
            return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        request = { machineId: target.machineId, launchTargetId: target.targetId };
    } else {
        const startFailure = resolveLocalServiceStartFailure(target);
        if (startFailure) return { status: 'denied', reasonCode: startFailure.reasonCode };
        if (target.state === 'unavailable' || !target.machineId.trim()) return { status: 'denied', reasonCode: 'browser_target_unavailable' };
        const browserTarget = target.browserTarget;
        const sourceQualifiedService = isSourceQualifiedService(target);
        const parsedService = sourceQualifiedService && target.sourceClass?.kind === 'managed_service'
            ? LocalServicePreviewServiceTargetV1Schema.safeParse({ kind: 'managed_service', machineId: target.machineId,
                managedServiceId: target.sourceClass.managedServiceId, ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
                declaration: target.declaration, cwd: target.cwd }) : null;
        if (sourceQualifiedService && !parsedService?.success) return { status: 'denied', reasonCode: 'browser_target_unavailable' };
        const serviceTarget = parsedService?.success ? parsedService.data : undefined;
        if (!serviceTarget && !canRegisterLocalServicePreview(target) && browserTarget?.kind !== 'localServicePreview') return browserTarget
            ? { status: 'succeeded', target: browserTarget }
            : { status: 'denied', reasonCode: 'browser_target_unavailable' };

        const inventoryEntryId = target.sourceClass?.kind === 'inventory_entry' ? target.sourceClass.inventoryEntryId : undefined;
        if (target.source === 'inventory_entry' && !inventoryEntryId) return { status: 'denied', reasonCode: 'browser_target_unavailable' };
        // A new inventory registration belongs to the viewing context. An existing
        // preview keeps its own resource scope, including an explicitly sessionless one.
        const sessionId = serviceTarget ? undefined : inventoryEntryId ? deps.sessionId ?? target.sessionId
            : browserTarget?.kind === 'localServicePreview' ? browserTarget.sessionId : target.sessionId;
        const targetReference = serviceTarget ? { serviceTarget } : inventoryEntryId ? { inventoryEntryId }
            : { launchTargetId: browserTarget?.kind === 'localServicePreview' ? browserTarget.targetId : target.id };
        request = { machineId: target.machineId, ...(sessionId ? { sessionId } : {}), ...targetReference };
    }
    const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user',
        serverId: deps.accountLifetime?.scope.serverId ?? deps.serverId ?? undefined,
        expectedAccountId: deps.accountLifetime?.scope.accountId };
    const result = deps.execute ? await deps.execute(request, context) : await (async () => {
        const execute = (await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')).createFrontDoorActionExecute();
        const outcome = await execute('localServices.preview.openOrCreate', request, context);
        return outcome.ok ? outcome.result : outcome;
    })();
    const failure = ActionExecuteFailureSchema.safeParse(result);
    if (failure.success) return failure.data;
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result);
    if (approval.success) return approval.data;
    const response = DaemonLocalServicePreviewOpenOrCreateResponseV1Schema.safeParse(result);
    if (!response.success || !normalizeLocalServicePreviewSnapshotPayload(response.data.snapshot, target.machineId))
        return { status: 'denied', reasonCode: 'preview_registration_failed' };
    if (deps.accountLifetime && !deps.accountLifetime.isCurrent()) return { ok: false,
        errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
    // The admitted runtime publishes through its captured Account owner. Preserve
    // the resource binding when a sessionless service has no browser projection.
    const preview = response.data.preview;
    return { status: 'succeeded', target: preview.resource.browserTarget ?? {
        kind: 'localServicePreview', targetId: preview.previewId, machineId: preview.resource.machineId,
        ...(preview.resource.sessionId ? { sessionId: preview.resource.sessionId } : {}),
        ...(preview.resource.serviceTarget ? { serviceTarget: preview.resource.serviceTarget } : {}),
        display: preview.resource.display,
    }, ...(preview.accessUrl ? { currentUrl: preview.accessUrl } : {}) };
}
