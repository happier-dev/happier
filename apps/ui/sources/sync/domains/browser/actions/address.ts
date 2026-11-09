import type { BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';
import { LocalServiceLauncherSnapshotV1Schema, type LocalServiceLaunchTargetV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext, RuntimeActionExecute } from '@happier-dev/protocol/actions/executor/types';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolveLocalServiceBrowserTarget } from '@/sync/domains/local/services/preview/resolveLaunchTarget';
import { buildBrowserLaunchpadRows, selectLaunchpadServiceRowForAddress, type BrowserLaunchpadRow } from '../targets';
import { readBrowserLoopbackAddressPort } from '../shell/address';
import type { BrowserControlViewState } from '../control/state';
import { isLocalServicePreviewAddress } from '@/sync/domains/local/services/preview/url';

function readOrigin(value: string | null): string | null {
    try { return value ? new URL(value).origin : null; } catch { return null; }
}

/** Leaving a preview/plugin origin changes its target; an in-origin address keeps its engine. */
export function shouldRetargetBrowserViewForAddressNavigation(
    view: BrowserControlViewState,
    target: Extract<BrowserViewTargetV1, { kind: 'externalUrl' }>,
): boolean {
    if (view.target.kind === 'externalUrl') return false;
    if (view.target.kind === 'localServicePreview'
        && isLocalServicePreviewAddress(target.url, view.target.display?.addressLabel)) return false;
    const currentOrigin = readOrigin(view.pendingUrl ?? view.currentUrl);
    const targetOrigin = readOrigin(target.url);
    return !currentOrigin || !targetOrigin || currentOrigin !== targetOrigin;
}

/** Current facts from the mounted Browser or its workspace, without subscribing a second loader. */
export type BrowserAddressFacts = Readonly<{
    localServiceTargets?: readonly LocalServiceLaunchTargetV1[];
    launchpadRows?: readonly BrowserLaunchpadRow[];
    localServiceAddressScope?: Readonly<{
        machineId: string;
        sessionId?: string;
        scope?: 'workspace' | 'machine';
        workspaceRoot?: string;
    }>;
}>;

type BrowserAddressResolution =
    | Readonly<{ status: 'resolved'; target: BrowserViewTargetV1; currentUrl?: string }>
    | Readonly<{ status: 'failed'; result: unknown }>;

/**
 * Address intent is resolved once after Browser Action admission. A running Service owns its
 * Machine's localhost endpoint; all other addresses retain the existing engine/navigation path.
 * Service registration uses the already-admitted runtime, rather than asking for a second approval.
 */
export async function resolveBrowserAddressTarget(input: Readonly<{
    target: BrowserViewTargetV1;
    facts?: BrowserAddressFacts;
    accountLifetime?: ServerAccountScopeLifetime | null;
    context: ActionExecutorContext;
    execute: RuntimeActionExecute;
}>): Promise<BrowserAddressResolution> {
    const direct = { status: 'resolved', target: input.target } as const;
    if (input.target.kind !== 'externalUrl' || !readBrowserLoopbackAddressPort(input.target.url)) return direct;
    const facts = input.facts;
    const targets = facts?.localServiceTargets;
    let rows = facts?.launchpadRows;
    if (targets === undefined && rows === undefined && facts?.localServiceAddressScope) {
        const response = await input.execute({ actionId: 'localServices.launcher.snapshot',
            input: facts.localServiceAddressScope, context: input.context });
        if (ActionExecuteFailureSchema.safeParse(response).success || ActionApprovalRequestCreatedResultSchema.safeParse(response).success) {
            return { status: 'failed', result: response };
        }
        const snapshot = LocalServiceLauncherSnapshotV1Schema.safeParse(response);
        if (!snapshot.success) return { status: 'failed', result: { ok: false,
            errorCode: 'invalid_response', error: 'invalid_response' } };
        rows = buildBrowserLaunchpadRows({ launcherSnapshot: snapshot.data });
    }
    if (targets !== undefined) {
        rows = targets.length ? buildBrowserLaunchpadRows({ launcherSnapshot: {
            v: 1, machineId: targets[0]!.machineId, updatedAt: 0, targets: [...targets],
        } }) : [];
    }
    const row = selectLaunchpadServiceRowForAddress(rows ?? [], input.target.url);
    if (!row) return direct;
    let service: LocalServiceLaunchTargetV1;
    if (row.serviceRow?.primaryAction?.kind === 'open') {
        service = row.serviceRow.primaryAction.openTarget;
    } else if (row.target?.kind === 'localServicePreview') {
        service = {
            id: row.target.targetId, source: 'registered_preview', machineId: row.target.machineId,
            ...(row.target.sessionId ? { sessionId: row.target.sessionId } : {}), title: row.title,
            confidence: 'high', state: 'available', actions: ['open_preview'], browserTarget: row.target,
        };
    } else return direct;
    const resolved = await resolveLocalServiceBrowserTarget(service, {
        accountLifetime: input.accountLifetime ?? undefined,
        sessionId: facts?.localServiceAddressScope?.sessionId ?? input.context.defaultSessionId,
        execute: request => input.execute({ actionId: 'localServices.preview.openOrCreate', input: request, context: input.context }),
    });
    if (!('status' in resolved) || resolved.status !== 'succeeded') {
        return { status: 'failed', result: 'status' in resolved && resolved.status === 'denied'
            ? { ok: false, errorCode: 'runtime_action_disabled', error: `runtime_action_disabled:browser:${resolved.reasonCode}` }
            : resolved };
    }
    return { status: 'resolved', target: resolved.target,
        ...(resolved.currentUrl ? { currentUrl: resolved.currentUrl } : {}) };
}
