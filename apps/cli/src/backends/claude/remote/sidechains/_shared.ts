import type { RawJSONLines } from '@/backends/claude/types';
import { LruSet, setBoundedMap } from '@/utils/collections/lru';

export { LruSet, setBoundedMap };

export function extractOutputFilePathFromTaskResultText(text: string): string | null {
  const raw = String(text ?? '');
  const m = raw.match(/\boutput_file\s*[:=]\s*([^\s]+)/i);
  const value = m?.[1] ? String(m[1]).trim() : '';
  if (!value) return null;
  return value.replace(/^['"]|['"]$/g, '').trim() || null;
}

export function coerceToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';

  if (typeof content === 'object' && !Array.isArray(content)) {
    const record = content as any;
    const base = 'content' in record ? coerceToolResultText(record.content) : '';

    const toolUseResult = record.tool_use_result;
    if (toolUseResult && typeof toolUseResult === 'object' && !Array.isArray(toolUseResult)) {
      const extras: string[] = [];

      const agentIdRaw = (toolUseResult as any).agent_id ?? (toolUseResult as any).agentId ?? (toolUseResult as any).teammate_id;
      const agentId = typeof agentIdRaw === 'string' ? agentIdRaw.trim() : '';
      if (agentId && !/\bagent_id\b|\bagentId\b|\bteammate_id\b/i.test(base)) {
        extras.push(`agent_id: ${agentId}`);
      }

      const taskIdRaw = (toolUseResult as any).task_id ?? (toolUseResult as any).taskId;
      const taskId = typeof taskIdRaw === 'string' ? taskIdRaw.trim() : '';
      if (taskId && !/\btask_id\b|\btaskId\b/i.test(base)) {
        extras.push(`task_id: ${taskId}`);
      }

      const teamNameRaw = (toolUseResult as any).team_name ?? (toolUseResult as any).teamName;
      const teamName = typeof teamNameRaw === 'string' ? teamNameRaw.trim() : '';
      if (teamName && !/\bteam_name\b|\bteamName\b/i.test(base)) {
        extras.push(`team_name: ${teamName}`);
      }

      if (extras.length > 0) {
        return base ? `${base}\n${extras.join('\n')}` : extras.join('\n');
      }
    }

    return base;
  }

  // Some SDK surfaces return a content-block array (e.g. [{type:'text', text:'...'}]).
  // For Task/TaskOutput we only need best-effort text extraction.
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if ((item as any).type !== 'text') continue;
      const text = (item as any).text;
      if (typeof text === 'string' && text.trim().length > 0) {
        chunks.push(text);
      }
    }
    return chunks.join('\n');
  }

  return '';
}

export function isPromptRootUserMessage(record: RawJSONLines): boolean {
  if (record.type !== 'user') return false;
  if ((record as any).isSidechain !== true) return false;
  const msg = (record as any).message;
  if (!msg || typeof msg !== 'object') return false;
  if ((msg as any).role !== 'user') return false;
  return typeof (msg as any).content === 'string';
}

export function markRecordAsSidechain(record: RawJSONLines, sidechainId: string): RawJSONLines {
  (record as any).isSidechain = true;
  (record as any).sidechainId = sidechainId;
  return record;
}

export function markUuidSeenAndReturnIsDuplicate(params: {
  seenUuidsBySidechainId: Map<string, LruSet>;
  sidechainId: string;
  uuid: string;
  maxSeenUuidsPerSidechain: number;
  maxSidechains?: number;
}): boolean {
  const uuid = String(params.uuid ?? '').trim();
  if (!uuid) return false;

  const existing = params.seenUuidsBySidechainId.get(params.sidechainId) ?? null;
  const seen = existing ?? new LruSet(params.maxSeenUuidsPerSidechain);
  if (!existing) {
    if (typeof params.maxSidechains === 'number') {
      setBoundedMap(params.seenUuidsBySidechainId, params.sidechainId, seen, params.maxSidechains);
    } else {
      params.seenUuidsBySidechainId.set(params.sidechainId, seen);
    }
  } else if (typeof params.maxSidechains === 'number') {
    // refresh insertion order for bounded maps
    setBoundedMap(params.seenUuidsBySidechainId, params.sidechainId, existing, params.maxSidechains);
  }

  if (seen.has(uuid)) return true;
  seen.add(uuid);
  return false;
}
