import type { AgentRequestKind } from '../../agent/permissions/requestKind';

function firstString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function firstStringFromUnknown(value: unknown): string | null {
  const direct = firstString(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = firstString(item);
      if (s) return s;
    }
  }
  return null;
}

function shortPath(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

function commandName(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  const first = value.split(/\s+/).filter(Boolean)[0] ?? '';
  return first;
}

export function summarizeToolInputForNotification(toolName: string, toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const rec = toolInput as Record<string, unknown>;

  const path =
    firstString(rec.file_path) ??
    firstString(rec.filePath) ??
    firstString(rec.path) ??
    firstString(rec.filename) ??
    firstString(rec.fileName);
  if (path) return `File: ${shortPath(path)}`;

  const command =
    firstStringFromUnknown(rec.command) ??
    firstStringFromUnknown(rec.cmd) ??
    firstStringFromUnknown(rec.script);
  if (command) {
    const name = commandName(command);
    return name ? `Command: ${name}` : null;
  }

  const questions = rec.questions;
  if (Array.isArray(questions)) {
    const count = questions.length;
    if (count === 1) return '1 question';
    if (count > 1) return `${count} questions`;
  }

  const normalized = typeof toolName === 'string' ? toolName.trim() : '';
  if (normalized === 'Read' || normalized === 'Write' || normalized === 'Edit' || normalized === 'Bash') {
    return null;
  }
  return null;
}

export function buildAgentRequestNotificationContent(params: Readonly<{
  kind: AgentRequestKind;
  sessionId: string;
  requestId: string;
  toolName: string;
  toolDetails?: string | null;
}>): Readonly<{ title: string; body: string; data: Record<string, unknown> }> {
  const type = params.kind === 'user_action' ? 'user_action_request' : 'permission_request';
  const title = params.kind === 'user_action' ? 'Action Required' : 'Permission Request';
  const details = typeof params.toolDetails === 'string' && params.toolDetails.trim() ? params.toolDetails.trim() : null;
  const body = params.kind === 'user_action'
    ? details
      ? `Input needed for: ${params.toolName}\n${details}`
      : `Input needed for: ${params.toolName}`
    : details
      ? `Approval needed for: ${params.toolName}\n${details}`
      : `Approval needed for: ${params.toolName}`;

  return {
    title,
    body,
    data: {
      sessionId: params.sessionId,
      requestId: params.requestId,
      tool: params.toolName,
      type,
      kind: params.kind,
    },
  };
}
