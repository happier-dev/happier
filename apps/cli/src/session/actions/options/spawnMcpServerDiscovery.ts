import {
  type DaemonMcpServersPreviewResponse,
  type SessionMcpSelectionV1,
  type AccountSettings,
} from '@happier-dev/protocol';
import { resolveAgentIdFromFlavor } from '@happier-dev/agents';

import { detectProviderMcpServers } from '@/mcp/providerDetection/detectProviderMcpServers';
import { resolveSessionMcpPreview } from '@/mcp/preview/resolveSessionMcpPreview';
import { readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';

import { normalizeActionOptionLimit, normalizeActionOptionString } from './actionOptionInputNormalization';

type PreviewEntry = Extract<DaemonMcpServersPreviewResponse, { ok: true }>['builtIn'][number]
  | Extract<DaemonMcpServersPreviewResponse, { ok: true }>['managed'][number]
  | Extract<DaemonMcpServersPreviewResponse, { ok: true }>['detected'][number];

function buildPreviewOptionItems(params: Readonly<{
  preview: Extract<DaemonMcpServersPreviewResponse, { ok: true }>;
  limit?: unknown;
}>): readonly Readonly<{
  value: string;
  label: string;
  key: string;
  selected: boolean;
  selectable: boolean;
  availability: PreviewEntry['availability'];
  sourceKind: PreviewEntry['sourceKind'];
  scopeKind: PreviewEntry['scopeKind'];
  acpDelivery?: Extract<PreviewEntry, { sourceKind: 'managed' }>['acpDelivery'];
  disabled?: true;
}>[] {
  const entries: PreviewEntry[] = [
    ...params.preview.builtIn,
    ...params.preview.managed,
    ...params.preview.detected,
  ];
  const items = entries.map((entry) => ({
    value: entry.key,
    label: entry.title ?? entry.name,
    key: entry.key,
    selected: entry.selected,
    selectable: entry.selectable,
    availability: entry.availability,
    sourceKind: entry.sourceKind,
    scopeKind: entry.scopeKind,
    ...(entry.sourceKind === 'managed' && entry.acpDelivery ? { acpDelivery: entry.acpDelivery } : {}),
    ...(entry.availability === 'unavailable' ? { disabled: true as const } : {}),
  }));
  const limit = normalizeActionOptionLimit(params.limit);
  return limit ? items.slice(0, limit) : items;
}

export async function previewSpawnMcpServers(params: Readonly<{
  accountSettings: AccountSettings | Readonly<Record<string, unknown>>;
  machineId: string;
  directory: string;
  agentId?: string | null;
  selection?: SessionMcpSelectionV1 | null;
  limit?: unknown;
  env?: NodeJS.ProcessEnv;
}>): Promise<DaemonMcpServersPreviewResponse & Readonly<{ items?: readonly unknown[] }>> {
  const machineId = normalizeActionOptionString(params.machineId);
  const directory = normalizeActionOptionString(params.directory);
  if (!machineId || !directory) {
    return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
  }

  const agentId = resolveAgentIdFromFlavor(params.agentId) ?? 'claude';
  const detected = await detectProviderMcpServers({
    directory,
    providers: undefined,
    env: params.env ?? process.env,
  });
  const preview = resolveSessionMcpPreview({
    settings: readMcpServersSettingsFromAccountSettings(params.accountSettings),
    machineId,
    directory,
    agentId,
    selection: params.selection ?? null,
    detectedServers: detected.servers,
    detectedWarnings: detected.warnings,
  });

  return {
    ...preview,
    items: buildPreviewOptionItems({ preview, limit: params.limit }),
  };
}
