export type ClaudeSdkFlagOverrides = {
  maxTurns?: number;
  strictMcpConfig?: boolean;
  appendSystemPrompt?: string;
  customSystemPrompt?: string;
  model?: string;
  fallbackModel?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
};

export function parseClaudeSdkFlagOverridesFromArgs(args?: string[]): ClaudeSdkFlagOverrides {
  const input = args ?? [];
  let maxTurns: number | undefined;
  let strictMcpConfig: boolean | undefined;
  let appendSystemPrompt: string | undefined;
  let customSystemPrompt: string | undefined;
  let model: string | undefined;
  let fallbackModel: string | undefined;
  let allowedTools: string[] | undefined;
  let disallowedTools: string[] | undefined;

  const nextValue = (index: number): string | undefined => {
    const next = index + 1 < input.length ? input[index + 1] : undefined;
    if (typeof next !== 'string') return undefined;
    if (next.startsWith('-')) return undefined;
    return next;
  };

  for (let i = 0; i < input.length; i++) {
    const arg = input[i];

    if (arg === '--max-turns') {
      const next = nextValue(i);
      if (typeof next === 'string') {
        const parsed = Number.parseInt(next, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          maxTurns = parsed;
        }
        i++;
      }
      continue;
    }

    if (arg === '--strict-mcp-config') {
      strictMcpConfig = true;
      continue;
    }

    if (arg === '--append-system-prompt') {
      const next = nextValue(i);
      if (typeof next === 'string') {
        appendSystemPrompt = next;
        i++;
      }
      continue;
    }

    if (arg === '--system-prompt') {
      const next = nextValue(i);
      if (typeof next === 'string') {
        customSystemPrompt = next;
        i++;
      }
      continue;
    }

    if (arg === '--model') {
      const next = nextValue(i);
      if (typeof next === 'string') {
        model = next;
        i++;
      }
      continue;
    }

    if (arg === '--fallback-model') {
      const next = nextValue(i);
      if (typeof next === 'string') {
        fallbackModel = next;
        i++;
      }
      continue;
    }

    if (arg === '--allowedTools') {
      const next = nextValue(i);
      if (typeof next === 'string') {
        const parsed = next
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        allowedTools = parsed.length > 0 ? parsed : allowedTools;
        i++;
      }
      continue;
    }

    if (arg === '--disallowedTools') {
      const next = nextValue(i);
      if (typeof next === 'string') {
        const parsed = next
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        disallowedTools = parsed.length > 0 ? parsed : disallowedTools;
        i++;
      }
      continue;
    }
  }

  return {
    maxTurns,
    strictMcpConfig,
    appendSystemPrompt,
    customSystemPrompt,
    model,
    fallbackModel,
    allowedTools,
    disallowedTools,
  };
}
