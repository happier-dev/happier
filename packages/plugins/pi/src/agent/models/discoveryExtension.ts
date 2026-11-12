import { redactBugReportSensitiveText } from '@happier-dev/plugin-sdk';

const PI_MODEL_DISCOVERY_MARKER = 'happier-pi-model-catalog';

/** Run in Pi so its registry remains the owner of catalogs, auth, extensions and cache policy. */
export function buildPiModelDiscoveryExtensionSource(params: Readonly<{
  bypassCache?: boolean;
  background?: boolean;
  output?: 'stdout' | 'stderr';
}>): string {
  return `
export default function happierModelDiscovery(pi) {
  let generation = 0;
  const emit = (publication, result) => publication === generation && process.${params.output ?? 'stderr'}.write(JSON.stringify({type:${JSON.stringify(PI_MODEL_DISCOVERY_MARKER)}, ...result}) + "\\n");
  const failureMessage = (error, phase) => {
    const details = error && typeof error === "object" ? error : {};
    const nativePhase = typeof details.phase === "string" ? details.phase : phase;
    const code = typeof details.code === "string" || typeof details.code === "number" ? String(details.code) : undefined;
    const message = typeof error === "string" ? error : typeof details.message === "string" ? details.message : "Pi model catalog refresh failed";
    return [nativePhase, code].filter(Boolean).join("/") + ": " + message;
  };
  const discover = async (ctx, publication) => {
    let phase = "model_list";
    try {
      const offline = process.env.PI_OFFLINE;
      if (offline === "1" || offline?.toLowerCase() === "true" || offline?.toLowerCase() === "yes") {
        emit(publication, {error:"offline", refreshErrorMessage:failureMessage("Pi model registry is offline (PI_OFFLINE)", "catalog_refresh")}); return;
      }
      const registry = ctx.modelRegistry;
      const providers = [...new Set(registry.getAll()
        .filter(model => registry.hasConfiguredAuth(model))
        .map(model => model.provider))];
      phase = "catalog_refresh";
      const result = await registry.refresh({providers, allowNetwork:true, force:${params.bypassCache === true}});
      if (result?.errors instanceof Map && result.errors.size > 0) {
        emit(publication, {error:"refresh-failed", refreshErrorMessage:[...result.errors.values()]
          .map(error => failureMessage(error, phase)).join("; ")}); return;
      }
      const registryError = registry.getError();
      if (registryError) {
        emit(publication, {error:"refresh-failed", refreshErrorMessage:failureMessage(registryError, phase)}); return;
      }
      phase = "model_list";
      const readModels = () => registry.getAvailable().map(model => ({
        id:model.id, provider:model.provider, name:model.name, reasoning:model.reasoning,
      }));
      // Older Pi registries reload local files without a refresh receipt. They cannot
      // establish network freshness; never label their snapshot as a fresh observation.
      if (!result || typeof result.aborted !== "boolean" || !(result.errors instanceof Map)) {
        emit(publication, {error:"refresh-unsupported", models:readModels(),
          refreshErrorMessage:failureMessage("Pi model registry returned a refresh-unsupported result", "catalog_refresh")}); return;
      }
      if (result.aborted) {
        emit(publication, {error:"refresh-failed", refreshErrorMessage:failureMessage("Pi model catalog refresh was aborted", "catalog_refresh")}); return;
      }
      emit(publication, {models:readModels()});
    } catch (error) { emit(publication, {error:"refresh-failed", refreshErrorMessage:failureMessage(error, phase)}); }
  };
  pi.on("session_start", (_event, ctx) => {
    const publication = ++generation;
    ${params.background ? 'void discover(ctx, publication);' : 'return discover(ctx, publication);'}
  });
}
`;
}

export function parsePiModelDiscoveryLine(line: string): ReturnType<typeof parsePiModelDiscoveryRecord> {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  return parsePiModelDiscoveryRecord(value);
}

export function parsePiModelDiscoveryRecord(value: unknown): { models: unknown[] } | { error: string; models?: unknown[]; refreshErrorMessage?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== PI_MODEL_DISCOVERY_MARKER) return null;
  if (typeof record.error === 'string') return {
    error: record.error,
    ...(typeof record.refreshErrorMessage === 'string'
      ? { refreshErrorMessage: redactBugReportSensitiveText(record.refreshErrorMessage) } : {}),
    ...(record.error === 'refresh-unsupported' && Array.isArray(record.models) ? { models: record.models } : {}),
  };
  return Array.isArray(record.models) ? { models: record.models } : { error: 'invalid-catalog' };
}
