import { detectKiroCliAuthStatus } from '../auth/status.js';
import { KIRO_ACP_BACKEND_SPEC } from '../acp/definition.js';

export const KIRO_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'kiro',
  builtInAcpCatalog: true,
  acpBackend: {
    createSpec: () => KIRO_ACP_BACKEND_SPEC,
  },
  cliAuth: {
    detectAuthStatus: async (params: Readonly<{
      runCommand: (
        args: readonly string[],
        options?: Readonly<{ timeoutMs?: number }>,
      ) => Promise<Readonly<{
        ok: boolean;
        stdout: string;
        stderr: string;
        exitCode: number | null;
      }>>;
    }>) => detectKiroCliAuthStatus({ runCommand: params.runCommand }),
  },
} as const);
