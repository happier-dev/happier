export function extractAgentIdFromTaskResultText(text: string): { agentId: string | null; taskId: string | null } {
  const raw = String(text ?? '');

  const agentId =
    raw.match(/\bagentId\s*[:=]\s*([A-Za-z0-9._-]+)/i)?.[1] ??
    raw.match(/\bagent_id\s*[:=]\s*([A-Za-z0-9._-]+)/i)?.[1] ??
    null;

  const taskId =
    raw.match(/\btask_id\s*[:=]\s*([A-Za-z0-9._-]+)/i)?.[1] ??
    raw.match(/\btaskId\s*[:=]\s*([A-Za-z0-9._-]+)/i)?.[1] ??
    null;

  return {
    agentId: agentId ? String(agentId) : null,
    taskId: taskId ? String(taskId) : null,
  };
}

