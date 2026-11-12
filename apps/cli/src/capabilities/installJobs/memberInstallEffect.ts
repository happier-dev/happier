import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { DaemonAgentInstallStartRequestSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { createAgentInstallJobOwner, type AgentInstallJobRegistry } from './agentInstallJobOwner';
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
  let owner: ReturnType<typeof createAgentInstallJobOwner> | undefined;
  let completion: Promise<void> | undefined;
  let admitted = false;
  const write = (record: unknown) => { output.write(JSON.stringify(record) + '\n'); };
  const stop = () => { void owner?.shutdown().catch(() => {}); };
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
      owner = createAgentInstallJobOwner({ accountId: operation.accountId, env: environment,
        readRegistry: () => operation.registry,
        readAcpCatalog: () => ({ status: 'ready', revision: 0, record: { v: 1,
          definitions: operation.definition ? [operation.definition] : [] } }),
        admittedOperation: operation,
        onEvent: event => write({ t: 'event', event }),
      });
      const activeOwner = owner;
      const started = activeOwner.start(operation.request);
      if (!started.ok) throw new Error('Member installation admission failed');
      completion = (async () => {
        const result = await activeOwner.read({ jobId: started.jobId, cursor: 0, waitForTerminal: true });
        let cleanupError = false;
        try { await activeOwner.shutdown(); } catch { cleanupError = true; }
        if (!result.ok || !result.outcome) throw new Error('Member installation returned no outcome');
        write({ t: 'outcome', outcome: result.outcome, ...(cleanupError ? { cleanupError: true } : {}) });
      })();
      if (signal.aborted) stop();
    }
    // EOF is sent by the host after consuming the terminal record, or by its
    // shutdown path. The child owns and awaits all native installer cleanup.
    if (owner) await owner.shutdown();
    await completion;
  } finally {
    signal.removeEventListener('abort', stop);
    lines.close();
    await owner?.shutdown();
  }
}
