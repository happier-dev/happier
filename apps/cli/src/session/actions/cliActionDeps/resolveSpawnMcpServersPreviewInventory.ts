import type { McpServersSettingsV1, SessionMcpSelectionV1 } from '@happier-dev/protocol';

type McpPreviewOptionItem = Readonly<{
  value: string;
  label: string;
  selected?: boolean;
  selectable?: boolean;
  sourceKind?: string;
  authMode?: string;
  availability?: string;
}>;

function normalizeLimit(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? Math.min(normalized, 200) : null;
}

function limitItems<T>(items: readonly T[], limit: unknown): readonly T[] {
  const bounded = normalizeLimit(limit);
  return bounded ? items.slice(0, bounded) : items;
}

export async function resolveSpawnMcpServersPreviewInventory(params: Readonly<{
  settings: McpServersSettingsV1;
  machineId: string;
  directory: string;
  agentId: string;
  selection?: SessionMcpSelectionV1;
  limit?: number;
}>): Promise<Readonly<{
  ok: boolean;
  items: readonly McpPreviewOptionItem[];
  preview: unknown;
}>> {
  const { detectProviderMcpServers } = await import('@/mcp/providerDetection/detectProviderMcpServers');
  const { resolveSessionMcpPreview } = await import('@/mcp/preview/resolveSessionMcpPreview');
  const detected = await detectProviderMcpServers({
    directory: params.directory,
    providers: params.agentId ? [params.agentId] : null,
  });
  const preview = resolveSessionMcpPreview({
    settings: params.settings,
    machineId: params.machineId,
    directory: params.directory,
    agentId: params.agentId,
    ...(params.selection ? { selection: params.selection } : {}),
    detectedServers: detected.servers,
    detectedWarnings: detected.warnings,
  });
  const items = preview.ok
    ? [
        ...preview.builtIn,
        ...preview.managed,
        ...preview.detected,
      ].map((entry): McpPreviewOptionItem => ({
        value: entry.key,
        label: entry.title ?? entry.name ?? entry.key,
        selected: entry.selected,
        selectable: entry.selectable,
        sourceKind: entry.sourceKind,
        authMode: entry.authMode,
        availability: entry.availability,
      }))
    : [];

  return {
    ok: preview.ok,
    items: limitItems(items, params.limit),
    preview,
  };
}
