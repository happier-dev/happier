function buildReviewGuidanceBlock(): string {
  return [
    'Return ONLY valid JSON with this shape:',
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
  ].join('\n');
}

export function buildStandardReviewPrompt(params: Readonly<{ instructions: string }>): string {
  return `${params.instructions}\n\n${buildReviewGuidanceBlock()}`;
}

