import { join } from 'node:path';

import { SESSION_MCP_CONTEXT_FILE_ENV, SessionMcpUnavailableError,
  type SessionMcpLocalContext } from '@/mcp/runtime/sessionMcpLocalContext';
import type { AgentLaunchPayload } from './agentLaunchFrame';
import type { AgentIsolationMemberNativeIdentity } from './agentIsolationNativeIdentity';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { deriveAgentIsolationMemberIdentity, type AgentIsolationMemberRequester } from './provisioning';
import { normalizeMaterializationKeyForPath } from '../connectedServices/materialize/normalizeMaterializationKeyForPath';

/** The incumbent materialization lease supplies its admitted Agent-owned destination. */
export type AgentLaunchMaterialization = Pick<AgentLaunchPayload,
  'runtimeHome' | 'environment' | 'selectedMaterials'> & Readonly<{ memberIdentity?: AgentIsolationMemberNativeIdentity }>;
export type AgentLaunchMaterializationTarget = Pick<AgentLaunchMaterialization, 'runtimeHome' | 'memberIdentity'>;

/** Qualify the existing parent native observation without another OS/Home read. */
export function requireAgentIsolationMaterialNativeIdentity(identity: AgentIsolationMemberNativeIdentity,
  requester: AgentIsolationMemberRequester): AgentIsolationMemberNativeIdentity {
  const expected = deriveAgentIsolationMemberIdentity(requester);
  if (identity.digest !== expected.digest || identity.homeServerIdentityId !== expected.homeServerIdentityId
    || identity.home !== expected.home || identity.username !== expected.username
    || identity.primaryGroup !== expected.primaryGroup || identity.workspaceRoot !== expected.workspaceRoot
    || identity.ownershipMarker !== expected.ownershipMarker || !Number.isSafeInteger(identity.agentUid)
    || identity.agentUid <= 0 || !Number.isSafeInteger(identity.agentGid) || identity.agentGid <= 0) throw new PluginError({
    code: 'agent_isolation_unavailable', message: 'Execution material belongs to a different requester', retryable: false,
    details: { phase: 'native_execution_preparation' } });
  return identity;
}

export type AgentLaunchOperationMaterialization = Readonly<{
  materializationKey: string;
  environment: AgentLaunchMaterialization['environment'];
  selectedMaterials: AgentLaunchMaterialization['selectedMaterials'];
}>;

/** The same shim publishes whole-operation bytes; this projection creates no files. */
export function projectAgentIsolationOperationMaterial(identity: AgentIsolationMemberNativeIdentity
  | Pick<AgentIsolationMemberNativeIdentity, 'agentUid' | 'agentGid' | 'home'>,
  input: AgentLaunchOperationMaterialization): AgentLaunchMaterialization {
  if (!input.materializationKey) throw new PluginError({ code: 'agent_launch_material_invalid',
    message: 'Native operation materialization identity is unavailable', retryable: false });
  return Object.freeze({ ...('digest' in identity ? { memberIdentity: identity } : {}),
    runtimeHome: join(identity.home, 'runtime', 'operations', normalizeMaterializationKeyForPath(input.materializationKey)),
    environment: Object.freeze({ ...input.environment }),
    selectedMaterials: Object.freeze(input.selectedMaterials.map(file => Object.freeze({ ...file }))) });
}

export const SESSION_MCP_CONTEXT_RELATIVE_PATH = '.happier/session-mcp.json';

/** Pure projection; only the Agent-launch shim publishes these selected bytes. */
export function withSessionMcpAgentLaunchMaterial(
  materialization: AgentLaunchMaterialization,
  context: SessionMcpLocalContext | null | undefined,
): AgentLaunchMaterialization {
  if (!context) throw new SessionMcpUnavailableError();
  return Object.freeze({
    ...materialization,
    environment: Object.freeze({
      ...materialization.environment,
      [SESSION_MCP_CONTEXT_FILE_ENV]: join(materialization.runtimeHome, SESSION_MCP_CONTEXT_RELATIVE_PATH),
    }),
    selectedMaterials: Object.freeze([
      ...materialization.selectedMaterials.filter(file => file.relativePath !== SESSION_MCP_CONTEXT_RELATIVE_PATH),
      Object.freeze({ relativePath: SESSION_MCP_CONTEXT_RELATIVE_PATH,
        contentBase64: Buffer.from(JSON.stringify(context), 'utf8').toString('base64') }),
    ]),
  });
}
