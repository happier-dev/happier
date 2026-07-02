import type {
  AcpStderrRulesV1,
  AcpToolNameInferenceV1,
  AcpToolNameResolverV1,
} from '@happier-dev/plugin-sdk/acp';

export const KIMI_ACP_TIMEOUTS = Object.freeze({
  initMs: 90_000,
  toolCallMs: 120_000,
  toolKindTimeouts: {
    think: 30_000,
  },
  idleMs: 500,
});

export const KIMI_TOOL_NAME_INFERENCE = Object.freeze({
  patterns: [
    { name: 'read', patterns: ['read', 'read_file', 'readfile'], inputFields: ['path', 'filePath', 'filepath'] },
    { name: 'write', patterns: ['write', 'write_file', 'writefile'], inputFields: ['path', 'filePath', 'filepath', 'content', 'text'] },
    {
      name: 'edit',
      patterns: ['edit', 'str_replace_file', 'strreplacefile', 'replace_file'],
      inputFields: ['path', 'filePath', 'filepath', 'old_string', 'new_string', 'oldString', 'newString'],
    },
    { name: 'delete', patterns: ['delete', 'delete_file', 'deletefile', 'remove_file'], inputFields: ['path', 'filePath', 'filepath'] },
    { name: 'bash', patterns: ['shell', 'execute', 'execute_command', 'bash'], inputFields: ['command', 'cmd'] },
  ],
  preferLongestPattern: true,
  unknownToolNames: ['other', 'unknown', 'unknown tool'],
} satisfies AcpToolNameInferenceV1);

export const KIMI_STDERR_RULES = Object.freeze({
  statusErrors: [
    {
      includes: ['401'],
      detail: 'Authentication error. Run `kimi login` to re-authenticate, then retry.',
    },
    {
      includes: ['invalid_authentication'],
      detail: 'Authentication error. Run `kimi login` to re-authenticate, then retry.',
    },
    {
      includes: ['unauthorized'],
      detail: 'Authentication error. Run `kimi login` to re-authenticate, then retry.',
    },
    {
      includes: ['api key'],
      detail: 'Authentication error. Run `kimi login` to re-authenticate, then retry.',
    },
  ],
} satisfies AcpStderrRulesV1);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function mapTitleToToolName(title: string): string | null {
  const normalized = title.trim().toLowerCase();
  if (!normalized) return null;
  if (/^read(?:[\s_-]*file)?\b/.test(normalized) || normalized === 'readfile') return 'read';
  if (/^write(?:[\s_-]*file)?\b/.test(normalized) || normalized === 'writefile') return 'write';
  if (/^(?:edit|replace|strreplace)(?:[\s_-]*file)?\b/.test(normalized) || normalized === 'strreplacefile') return 'edit';
  if (/^(?:delete|remove)(?:[\s_-]*file)?\b/.test(normalized) || normalized === 'deletefile') return 'delete';
  if (/^(?:shell|execute|bash)\b/.test(normalized)) return 'bash';
  return null;
}

export const resolveKimiAcpToolName: AcpToolNameResolverV1 = ({ input }) => {
  const acp = asRecord(input._acp);
  const candidates = [input.title, input.description, acp?.title];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const mapped = mapTitleToToolName(candidate);
    if (mapped) return mapped;
  }
  return null;
};
