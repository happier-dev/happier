import type { Metadata } from '@/api/types';
import { randomBytes } from 'node:crypto';

type WindowsHostedActualMode = 'windows_terminal' | 'windows_console';
type WindowsHostedRequestedMode = 'windows_terminal' | 'console';

export function buildWindowsTerminalWindowIdentity(params: {
  existingSessionId?: string;
  reservedSessionId?: string;
  agentCommand: string;
  now?: () => number;
  randomHex?: () => string;
}): { windowId: string; title: string } {
  const now = params.now ?? (() => Date.now());
  const randomHex = params.randomHex ?? (() => randomBytes(4).toString('hex'));
  const base =
    (typeof params.existingSessionId === 'string' && params.existingSessionId.trim().length > 0
      ? params.existingSessionId.trim()
      : typeof params.reservedSessionId === 'string' && params.reservedSessionId.trim().length > 0
        ? params.reservedSessionId.trim()
        : `spawn-${now()}-${randomHex()}`);
  const sanitizedBase = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'session';
  const sanitizedAgent = params.agentCommand.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'agent';
  return {
    windowId: `happy-${sanitizedAgent}-${sanitizedBase}`,
    title: `Happier ${params.agentCommand} ${base}`,
  };
}

export function buildWindowsHostedTerminalArgs(params: {
  baseArgs: string[];
  actualMode: WindowsHostedActualMode;
  requestedMode: WindowsHostedRequestedMode;
  windowId?: string;
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
      pid: params.pid,
      ...(params.actualMode === 'windows_terminal' && typeof params.windowId === 'string' && params.windowId.trim().length > 0
        ? { windowId: params.windowId }
        : {}),
      ...(params.actualMode === 'windows_terminal' && typeof params.title === 'string' && params.title.trim().length > 0
        ? { title: params.title }
        : {}),
    },
  };
}
