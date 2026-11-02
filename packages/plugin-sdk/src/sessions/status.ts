import { SessionStatusActionResultV1ProtocolSchema as canonicalStatus } from '@happier-dev/protocol/sessions/control/contract';
import { SessionAcceptedWorkspaceV1ProtocolSchema as canonicalAcceptedWorkspace } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { PluginActionInputById, PluginActionResultById } from '../actions/actionTypeMap.generated.js';
import type { ScmHostingRepositoryIdentityV1 } from '../scm/projections.js';
import type { ProtocolComposableSchema } from '../protocol/protocolFacade.js';
import type { AgentExecutionTargetV1 } from '../agents.js';

/** Host-admitted source checkout proof, distinct from display metadata and worker custody. */
export type SessionAcceptedWorkspaceV1 = {
    checkout: PluginActionInputById['projects.compute.exec']['workspace'];
    repository?: ScmHostingRepositoryIdentityV1;
};

/** A single-target status result retains its exact optional accepted-workspace proof. */
export type SessionStatusActionResultV1 =
    | (Extract<PluginActionResultById['session.status.get'], { session: unknown }> & {
        acceptedWorkspace?: SessionAcceptedWorkspaceV1;
        agentTarget?: AgentExecutionTargetV1;
    })
    | Extract<PluginActionResultById['session.status.get'], { ok: false }>;

export const SessionAcceptedWorkspaceV1Schema: ProtocolComposableSchema<SessionAcceptedWorkspaceV1> = canonicalAcceptedWorkspace;
export const SessionStatusActionResultV1Schema: ProtocolComposableSchema<SessionStatusActionResultV1> = canonicalStatus;
