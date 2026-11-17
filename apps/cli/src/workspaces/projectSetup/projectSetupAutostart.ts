import { invokeHostReviewedChildV1, type HostReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { ProjectSetupExecutionOutcome } from './projectSetupExecution';

/** Original admitted Action and its host-only child ingress; never a launch operand. */
export type ProjectSetupAutostartContext = Readonly<{ parent: HostReviewedParentV1; context: ActionExecutorContext }>;

/** Consume successful setup settlement through ordinary reviewed Service Start children. */
export async function startProjectSetupAutostartServices(input: Readonly<{
    outcome: ProjectSetupExecutionOutcome;
    manifest: ProjectManifestV1 | null;
    parent: HostReviewedParentV1;
    context: ActionExecutorContext;
    /** A Service Start already owns this declaration's pending launch. */
    excludeServiceName?: string;
}>): Promise<ActionExecuteFailure | null> {
    const settlement = input.outcome.setupSettlement;
    if (!input.outcome.result.ok || settlement?.outcome !== 'finished') return null;
    const services = Object.entries(input.manifest?.services ?? {})
        .filter(([name, service]) => service.runtime?.autostart === true && name !== input.excludeServiceName);
    if (!services.length) return null;
    const execute = input.context.executeHostReviewedChildAction;
    if (!execute) return { ok: false, errorCode: 'project_service_action_context_unavailable', error: 'project_service_action_context_unavailable' };
    for (const [name] of services) {
        const selection = { kind: 'manifest' as const, name };
        const result = await invokeHostReviewedChildV1({ parent: input.parent, context: input.context,
            // The settled setup was admitted against the lifecycle review, including these executable service effects.
            reviewAdmitted: true,
            child: { action: 'localServices.launcher.start', role: 'project.setup.autostart',
                input: projectNativeJsonValueForTransport({ machineId: settlement.workspace.machineId,
                    targetId: createProjectServiceDeclarationTargetIdV1(settlement.workspace, selection),
                    workspace: workspaceAddressFromRefV1(settlement.workspace),
                    declaration: { workspaceRefId: settlement.workspace.id, selection } }) },
            execute: (value, context, actionId) => execute(actionId, value, context),
        });
        if (!result.ok) return result;
        const started = DaemonLocalServiceLauncherStartResponseV1Schema.safeParse(result.result);
        if (!started.success) return { ok: false, errorCode: 'project_service_start_unavailable', error: 'project_service_start_unavailable' };
        if (started.data.status !== 'succeeded') {
            const code = started.data.reasonCode!;
            return { ok: false, errorCode: code, error: code };
        }
    }
    return null;
}
