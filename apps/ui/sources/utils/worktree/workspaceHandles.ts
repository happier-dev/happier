import { digest } from '@/platform/digest';
import { encodeBase64 } from '@/encryption/base64';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function normalizePath(raw: unknown): string {
  const path = String(raw ?? '').trim();
  return path;
}

function safeBasename(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '';
  const parts = trimmed.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : trimmed;
}

export type WorkspaceHandle = Readonly<{
  workspaceId: string;
  machineId: string;
  path: string;
}>;

export async function createWorkspaceId(params: Readonly<{ machineId: string; path: string }>): Promise<string> {
  const machineId = normalizeId(params.machineId);
  const path = normalizePath(params.path);
  if (!machineId || !path) return '';
  const input = `${machineId}\n${path}`;
  const bytes = new TextEncoder().encode(input);
  const hash = await digest('SHA-256', bytes);
  const b64 = encodeBase64(hash, 'base64url');
  return `ws_${b64}`;
}

export async function createWorkspaceHandle(params: Readonly<{ machineId: string; path: string }>): Promise<WorkspaceHandle | null> {
  const machineId = normalizeId(params.machineId);
  const path = normalizePath(params.path);
  if (!machineId || !path) return null;
  const workspaceId = await createWorkspaceId({ machineId, path });
  if (!workspaceId) return null;
  return { workspaceId, machineId, path };
}

export function buildSafeWorkspaceLabel(params: Readonly<{ machineLabel: string; path: string }>): string {
  const machine = normalizeId(params.machineLabel) || 'machine';
  const base = safeBasename(params.path) || 'workspace';
  return `${base} — ${machine}`;
}

