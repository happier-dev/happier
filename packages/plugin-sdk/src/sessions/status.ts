import { SessionStatusActionResultV1ProtocolSchema as canonicalStatus } from '@happier-dev/protocol/sessions/control/contract';
import { SessionAcceptedWorkspaceV1ProtocolSchema as canonicalAcceptedWorkspace } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { SessionStatusActionResultV1 as ProtocolSessionStatusActionResultV1 } from '@happier-dev/protocol/sessions/control/contract';
import type { SessionAcceptedWorkspaceV1 as ProtocolSessionAcceptedWorkspaceV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProtocolComposableSchema } from '../protocol/protocolFacade.js';

/** Host-admitted source checkout proof, distinct from display metadata and worker custody. */
export type SessionAcceptedWorkspaceV1 = ProtocolSessionAcceptedWorkspaceV1;

/** A single-target status result is owned by the protocol status contract. */
export type SessionStatusActionResultV1 = ProtocolSessionStatusActionResultV1;

export const SessionAcceptedWorkspaceV1Schema: ProtocolComposableSchema<SessionAcceptedWorkspaceV1> = canonicalAcceptedWorkspace;
export const SessionStatusActionResultV1Schema: ProtocolComposableSchema<SessionStatusActionResultV1> = canonicalStatus;
