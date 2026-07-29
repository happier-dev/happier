import type { Metadata } from '@/api/types';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_WINDOWS_TERMINAL_WINDOW_NAME,
  normalizeWindowsTerminalWindowName as normalizeProtocolWindowsTerminalWindowName,
} from '@happier-dev/protocol';

type WindowsHostedActualMode = 'windows_terminal' | 'windows_console';
type WindowsHostedRequestedMode = 'windows_terminal' | 'console';

export function normalizeWindowsTerminalWindowName(value: unknown): string {
  return normalizeProtocolWindowsTerminalWindowName(value);
}

export function resolveWindowsTerminalWindowName(params: {
  requested?: string | null | undefined;
  env: NodeJS.ProcessEnv;
}): string {
  const envName = normalizeWindowsTerminalWindowName(params.env.HAPPIER_WINDOWS_TERMINAL_WINDOW_NAME);
  if (envName !== DEFAULT_WINDOWS_TERMINAL_WINDOW_NAME || typeof params.env.HAPPIER_WINDOWS_TERMINAL_WINDOW_NAME === 'string') {
    return envName;
  }

  const legacyEnvName = normalizeWindowsTerminalWindowName(params.env.HAPPIER_WINDOWS_TERMINAL_WINDOW_ID);
  if (legacyEnvName !== DEFAULT_WINDOWS_TERMINAL_WINDOW_NAME || typeof params.env.HAPPIER_WINDOWS_TERMINAL_WINDOW_ID === 'string') {
    return legacyEnvName;
  }

  return normalizeWindowsTerminalWindowName(params.requested);
}

export function buildWindowsTerminalWindowIdentity(params: {
  existingSessionId?: string;
  reservedSessionId?: string;
  agentCommand: string;
  windowName?: string | null;
  now?: () => number;
  randomHex?: () => string;
}): {
  windowId: string;
  title: string;
  launchCorrelation: string;
} {
  const now = params.now ?? (() => Date.now());
  const randomHex =
    params.randomHex
    ?? (() => randomBytes(16).toString('hex'));
  const launchCorrelation = randomHex();
  const base =
    (typeof params.existingSessionId === 'string' && params.existingSessionId.trim().length > 0
      ? params.existingSessionId.trim()
      : typeof params.reservedSessionId === 'string' && params.reservedSessionId.trim().length > 0
        ? params.reservedSessionId.trim()
        : `spawn-${now()}`);
  return {
    windowId: normalizeWindowsTerminalWindowName(params.windowName),
    title:
      `Happier ${params.agentCommand} ${base} [${launchCorrelation}]`,
    launchCorrelation,
  };
}

export function buildWindowsHostedTerminalArgs(params: {
  baseArgs: string[];
  actualMode: WindowsHostedActualMode;
  requestedMode: WindowsHostedRequestedMode;
  windowId?: string;
  title?: string;
  launchCorrelation?: string;
  fallbackReason?: string;
}): string[] {
  return [
    ...params.baseArgs,
    '--happy-terminal-mode',
    params.actualMode,
    '--happy-terminal-requested',
    params.requestedMode,
    ...(params.actualMode === 'windows_terminal' && typeof params.windowId === 'string' && params.windowId.trim().length > 0
      ? ['--happy-terminal-window-id', params.windowId]
      : []),
    ...(params.actualMode === 'windows_terminal' && typeof params.title === 'string' && params.title.trim().length > 0
      ? ['--happy-terminal-title', params.title]
      : []),
    ...(typeof params.launchCorrelation === 'string'
      && /^[a-f0-9]{32}$/u.test(params.launchCorrelation)
      ? [
          '--happy-terminal-launch-correlation',
          params.launchCorrelation,
        ]
      : []),
    ...(typeof params.fallbackReason === 'string' && params.fallbackReason.trim().length > 0
      ? ['--happy-terminal-fallback-reason', params.fallbackReason]
      : []),
  ];
}

export function buildWindowsHostedTerminalAttachment(params: {
  actualMode: WindowsHostedActualMode;
  requestedMode: WindowsHostedRequestedMode;
  pid: number;
  windowId?: string;
  title?: string;
  fallbackReason?: string;
}): NonNullable<Metadata['terminal']> {
  return {
    mode: params.actualMode,
    requested: params.requestedMode,
    ...(typeof params.fallbackReason === 'string' && params.fallbackReason.trim().length > 0
      ? { fallbackReason: params.fallbackReason }
      : {}),
    windows: {
      host: params.actualMode === 'windows_terminal' ? 'windows_terminal' : 'console',
      ...(params.actualMode === 'windows_console'
        ? { pid: params.pid }
        : {}),
      ...(params.actualMode === 'windows_terminal' && typeof params.windowId === 'string' && params.windowId.trim().length > 0
        ? { windowId: params.windowId }
        : {}),
      ...(params.actualMode === 'windows_terminal' && typeof params.title === 'string' && params.title.trim().length > 0
        ? { title: params.title }
        : {}),
    },
  };
}
