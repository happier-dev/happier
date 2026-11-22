import { configuration } from '@/configuration';
import { createTmuxTerminalHostAdapter } from '@/integrations/tmux';
import {
  createZellijTerminalHostAdapter,
  DEFAULT_ZELLIJ_STARTUP_ACTION_TIMEOUT_MS,
  type ZellijLaunchStrategy,
} from '@/integrations/zellij/adapter';
import { resolveZellijRuntimeBinary } from '@/integrations/zellij/runtimeBinary';
import { createHerdrTerminalHostAdapter } from '@/integrations/herdr/adapter';
import { resolveHerdrRuntimeBinary } from '@/integrations/herdr/runtimeBinary';
import type { TerminalPromptSubmitVerificationPolicy } from './promptSubmitVerification';
import type { TerminalHostAdapter } from './_types';

import { createTerminalHostRegistry, type TerminalHostRegistry } from './registry';

export function resolveDefaultTerminalHostStartupTimeoutMs(): number {
  return Math.max(configuration.claudeUnifiedTerminalHostActionTimeoutMs, DEFAULT_ZELLIJ_STARTUP_ACTION_TIMEOUT_MS);
}

export async function createDefaultTerminalHostRegistry(options: Readonly<{
  /** Recorded Herdr sockets can be controlled without admitting a new runtime. */
  forExistingAttachments?: boolean;
  promptSubmitVerification?: TerminalPromptSubmitVerificationPolicy;
  zellijBinary?: string | null;
  zellijDefaultShell?: string;
  zellijLaunchStrategy?: ZellijLaunchStrategy;
  herdrSessionName?: string;
  herdrSocketPath?: string;
  windowsConsoleAdapter?: TerminalHostAdapter | null;
}> = {}): Promise<TerminalHostRegistry> {
  const zellijBinary = options.zellijBinary === undefined
    ? await resolveZellijRuntimeBinary().catch(() => null)
    : options.zellijBinary;
  const herdrBinary = options.forExistingAttachments ? null : await resolveHerdrRuntimeBinary({
    actionTimeoutMs: configuration.claudeUnifiedTerminalHostActionTimeoutMs,
  });
  return createTerminalHostRegistry([
    ...(options.windowsConsoleAdapter ? [options.windowsConsoleAdapter] : []),
    createTmuxTerminalHostAdapter({ promptSubmitVerification: options.promptSubmitVerification }),
    ...(zellijBinary
      ? [
        createZellijTerminalHostAdapter({
          zellijBinary,
          happyHomeDir: configuration.happyHomeDir,
          promptSubmitVerification: options.promptSubmitVerification,
          defaultShell: options.zellijDefaultShell,
          launchStrategy: options.zellijLaunchStrategy,
          actionTimeoutMs: configuration.claudeUnifiedTerminalHostActionTimeoutMs,
          startupActionTimeoutMs: resolveDefaultTerminalHostStartupTimeoutMs(),
        }),
      ]
      : []),
    ...(herdrBinary || options.forExistingAttachments
      ? [createHerdrTerminalHostAdapter({
        binary: herdrBinary,
        sessionName: options.herdrSessionName,
        socketPath: options.herdrSocketPath,
        promptSubmitVerification: options.promptSubmitVerification,
        actionTimeoutMs: configuration.claudeUnifiedTerminalHostActionTimeoutMs,
        startupTimeoutMs: resolveDefaultTerminalHostStartupTimeoutMs(),
      })]
      : []),
  ]);
}
