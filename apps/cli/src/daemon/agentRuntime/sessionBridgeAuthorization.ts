import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { resolveReleaseRingScopedBasename } from '@/cli/runtime/publicReleaseChannel';
import {
  AgentRuntimeDaemonSessionDescriptorV1Schema,
  HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY,
  type AgentRuntimeDaemonSessionDescriptorV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeProtocol';
import {
  hashPrivateBearer,
  removePrivateBearerFile,
  verifyPrivateBearer,
  writePrivateBearerFile,
} from '@/daemon/privateBearerFile';

type PublicReleaseRing = Parameters<typeof resolveReleaseRingScopedBasename>[1];

export type AgentRuntimeSessionBridgeAuthorization = Readonly<{
  tokenHash: string;
  descriptor: AgentRuntimeDaemonSessionDescriptorV1;
  tokenFilePath: string;
}>;

export function hashAgentRuntimeSessionBridgeToken(token: string): string {
  return hashPrivateBearer(token);
}

export function verifyAgentRuntimeSessionBridgeToken(params: Readonly<{
  providedToken: string;
  expectedTokenHash: string;
}>): boolean {
  return verifyPrivateBearer({
    provided: params.providedToken,
    expectedHash: params.expectedTokenHash,
  });
}

export async function createAgentRuntimeSessionBridgeAuthorization(params: Readonly<{
  happyHomeDir: string;
  publicReleaseRing: PublicReleaseRing;
  token: string;
  descriptor: AgentRuntimeDaemonSessionDescriptorV1;
}>): Promise<Readonly<{
  authorization: AgentRuntimeSessionBridgeAuthorization;
  childEnv: Readonly<Record<
    typeof HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY,
    string
  >>;
  cleanupTokenFile(): Promise<void>;
}>> {
  const token = params.token.trim();
  if (!token) throw new Error('Agent runtime session bridge token is required');
  const descriptor = AgentRuntimeDaemonSessionDescriptorV1Schema.parse(params.descriptor);
  const dir = join(
    params.happyHomeDir,
    'tmp',
    resolveReleaseRingScopedBasename('agent-runtime-session-bridge-tokens', params.publicReleaseRing),
  );
  const tokenFilePath = join(dir, `${process.pid}-${randomUUID()}.json`);
  await writePrivateBearerFile({
    path: tokenFilePath,
    contents: `${JSON.stringify({ v: 1, token, descriptor })}\n`,
  });
  return Object.freeze({
    authorization: Object.freeze({
      tokenHash: hashAgentRuntimeSessionBridgeToken(token),
      descriptor,
      tokenFilePath,
    }),
    childEnv: Object.freeze({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    }),
    cleanupTokenFile: async () => {
      await removePrivateBearerFile(tokenFilePath).catch(() => undefined);
    },
  });
}
