export type CodexAcpLoadSessionCapabilities = Readonly<{
  loadSession: boolean;
  sessionCapabilities: Record<string, unknown>;
  promptCapabilities: Readonly<{
    image: boolean;
    audio: boolean;
    embeddedContext: boolean;
  }>;
  mcpCapabilities: Readonly<{
    http: boolean;
    sse: boolean;
  }>;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readBooleanCapability(record: Record<string, unknown> | null, key: string): boolean {
  return record?.[key] === true;
}

export function normalizeCodexAcpLoadSessionCapabilities(capabilities: unknown): CodexAcpLoadSessionCapabilities {
  const root = asRecord(capabilities) ?? {};
  const promptCapabilities = asRecord(root.promptCapabilities);
  const mcpCapabilities = asRecord(root.mcpCapabilities);
  const sessionCapabilities = asRecord(root.sessionCapabilities) ?? {};
  const loadSession = root.loadSession === true;

  return {
    loadSession,
    sessionCapabilities,
    promptCapabilities: {
      image: readBooleanCapability(promptCapabilities, 'image'),
      audio: readBooleanCapability(promptCapabilities, 'audio'),
      embeddedContext: readBooleanCapability(promptCapabilities, 'embeddedContext'),
    },
    mcpCapabilities: {
      http: readBooleanCapability(mcpCapabilities, 'http'),
      sse: readBooleanCapability(mcpCapabilities, 'sse'),
    },
  };
}
