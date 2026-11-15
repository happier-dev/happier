import { materializeProtectedTempTextArtifact } from '@/utils/fs/protectedTempTextArtifact';

import { PI_SHARED_CONTROL_SIDE_CHANNEL_EVENT } from '../sharedControl/piSharedControlProtocol';

const PI_MODEL_DISCOVERY_MARKER = 'happier-pi-model-catalog';

/**
 * Run in Pi so its registry remains the owner of catalogs, auth, extensions and cache policy.
 * The marker goes to stderr, which the RPC backend and the JSON-mode preflight probe read. In the
 * native TUI the terminal belongs to Pi, so it goes over Pi's extension bus to the Happier bridge.
 */
export function buildPiModelDiscoveryExtensionSource(params: Readonly<{
  bypassCache?: boolean;
  background?: boolean;
}>): string {
  return `
export default function happierModelDiscovery(pi) {
  let generation = 0;
  let publish = (line) => process.stderr.write(line + "\\n");
  const emit = (publication, result) => publication === generation && publish(JSON.stringify({type:${JSON.stringify(PI_MODEL_DISCOVERY_MARKER)}, ...result}));
  const discover = async (ctx, publication) => {
    try {
      const offline = process.env.PI_OFFLINE;
      if (offline === "1" || offline?.toLowerCase() === "true" || offline?.toLowerCase() === "yes") {
        emit(publication, {error:"offline"}); return;
      }
      const registry = ctx.modelRegistry;
      const providers = [...new Set(registry.getAll()
        .filter(model => registry.hasConfiguredAuth(model))
        .map(model => model.provider))];
      const result = await registry.refresh({providers, allowNetwork:true, force:${params.bypassCache === true}});
      if (registry.getError()) { emit(publication, {error:"refresh-failed"}); return; }
      const readModels = () => registry.getAvailable().map(model => ({
        id:model.id, provider:model.provider, name:model.name, reasoning:model.reasoning,
      }));
      // Older Pi registries reload local files without a refresh receipt. They cannot
      // establish network freshness; never label their snapshot as a fresh observation.
      if (!result || typeof result.aborted !== "boolean" || !(result.errors instanceof Map)) {
        emit(publication, {error:"refresh-unsupported", models:readModels()}); return;
      }
      if (result.aborted || result.errors.size > 0) {
        emit(publication, {error:"refresh-failed"}); return;
      }
      emit(publication, {models:readModels()});
    } catch { emit(publication, {error:"refresh-failed"}); }
  };
  pi.on("session_start", (_event, ctx) => {
    if (ctx?.mode === "tui") publish = (line) => pi.events.emit(${JSON.stringify(PI_SHARED_CONTROL_SIDE_CHANNEL_EVENT)}, line);
    const publication = ++generation;
    ${params.background ? 'void discover(ctx, publication);' : 'return discover(ctx, publication);'}
  });
}
`;
}

export async function materializePiModelDiscoveryExtension(params: Readonly<{
  bypassCache?: boolean;
  background?: boolean;
}>): Promise<Readonly<{ path: string; cleanup: () => Promise<void> }>> {
  return await materializeProtectedTempTextArtifact({
    prefix: 'happier-pi-model-discovery-',
    filename: 'discovery.mjs',
    contents: buildPiModelDiscoveryExtensionSource(params),
  });
}

export function parsePiModelDiscoveryLine(line: string): { models: unknown[] } | { error: string; models?: unknown[] } | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== PI_MODEL_DISCOVERY_MARKER) return null;
  if (typeof record.error === 'string') return {
    error: record.error,
    ...(record.error === 'refresh-unsupported' && Array.isArray(record.models) ? { models: record.models } : {}),
  };
  return Array.isArray(record.models) ? { models: record.models } : { error: 'invalid-catalog' };
}
