function buildReviewGuidanceBlock(): string {
  return [
    'While working, you may emit brief progress updates as plain text.',
    'When finished, output ONE final JSON object with this shape as the LAST thing in your message:',
    '{',
    '  "summary": string,',
    '  "findings": Array<{',
    '    "id": string,',
    '    "title": string,',
    '    "severity": "blocker"|"high"|"medium"|"low"|"nit",',
    '    "category": "correctness"|"security"|"performance"|"maintainability"|"testing"|"style"|"docs",',
    '    "summary": string,',
    '    "filePath"?: string,',
    '    "startLine"?: number,',
    '    "endLine"?: number,',
    '    "suggestion"?: string,',
    '    "patch"?: string',
    '  }>',
    '}',
    '',
    'Rules for the final JSON:',
    '- It MUST be valid JSON (parsable by JSON.parse).',
    '- Do NOT wrap it in markdown code fences.',
    '- Do NOT include any extra text after the JSON.',
  ].join('\n');
}

export function buildStandardReviewPrompt(params: Readonly<{ instructions: string }>): string {
  return `${params.instructions}\n\n${buildReviewGuidanceBlock()}`;
}
