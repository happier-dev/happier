import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { DaemonAgentInstallStartRequestSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import type { AgentInstallJobRegistry } from './agentInstallJobOwner';
import { executeAgentInstall } from './executeAgentInstall';
import { resolveMemberAgentInstallCli } from './memberResolveEffect';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';

// This pipe is private to the admitted host. Declaration data already belongs to
// the trusted registry; only the closed operation envelope and public request are parsed here.
const OperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('install'), request: DaemonAgentInstallStartRequestSchema,
    accountId: z.string().min(1), registry: z.custom<AgentInstallJobRegistry>(),
    definition: z.optional(AcpBackendDefinitionV1Schema), targetInUse: z.boolean(),
    runtimeManagedDependencyId: z.string().nullable() }),
  z.strictObject({ kind: z.literal('resolve'), runtimeSpec: z.custom<AgentCliRuntimeDescriptor>(),
    sharedManagedToolsRoot: z.string().optional() }),
]);

/** Entire acquisition, promotion and verification runs as the native member. */
export async function runMemberAgentInstallEffect(input: Readable, output: Writable, signal: AbortSignal,
  environment: ProcessEnvInput = process.env): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const controller = new AbortController();
  let completion: Promise<void> | undefined;
  let admitted = false;
  const write = (record: unknown) => { output.write(JSON.stringify(record) + '\n'); };
  const stop = () => { controller.abort(); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    for await (const line of lines) {
      if (admitted) {
        if (line !== 'cancel') throw new Error('Invalid member operation');
        stop(); continue;
      }
      const operation = OperationSchema.parse(JSON.parse(line));
      admitted = true;
      if (operation.kind === 'resolve') {
        write({ t: 'resolved', launch: resolveMemberAgentInstallCli(operation, { ...environment }) });
        continue;
      }
      completion = (async () => {
        const result = await executeAgentInstall(operation.request, controller.signal, {
          accountId: operation.accountId, registry: operation.registry, agent: operation.registry.agents[0]!,
          definition: operation.definition, env: environment, platform: process.platform, arch: process.arch,
          admittedOperation: operation, isTargetInUse: () => operation.targetInUse,
          onEvent: event => write({ t: 'event', event }),
        });
        write({ t: 'outcome', outcome: result.outcome, ...(result.cleanupError ? { cleanupError: true } : {}) });
      })();
      if (signal.aborted) stop();
    }
    // EOF is sent by the host after consuming the terminal record, or by its
    // shutdown path. The child owns and awaits all native installer cleanup.
    stop();
    await completion;
  } finally {
    signal.removeEventListener('abort', stop);
    lines.close();
    stop();
    await completion;
  }
}
