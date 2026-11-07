import { spawn } from 'node:child_process';

import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import type {
  PreflightSessionCatalogsRaw,
  PreflightSessionControlsProbeParams,
} from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import { getDefaultClaudeCodePathForAgentSdk, isClaudeAgentSdkJavaScriptEntrypoint } from '@/backends/claude/sdk/utils';
import { buildClaudeSubprocessEnv } from '@/backends/claude/spawn/buildClaudeSubprocessEnv';
import { resolveClaudeLaunchSettingsOverlayArg } from '@/backends/claude/utils/resolveClaudeLaunchSettingsOverlay';
import { resolveClaudeSettingSources } from '@/backends/claude/utils/resolveClaudeSettingSources';
import { ensureJavaScriptRuntimeExecutable } from '@/runtime/js/ensureJavaScriptRuntimeExecutable';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { resolveClaudeSessionEnvOverlay } from '../spawn/resolveClaudeSessionEnvOverlay';
import { isBun } from '@/utils/runtime';
import { remainingCatalogProbeMs, withCatalogProbeLifecycle } from '@/capabilities/probes/catalogProbeLifecycle';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';

/** Native initialization advertises slash commands; it does not advertise a typed skill-mention catalog. */
export async function probeClaudeCatalogs(params: PreflightSessionControlsProbeParams): Promise<PreflightSessionCatalogsRaw> {
  const processEnv = params.processEnv ?? process.env;
  const subprocessEnv = buildClaudeSubprocessEnv({
    baseEnv: processEnv,
    envOverlay: resolveClaudeSessionEnvOverlay({ claudeCodeIncludeInNativeHistory: params.accountSettings?.claudeCodeIncludeInNativeHistory === true }),
  });
  const messages = new PushableAsyncIterable<SDKUserMessage>();
  const abortController = new AbortController();
  const lifecycle: { response: Query | null } = { response: null };
  let signal: AbortSignal | undefined;
  const onAbort = () => abortController.abort(signal?.reason);
  let child: ReturnType<typeof spawn> | undefined;
  let childClosed: Promise<void> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    signal?.removeEventListener('abort', onAbort);
    messages.end();
    try {
      lifecycle.response?.close();
    } finally {
      abortController.abort();
      if (child) await killProcessTree(child);
      await childClosed;
    }
  })();
  return await withCatalogProbeLifecycle(params, async (probeLifecycle): Promise<PreflightSessionCatalogsRaw> => {
    signal = probeLifecycle.signal;
    signal.addEventListener('abort', onAbort, { once: true });
    remainingCatalogProbeMs(probeLifecycle);
    const executable = getDefaultClaudeCodePathForAgentSdk(processEnv);
    const isJavaScriptEntrypoint = isClaudeAgentSdkJavaScriptEntrypoint(executable);
    const runtimeExecutable = isJavaScriptEntrypoint
      ? await ensureJavaScriptRuntimeExecutable({ isBunRuntime: isBun(), processEnv })
      : null;
    if (isJavaScriptEntrypoint && !runtimeExecutable) throw new Error('Claude catalog probe requires a JavaScript runtime');
    remainingCatalogProbeMs(probeLifecycle);
    const settings = resolveClaudeLaunchSettingsOverlayArg({
      env: { ...processEnv, ...subprocessEnv }, settingsPath: undefined, launchSettings: {},
      cwd: params.cwd,
    });
    const response = query({
      prompt: messages,
      options: {
        cwd: params.cwd,
        env: subprocessEnv,
        pathToClaudeCodeExecutable: executable,
        executable: 'node',
        abortController,
        persistSession: false,
        ...(settings ? { extraArgs: { settings } } : {}),
        settingSources: resolveClaudeSettingSources(params.accountSettings ?? {}),
        spawnClaudeCodeProcess: (options) => {
          probeLifecycle.signal.throwIfAborted();
          // The SDK's runtime aliases must resolve through Happier's binary-safe runtime owner.
          let command = options.command;
          if (command === 'node') {
            if (!runtimeExecutable) throw new Error('Claude SDK requested an unavailable JavaScript runtime');
            command = runtimeExecutable;
          }
          const invocation = resolveWindowsCommandInvocation({
            command,
            args: options.args,
            env: subprocessEnv,
          });
          const startedChild = spawn(invocation.command, invocation.args, {
            cwd: options.cwd,
            // The SDK merges its host environment into options.env. Keep the selected
            // preflight environment authoritative rather than reintroducing ambient auth.
            env: subprocessEnv,
            signal: options.signal,
            stdio: ['pipe', 'pipe', 'ignore'],
            windowsHide: true,
            ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
          });
          child = startedChild;
          childClosed = new Promise<void>((resolve) => startedChild.once('close', () => resolve()));
          params.onNativeCleanup?.(cleanup);
          return startedChild;
        },
      },
    });
    lifecycle.response = response;
    return { commands: await response.supportedCommands(), skills: null };
  }, cleanup);
}
