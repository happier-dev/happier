export function extractMcpServersFromClaudeArgs(
  args?: string[],
): { claudeArgs?: string[]; mcpServers: Record<string, any> } {
  const input = args ?? [];
  if (input.length === 0) return { claudeArgs: args, mcpServers: {} };

  const output: string[] = [];
  const mcpServers: Record<string, any> = {};
  let strippedAny = false;

  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (arg !== '--mcp-config') {
      output.push(arg);
      continue;
    }

    const raw = i + 1 < input.length ? input[i + 1] : undefined;
    if (typeof raw !== 'string' || raw.length === 0) {
      // Keep as-is so upstream Claude can surface a helpful error message.
      output.push(arg);
      continue;
    }

    // Consume value
    i++;

    try {
      const parsed = JSON.parse(raw) as any;
      const servers = parsed && typeof parsed === 'object' ? (parsed as any).mcpServers : null;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
        output.push('--mcp-config', raw);
        continue;
      }

      for (const [name, config] of Object.entries(servers as Record<string, unknown>)) {
        if (!name || typeof name !== 'string') continue;
        mcpServers[name] = config;
      }

      const extras = parsed && typeof parsed === 'object' ? { ...(parsed as Record<string, unknown>) } : null;
      if (extras) {
        delete (extras as any).mcpServers;
        if (Object.keys(extras).length > 0) {
          output.push('--mcp-config', JSON.stringify(extras));
        }
      }
      strippedAny = true;
    } catch {
      // Invalid JSON; keep as-is for upstream Claude.
      output.push('--mcp-config', raw);
    }
  }

  if (!strippedAny) return { claudeArgs: args, mcpServers };
  return { claudeArgs: output.length > 0 ? output : undefined, mcpServers };
}

