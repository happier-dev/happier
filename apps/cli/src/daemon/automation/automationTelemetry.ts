import { logger } from '@/ui/logger';

export function logAutomationInfo(message: string, data?: Record<string, unknown>): void {
  logger.debug(`[DAEMON AUTOMATION] ${message}`, data);
}

export function logAutomationWarn(message: string, error?: unknown, data?: Record<string, unknown>): void {
  let identity: Record<string, unknown> = {};
  if (error instanceof Error) {
    // Error identity is structural; messages, causes, response bodies and arbitrary
    // stack text can carry private content. Keep only identifiers and code locations.
    const name = /^[A-Za-z][A-Za-z0-9_]*$/.test(error.name) ? error.name : undefined;
    const code: unknown = Reflect.get(error, 'code');
    const header = `${error.name}: ${error.message}`;
    const frames = error.stack?.startsWith(header) ? error.stack.slice(header.length) : '';
    const locations = frames.split('\n').flatMap((rawFrame) => {
      const frame = rawFrame.replaceAll('\\', '/');
      if (!/^\s+at\s/.test(frame)) return [];
      const location = frame.match(/(?:^|[/\\])((?:apps\/(?:cli|server)|packages\/[^/]+)\/(?:src|sources)\/[A-Za-z0-9_./-]+\.[cm]?[jt]sx?:\d+:\d+)\)?$/)?.[1]
        ?? frame.match(/(?:^|\/)(package-dist\/[A-Za-z0-9_-]+\.[cm]?[jt]s:\d+:\d+)\)?$/)?.[1]
        ?? frame.match(/(node:[A-Za-z0-9_./-]+:\d+:\d+)\)?$/)?.[1];
      return location ? [location] : [];
    });
    identity = {
      ...(name ? { errorName: name } : {}),
      ...(typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(code) ? { errorCode: code }
        : typeof code === 'number' && Number.isFinite(code) ? { errorCode: code } : {}),
      ...(locations.length ? { errorStack: locations } : {}),
      errorOperation: message,
    };
  }
  logger.warn(`[DAEMON AUTOMATION] ${message}`, {
    ...(data ?? {}),
    ...identity,
    error: error ? 'redacted' : undefined,
  });
}
