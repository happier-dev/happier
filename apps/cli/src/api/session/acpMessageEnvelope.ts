export function buildAcpAgentMessageEnvelope(opts: {
  provider: string;
  body: unknown;
  meta?: Record<string, unknown>;
}): {
  role: 'agent';
  content: { type: 'acp'; provider: string; data: unknown };
  meta: Record<string, unknown>;
} {
  return {
    role: 'agent',
    content: {
      type: 'acp',
      provider: opts.provider,
      data: opts.body,
    },
    meta: {
      sentFrom: 'cli',
      source: 'cli',
      ...(opts.meta && typeof opts.meta === 'object' ? opts.meta : {}),
    },
  };
}

export function shouldTraceAcpMessageType(
  type: string,
  opts?: { includeTaskComplete?: boolean },
): boolean {
  if (
    type === 'tool-call' ||
    type === 'tool-result' ||
    type === 'permission-request' ||
    type === 'file-edit' ||
    type === 'terminal-output'
  ) {
    return true;
  }

  if (opts?.includeTaskComplete === true && type === 'task_complete') {
    return true;
  }

  return false;
}
