import {
    BrowserCommandDispatchResultV1Schema,
    BrowserOpenViewCommandV1Schema,
    BrowserOpenViewInProgressV1Schema,
} from '@happier-dev/protocol/browser/control/v1';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isActionApprovalDeclinedErrorCode, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import { isActionOperationTerminal, type ActionOperationStoreSnapshot } from '@/sync/domains/actionOperations/actionOperationStore';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

/** Where the agent's browser first-use story is told: the exact Home, Account, Machine and Session. */
export type BrowserOpenFirstUseScope = Readonly<{
    serverId: string;
    accountId: string;
    machineId: string;
    sessionId: string;
}>;

/**
 * What one Machine-targeted `browser.view.open` operation says about getting the agent's browser
 * started. The one projection of that operation: the Session Browser's first-use state and an
 * approval's live row both read it, so they can never disagree about the same open.
 *
 * - `preparing`: the Machine is downloading its managed Chromium (`browser_runtime_provisioning`).
 * - `connecting`: the open is accepted and on its way, past provisioning.
 * - `opened`: the open went through; the page is on its way to the discovery/stream owners.
 * - `installFailed`: the download or install failed; a new explicit open is the retry.
 * - `sandboxUnavailable`: Chromium is installed but the Machine's security policy blocks its sandbox.
 * - `failed`: the open ended for another typed reason.
 */
export type BrowserOpenOperationState = Readonly<{
    kind: 'preparing' | 'connecting' | 'opened' | 'installFailed' | 'sandboxUnavailable' | 'failed';
    /** The typed reason of a failure, for diagnostics; never product copy. */
    code?: string;
}>;

const PROVISIONING_PHASE = 'browser_runtime_provisioning';
const PROVISIONING_FAILED_CODE = 'browser_runtime_provisioning_failed';

/**
 * A settled operation's state. A succeeded operation read from a list has no `result` (lists omit
 * it), which is not an outcome: it reads as unknown until the exact operation is fetched.
 */
export function projectBrowserOpenOperation(snapshot: ActionOperationSnapshotV1): BrowserOpenOperationState | null {
    if (!isActionOperationTerminal(snapshot.state)) {
        return snapshot.progress?.kind === 'phase' && snapshot.progress.phase === PROVISIONING_PHASE
            ? { kind: 'preparing' } : { kind: 'connecting' };
    }
    if (snapshot.state === 'failed') {
        const code = snapshot.error?.errorCode;
        return code === PROVISIONING_FAILED_CODE ? { kind: 'installFailed', code }
            : { kind: 'failed', ...(code ? { code } : {}) };
    }
    if (snapshot.state !== 'succeeded') return null;
    const result = BrowserCommandDispatchResultV1Schema.safeParse(snapshot.result);
    if (!result.success) return null;
    if (result.data.status === 'dispatched') return { kind: 'opened' };
    const code = result.data.error.code;
    return code === 'sandbox_unavailable' ? { kind: 'sandboxUnavailable', code } : { kind: 'failed', code };
}

/** What the Session's latest Machine-targeted open says, before any view exists. */
export type BrowserOpenFirstUse = Readonly<{
    kind: 'preparing' | 'connecting' | 'dispatched' | 'installFailed' | 'sandboxUnavailable';
    /** The page the agent asked for, when the open's approval receipt names it. */
    targetUrl?: string;
}>;

const PREPARING: BrowserOpenFirstUse = Object.freeze({ kind: 'preparing' });
const CONNECTING: BrowserOpenFirstUse = Object.freeze({ kind: 'connecting' });
const DISPATCHED: BrowserOpenFirstUse = Object.freeze({ kind: 'dispatched' });
const INSTALL_FAILED: BrowserOpenFirstUse = Object.freeze({ kind: 'installFailed' });
const SANDBOX_UNAVAILABLE: BrowserOpenFirstUse = Object.freeze({ kind: 'sandboxUnavailable' });

/** The scope's latest open operation, as the store holds it (a list entry has no `result`). */
export function findLatestBrowserOpenOperation(
    state: ActionOperationStoreSnapshot,
    scope: BrowserOpenFirstUseScope,
): ActionOperationSnapshotV1 | null {
    let latest: ActionOperationSnapshotV1 | null = null;
    for (const operation of state.operationsByKey.values()) {
        const snapshot = operation.snapshot;
        if (operation.serverId !== scope.serverId || snapshot.actionId !== 'browser.view.open'
            || snapshot.scope.accountId !== scope.accountId || snapshot.scope.machineId !== scope.machineId
            || snapshot.scope.sessionId !== scope.sessionId) continue;
        if (!latest || snapshot.createdAt > latest.createdAt) latest = snapshot;
    }
    return latest;
}

/** Only an operation that succeeded without its result can be completed by fetching it. */
export function needsBrowserOpenResult(snapshot: ActionOperationSnapshotV1 | null): boolean {
    return snapshot?.state === 'succeeded' && snapshot.result === undefined;
}

export function readBrowserOpenFirstUse(
    state: ActionOperationStoreSnapshot,
    scope: BrowserOpenFirstUseScope,
    /** The latest operation with its result recovered by `get`, when the store only has the list entry. */
    recovered?: ActionOperationSnapshotV1 | null,
): BrowserOpenFirstUse | null {
    const latest = findLatestBrowserOpenOperation(state, scope);
    if (!latest) return null;
    const projected = projectBrowserOpenOperation(recovered && recovered.operationId === latest.operationId
        && recovered.revision >= latest.revision ? recovered : latest);
    switch (projected?.kind) {
        case 'preparing': return PREPARING;
        case 'connecting': return CONNECTING;
        case 'opened': return DISPATCHED;
        case 'installFailed': return INSTALL_FAILED;
        case 'sandboxUnavailable': return SANDBOX_UNAVAILABLE;
        default: return null;
    }
}

/**
 * An approval's receipt of an open that is still being prepared. Artifact `executed` only means the
 * approved invocation returned this acceptance, not that the page opened: the `operationId` links
 * to the live operation, and the open's own input names the page.
 */
export type BrowserOpenAcceptance = Readonly<{ operationId: string; targetUrl: string | null }>;

export function readBrowserOpenAcceptance(request: ApprovalRequest): BrowserOpenAcceptance | null {
    if (request.actionId !== 'browser.view.open' || request.execution?.ok !== true) return null;
    const accepted = BrowserOpenViewInProgressV1Schema.safeParse(request.execution.result);
    if (!accepted.success) return null;
    const command = BrowserOpenViewCommandV1Schema.safeParse(request.actionArgs);
    const target = command.success ? command.data.target : null;
    return { operationId: accepted.data.operationId, targetUrl: target?.kind === 'externalUrl' ? target.url : null };
}

/** The page named by the approval receipt that carries this operation's acceptance. */
export function readBrowserOpenTargetUrl(artifacts: readonly DecryptedArtifact[], operationId: string): string | null {
    for (const artifact of artifacts) {
        if (artifact.header?.actionId !== 'browser.view.open' || typeof artifact.body !== 'string') continue;
        const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body);
        const acceptance = parsed?.family === 'built_in' ? readBrowserOpenAcceptance(parsed.request) : null;
        if (acceptance?.operationId === operationId) return acceptance.targetUrl;
    }
    return null;
}

export type BrowserSandboxInstallOutcome = Readonly<
    | { status: 'installed' }
    | { status: 'failed'; code: string }
>;

/**
 * The typed outcome of `browser.sandbox.install`. A person declining the approval is not an outcome
 * (null: the card simply returns to its resting state); an unreadable answer never reads as installed.
 */
export function readBrowserSandboxInstallOutcome(result: ActionExecuteResult): BrowserSandboxInstallOutcome | null {
    if (!result.ok) {
        return isActionApprovalDeclinedErrorCode(result.errorCode) ? null : { status: 'failed', code: result.errorCode };
    }
    const parsed = getActionSpec('browser.sandbox.install').outputSchema?.safeParse(result.result);
    const value: unknown = parsed?.success ? parsed.data : null;
    if (value && typeof value === 'object' && 'status' in value) {
        if (value.status === 'installed') return { status: 'installed' };
        if (value.status === 'failed' && 'code' in value && typeof value.code === 'string') {
            return { status: 'failed', code: value.code };
        }
    }
    return { status: 'failed', code: 'invalid_action_output' };
}

type BrowserSandboxActionContext = Readonly<{
    surface: 'ui';
    authority: 'present_user';
    actionCaller: Readonly<{ kind: 'host' }>;
    serverId: string;
    expectedAccountId: string;
    defaultSessionId: string;
    externalActionTarget: Readonly<{ kind: 'machine'; machineId: string }>;
}>;

/**
 * Allow the managed browser's sandbox on the exact Machine. It is the one person's press in Happier,
 * dispatched through the Action front door like every Browser Action: the catalog's approval policy
 * decides what is asked, and the Machine's own authority decides the system permission.
 */
export async function allowBrowserSandbox(
    execute: (actionId: 'browser.sandbox.install', input: Readonly<{ machineId: string }>, context: BrowserSandboxActionContext) => Promise<ActionExecuteResult>,
    scope: BrowserOpenFirstUseScope,
): Promise<BrowserSandboxInstallOutcome | null> {
    return readBrowserSandboxInstallOutcome(await execute('browser.sandbox.install', { machineId: scope.machineId }, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: scope.serverId, expectedAccountId: scope.accountId, defaultSessionId: scope.sessionId,
        externalActionTarget: { kind: 'machine', machineId: scope.machineId },
    }));
}
