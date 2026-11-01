/** Codex rollout metadata uses `subagent`; app-server v2 uses `subAgent`. */
export function isCodexGuardianReviewSource(source: unknown): boolean {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  const record = source as Record<string, unknown>;
  return [record.subagent, record.subAgent].some((subagent) =>
    subagent !== null && typeof subagent === 'object' && !Array.isArray(subagent)
    && (subagent as Record<string, unknown>).other === 'guardian',
  );
}
