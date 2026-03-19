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
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : trimmed;
}

function safePathSegments(path: string): string[] {
    return path.trim().split(/[\\/]+/).filter(Boolean);
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

export function buildSafeWorkspaceLabels(params: Readonly<{ machineLabel: string; paths: ReadonlyArray<string> }>): Map<string, string> {
    const machine = normalizeId(params.machineLabel) || 'machine';
    const uniquePaths = Array.from(new Set(params.paths.map((path) => path.trim()).filter(Boolean)));
    const pathSegments = new Map<string, string[]>(uniquePaths.map((path) => [path, safePathSegments(path)]));
    const depths = new Map<string, number>(uniquePaths.map((path) => [path, 1]));

    let changed = true;
    while (changed) {
        changed = false;
        const grouped = new Map<string, string[]>();

        for (const path of uniquePaths) {
            const segments = pathSegments.get(path) ?? [];
            const depth = Math.min(depths.get(path) ?? 1, Math.max(segments.length, 1));
            const tail = segments.length > 0 ? segments.slice(-depth).join('/') : 'workspace';
            const label = `${tail} — ${machine}`;
            const group = grouped.get(label) ?? [];
            group.push(path);
            grouped.set(label, group);
        }

        for (const group of grouped.values()) {
            if (group.length <= 1) continue;
            for (const path of group) {
                const segments = pathSegments.get(path) ?? [];
                const currentDepth = depths.get(path) ?? 1;
                if (currentDepth < segments.length) {
                    depths.set(path, currentDepth + 1);
                    changed = true;
                }
            }
        }
    }

    return new Map(
        uniquePaths.map((path) => {
            const segments = pathSegments.get(path) ?? [];
            const depth = Math.min(depths.get(path) ?? 1, Math.max(segments.length, 1));
            const tail = segments.length > 0 ? segments.slice(-depth).join('/') : 'workspace';
            return [path, `${tail} — ${machine}`] as const;
        }),
    );
}
