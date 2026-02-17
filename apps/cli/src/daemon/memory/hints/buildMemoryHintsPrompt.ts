export function buildMemoryHintsPrompt(params: Readonly<{
  sessionId: string;
  seqFrom: number;
  seqTo: number;
  previousSynopsis?: string | null;
  messages: ReadonlyArray<Readonly<{ seq: number; role: 'user' | 'assistant'; text: string }>>;
  budgets: Readonly<{ maxSummaryChars: number; maxKeywords: number; maxEntities: number; maxDecisions: number }>;
}>): string {
  const guidance = [
    'You are generating private "memory hints" for a local, encrypted assistant.',
    '',
    'Return ONLY valid JSON (no markdown, no code fences, no additional prose).',
    '',
    'Safety and privacy rules:',
    '- Do not include secrets (tokens, passwords, api keys, auth headers).',
    '- Do not quote tool arguments or file contents; only summarize user/assistant discussion.',
    '',
    'Output JSON schema:',
    '{',
    '  "shard": {',
    '    "v": 1,',
    '    "seqFrom": number,',
    '    "seqTo": number,',
    '    "createdAtFromMs": number,',
    '    "createdAtToMs": number,',
    '    "summary": string,',
    '    "keywords": string[],',
    '    "entities": string[],',
    '    "decisions": string[]',
    '  },',
    '  "synopsis": {',
    '    "v": 1,',
    '    "seqTo": number,',
    '    "updatedAtMs": number,',
    '    "synopsis": string',
    '  } | null',
    '}',
    '',
    `Budgets (hard limits): maxSummaryChars=${params.budgets.maxSummaryChars}, maxKeywords=${params.budgets.maxKeywords}, maxEntities=${params.budgets.maxEntities}, maxDecisions=${params.budgets.maxDecisions}`,
  ].join('\n');

  const window = {
    sessionId: String(params.sessionId ?? ''),
    seqFrom: Math.max(0, Math.trunc(params.seqFrom)),
    seqTo: Math.max(0, Math.trunc(params.seqTo)),
    previousSynopsis: (typeof params.previousSynopsis === 'string' ? params.previousSynopsis : '').trim() || null,
    messages: params.messages.map((m) => ({
      seq: Math.max(0, Math.trunc(m.seq)),
      role: m.role,
      text: String(m.text ?? ''),
    })),
  };

  return `${guidance}\n\nInput window JSON:\n${JSON.stringify(window)}`;
}

