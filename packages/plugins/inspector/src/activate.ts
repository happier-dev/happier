import type { PluginApi, PluginHookPayloadMapV1 } from '@happier-dev/plugin-sdk';

export type InspectorReloadStateSnapshot = Readonly<{
  lastReload: null | Readonly<{
    generation: number | null;
    attemptedGeneration: number | null;
    activeGenerationId: string | null;
    registryStatus: string | null;
    affectedPluginIds: readonly string[];
    changedPluginIds: readonly string[];
  }>;
}>;

let lastReload: InspectorReloadStateSnapshot['lastReload'] = null;

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readStringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? Object.freeze(value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0))
    : Object.freeze([]);
}

export function handlePluginReloadAfter(payload: PluginHookPayloadMapV1['plugin.reload.after']): void {
  lastReload = Object.freeze({
    generation: readNumber(payload.generation),
    attemptedGeneration: readNumber(payload.attemptedGeneration),
    activeGenerationId: readString(payload.activeGenerationId),
    registryStatus: readString(payload.registryStatus),
    affectedPluginIds: readStringList(payload.affectedPluginIds).length > 0
      ? readStringList(payload.affectedPluginIds)
      : Object.freeze([payload.pluginId]),
    changedPluginIds: readStringList(payload.changedPluginIds).length > 0
      ? readStringList(payload.changedPluginIds)
      : payload.success ? Object.freeze([payload.pluginId]) : Object.freeze([]),
  });
}

export function readInspectorRuntimeStateSnapshot(): InspectorReloadStateSnapshot {
  return Object.freeze({
    lastReload,
  });
}

export function resetInspectorRuntimeStateForTest(): void {
  lastReload = null;
}

export function activate(api: PluginApi): void {
  api.registerHook({
    hookId: 'plugin.reload.after',
    handler: handlePluginReloadAfter,
  });
}
