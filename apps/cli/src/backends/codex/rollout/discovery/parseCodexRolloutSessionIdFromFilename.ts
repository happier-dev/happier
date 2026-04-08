export function parseCodexRolloutSessionIdFromFilename(filePath: string): string | null {
    const name = filePath.split(/[/\\\\]/).pop() ?? '';
    const match = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/i.exec(name);
    const sessionId = match?.[1]?.trim() ?? '';
    return sessionId || null;
}
