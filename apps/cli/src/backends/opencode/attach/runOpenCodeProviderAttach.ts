import { spawn } from 'node:child_process';

import { prepareOwnedTerminalSpawn } from '@/terminal/runtime/terminalLaunchSpec';
import { runOwnedTerminalProcess } from '@/terminal/runtime/ownedTerminalProcess';
import { logger } from '@/ui/logger';
import type { ProviderAttachOps } from '@/backends/types';

import {
  readSharedManagedOpenCodeServerStateBestEffort,
  retainSharedManagedOpenCodeServerClient,
  withSharedManagedOpenCodeServerAccess,
} from '@/backends/opencode/server/sharedManagedServer';
import { createOpenCodeAttachArgs } from '@/backends/opencode/localControl/createOpenCodeAttachArgs';
import {
  resolveOpenCodeAttachChildEnv,
  resolveOpenCodeAttachTargetAuthHeaders,
} from '@/backends/opencode/localControl/openCodeAttachTargetAuth';
import {
  resolveOpenCodeAttachCliDialect,
  type OpenCodeAttachCliDialect,
} from '@/backends/opencode/localControl/resolveOpenCodeAttachCliDialect';
import { resolveOpenCodeCliLaunchSpec } from '@/backends/opencode/utils/resolveOpenCodeCliCommand';
import type { ProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { resolveOpenCodeProviderAttachTargetWithManagedServerFallback } from './evaluateOpenCodeProviderAttachEligibility';

export async function runOpenCodeProviderAttach(params: Readonly<{
  sessionId: string;
  metadata: Record<string, unknown>;
  prepareProviderCliAttach?: Parameters<ProviderAttachOps['runAttach']>[0]['prepareProviderCliAttach'];
  terminalClient?: Parameters<ProviderAttachOps['runAttach']>[0]['terminalClient'];
  spawnProcess?: typeof spawn;
  command?: string;
  commandArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  readManagedServerStateFn?: typeof readSharedManagedOpenCodeServerStateBestEffort;
  resolveCommandFn?: (env?: NodeJS.ProcessEnv) => ProviderCliLaunchSpec;
  /** Overrides the target probe; omit in production so the actual server decides the dialect. */
  resolveDialectFn?: (params: Readonly<{
    baseUrl: string;
    launchApiGeneration?: 'auto' | 'v2';
    headers?: Record<string, string>;
  }>) => Promise<OpenCodeAttachCliDialect> | OpenCodeAttachCliDialect;
}>): Promise<number> {
  const readManagedServerStateFn = params.readManagedServerStateFn ?? readSharedManagedOpenCodeServerStateBestEffort;
  const target = await resolveOpenCodeProviderAttachTargetWithManagedServerFallback({
    metadata: params.metadata,
    readManagedServerStateFn,
  });
  if (!target.eligible) {
    return 1;
  }

  const releaseClient = await withSharedManagedOpenCodeServerAccess(
    async () => await retainSharedManagedOpenCodeServerClient(target.baseUrl,
      target.managedServerLaunchFingerprint != null, target.managedServerLaunchFingerprint),
    target.baseUrl,
    target.managedServerLaunchFingerprint,
  );
  let ownedProcessStarted = false;
  let ownedProcessStopped = false;
  try {
    const spawnProcess = params.spawnProcess ?? spawn;
    const ambientEnv = params.env ?? process.env;
    const launch = params.command && params.commandArgs
      ? null
      : (params.resolveCommandFn ?? resolveOpenCodeCliLaunchSpec)(ambientEnv);
    const command = params.command ?? launch?.command ?? resolveOpenCodeCliLaunchSpec(ambientEnv).command;
    const commandArgs = params.commandArgs ?? launch?.args ?? resolveOpenCodeCliLaunchSpec(ambientEnv).args;
    // A loopback (Happier-managed) target is password protected, so both the dialect probe and the
    // attached CLI need its credential; a remote target keeps the ambient environment untouched.
    const env = await resolveOpenCodeAttachChildEnv({
      baseUrl: target.baseUrl,
      managedServerLaunchFingerprint: target.managedServerLaunchFingerprint,
      env: ambientEnv,
      ...(params.readManagedServerStateFn ? { readManagedServerStateFn: params.readManagedServerStateFn } : {}),
    });
    const launchApiGeneration = launch && 'apiGeneration' in launch
      && (launch.apiGeneration === 'v2' || launch.apiGeneration === 'auto')
      ? launch.apiGeneration
      : undefined;
    const dialect = await (params.resolveDialectFn ?? resolveOpenCodeAttachCliDialect)({
      baseUrl: target.baseUrl,
      ...(launchApiGeneration ? { launchApiGeneration } : {}),
      headers: await resolveOpenCodeAttachTargetAuthHeaders({
        baseUrl: target.baseUrl,
        managedServerLaunchFingerprint: target.managedServerLaunchFingerprint,
        env: ambientEnv,
        ...(params.readManagedServerStateFn ? { readManagedServerStateFn: params.readManagedServerStateFn } : {}),
      }),
    });
    if (dialect === 'v2' || params.terminalClient) {
      if (!params.prepareProviderCliAttach) {
        throw new Error('provider_cli_attach_preparation_unavailable');
      }
      const preparation = await params.prepareProviderCliAttach({ providerSessionId: target.vendorSessionId }).catch(() => {
        throw new Error('provider_cli_attach_preparation_failed');
      });
      if (!preparation.ok) throw new Error('provider_cli_attach_not_ready');
      if (preparation.providerSessionId !== target.vendorSessionId) {
        throw new Error('provider_cli_attach_identity_mismatch');
      }
    }
    const prepared = await prepareOwnedTerminalSpawn({
      command,
      args: [
        ...commandArgs,
        ...createOpenCodeAttachArgs({
          baseUrl: target.baseUrl,
          directory: target.directory,
          sessionId: target.vendorSessionId,
          dialect,
        }),
      ],
      env,
      cwd: process.cwd(),
    });
    try {
      const observe = params.terminalClient ? async (attached: boolean, launcher: Parameters<NonNullable<Parameters<typeof runOwnedTerminalProcess>[0]['onStarted']>>[0]) => {
        const result = await params.prepareProviderCliAttach!({ providerSessionId: target.vendorSessionId,
          terminalClient: { attached, herdr: params.terminalClient!, launcher } });
        if (!result.ok || result.providerSessionId !== target.vendorSessionId) throw new Error('provider_cli_attach_admission_failed');
      } : null;
      ownedProcessStarted = true;
      const result = await runOwnedTerminalProcess({ spawn: prepared, cwd: process.cwd(), spawnProcess,
        ...(observe ? { onStarted: launcher => observe(true, launcher), onExited: launcher => observe(false, launcher) } : {}) });
      ownedProcessStopped = result.nativeExited === true || result.processTreeStopped === true;
      return result.code ?? 1;
    } catch {
      logger.infoFile('[terminal] Native terminal attach failed (terminal_native_attach_failed)');
      return 1;
    }
  } finally {
    if (!ownedProcessStarted || ownedProcessStopped) {
      await releaseClient().catch(error => logger.warn('[OpenCodeServer] Native attach client release failed; retaining custody', error));
    } else {
      logger.warn('[OpenCodeServer] Native attach exit could not prove process cleanup; client custody remains unchanged');
    }
  }
}
