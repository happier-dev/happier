import { vi } from 'vitest';
import type { RuntimeActionExecute, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import type { ExternalActionTargetV1} from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionId} from '@happier-dev/protocol/actions/actionIds';
import type { SessionAgentSpawnPolicyV1 } from '@happier-dev/protocol/account/settings/sessionAgentSpawnPolicyV1';
import type { SocketRpcAnsweringClientV1 } from '@happier-dev/protocol/socketRpc';

type View = Readonly<{ browserSessionId: string; viewId: string }>;
type ReverseClient = Readonly<{
    hasConnectedClientRpcHandler(method: string): boolean;
    callConnectedClientRpc(method: string, payload: unknown,
        options?: Readonly<{ timeoutMs?: number | null; signal?: AbortSignal; onIssued?: () => void;
            answeringClient?: SocketRpcAnsweringClientV1 }>): Promise<
            Readonly<{ ok: true; result: unknown }> | Readonly<{ ok: false; error?: string; errorCode?: string }>>;
}>;

type ResolveTarget = (input: Readonly<{ actionId: ActionId; target?: ExternalActionTargetV1;
    currentMachineId: string; signal?: AbortSignal }>) => Promise<ExternalActionTargetV1 | null>;

/** Real daemon admission/currentness, with only remote Home authority reads supplied by the test. */
export async function loadBrowserDaemonApprovalCurrentnessForTests() {
    const source = '../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
    return await vi.importActual<{
        createDaemonExternalActionTargetResolver(input: Readonly<{ credentials: { token: string; encryption: null } }>): ResolveTarget;
        createDaemonApprovalExecutionOriginCurrentness(input: Readonly<{
            accountId: string; machineId: string; serverId: string; resolveTarget: ResolveTarget;
            resolveCurrentMachineExecutionOriginContext(): Promise<Readonly<{ serverIdentityId: string; machineId: string }>>;
            isAccountCurrent(): Promise<boolean>;
            listAccountApiTokens(): Promise<Readonly<{ tokens: [] }>>;
            resolveCurrentSessionAgentSpawnPolicyV1(): Promise<SessionAgentSpawnPolicyV1>;
        }>): NonNullable<ActionExecutorDeps['isApprovalExecutionOriginCurrent']>;
    }>(source);
}

/** Load real daemon owners under Vitest without rooting CLI aliases in the UI compiler program. */
export async function loadBrowserDaemonRuntimeForTests() {
    const runtimeSource = '../../../../../cli/src/daemon/runtimeActionExecutor';
    const reverseSource = '../../../../../cli/src/daemon/browser/automation/reverseDispatch';
    const clientSource = '../../../../../cli/src/session/actions/clientActionReverseDispatch';
    const transportsSource = '../../../../../cli/src/testkit/actionTransportDeps';
    const [runtime, reverse, client, transports] = await Promise.all([
        vi.importActual<{ createDaemonRuntimeActionExecutor(input: Readonly<{
            env: Readonly<Record<string, string | undefined>>;
            resolveRouteOwners(): Readonly<{ browserUiAutomation?: Readonly<{
                ownsAutomationView(view: View): boolean; uiAutomation: RuntimeActionExecute;
            }> }>;
            resolveServerFeaturesSnapshot(): Readonly<{ status: 'ready'; features: ReturnType<typeof FeaturesResponseSchema.parse> }>;
        }>): RuntimeActionExecute }>(runtimeSource),
        vi.importActual<{ createBrowserAutomationReverseDispatcher(input: Readonly<{
            getMachineClient(): ReverseClient | null | undefined;
        }>): RuntimeActionExecute }>(reverseSource),
        vi.importActual<{ createClientActionReverseDispatcher(getMachineClient: () => ReverseClient | null | undefined):
            NonNullable<ActionExecutorDeps['clientActionExecute']> }>(clientSource),
        vi.importActual<{ createUnavailableActionTransportDeps(): ActionExecutorDeps }>(transportsSource),
    ]);
    return { ...runtime, ...reverse, ...client, ...transports };
}
