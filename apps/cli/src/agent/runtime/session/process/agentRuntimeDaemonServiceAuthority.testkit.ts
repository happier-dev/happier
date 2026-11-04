import { createAgentRuntimeDaemonServiceAuthorityPath } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';

export async function createAgentRuntimeDaemonServiceAuthorityFixture(input: Readonly<{
  happyHomeDir: string;
  runner: Readonly<{
    pid: number;
    processStartTimeMs: number;
    processCommandHash: string;
    snapshotIdentity: string;
  }>;
}>): Promise<Readonly<{
  path: string;
  happyHomeDir: string;
  publicReleaseRing: 'stable';
  sessionId: string;
  runner: typeof input.runner;
  retainedAgent: ReturnType<typeof createAgentSessionRunnerFactoryBinding>;
}>> {
  return {
    path: await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir: input.happyHomeDir,
      publicReleaseRing: 'stable',
    }),
    happyHomeDir: input.happyHomeDir,
    publicReleaseRing: 'stable',
    sessionId: 'session-1',
    runner: input.runner,
    retainedAgent: createAgentSessionRunnerFactoryBinding({
      v: 1,
      pluginId: 'acme.plugin',
      pluginVersion: '1.2.3',
      agentId: 'acme-agent',
      localAgentId: 'acme-agent',
      sourceCustody: {
        kind: 'managed',
        immutableGenerationId: `sha256:${'1'.repeat(64)}`,
        installSource: 'localPath',
      },
      locator: {
        module: './runtime.mjs',
        export: 'createRuntime',
        runtimeApiVersion: 1,
      },
      normalizedModulePath: '/immutable/acme/runtime.mjs',
      loadMode: 'immutable-js',
    }),
  };
}
