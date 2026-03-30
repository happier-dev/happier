import { z } from 'zod';

import { CODEX_BACKEND_MODES, type CodexBackendMode } from '../providers/codex/backendMode.js';

/**
 * Session metadata override payloads (V1).
 *
 * These are stored inside encrypted `session.metadata` and are shared across UI/CLI.
 * Keep schemas permissive (passthrough) for forward compatibility.
 *
 * NOTE: Use the `create*Schema` factory forms for repos that may have multiple Zod
 * instances (nohoist); callers should pass their local `z` import.
 */

export function createModelOverrideV1Schema(zod: typeof z) {
  return zod
    .object({
      v: zod.literal(1),
      updatedAt: zod.number().finite(),
      // Cleared overrides are represented as `null` (see computeNextMetadataStringOverrideV1).
      modelId: zod.string().nullable(),
    })
    .passthrough();
}

export const ModelOverrideV1Schema = createModelOverrideV1Schema(z);
export type ModelOverrideV1 = z.infer<typeof ModelOverrideV1Schema>;

export function buildModelOverrideV1(params: Readonly<{ updatedAt: number; modelId: string }>): ModelOverrideV1 {
  return {
    v: 1,
    updatedAt: params.updatedAt,
    modelId: params.modelId,
  };
}

export function createAcpSessionModeOverrideV1Schema(zod: typeof z) {
  return zod
    .object({
      v: zod.literal(1),
      updatedAt: zod.number().finite(),
      // Cleared overrides are represented as `null` (see computeNextMetadataStringOverrideV1).
      modeId: zod.string().nullable(),
    })
    .passthrough();
}

export const AcpSessionModeOverrideV1Schema = createAcpSessionModeOverrideV1Schema(z);
export type AcpSessionModeOverrideV1 = z.infer<typeof AcpSessionModeOverrideV1Schema>;

export function buildAcpSessionModeOverrideV1(params: Readonly<{ updatedAt: number; modeId: string }>): AcpSessionModeOverrideV1 {
  return {
    v: 1,
    updatedAt: params.updatedAt,
    modeId: params.modeId,
  };
}

export function createAcpConfigOptionOverridesV1Schema(zod: typeof z) {
  const valueSchema = zod.union([zod.string(), zod.number(), zod.boolean(), zod.null()]);
  return zod
    .object({
      v: zod.literal(1),
      updatedAt: zod.number().finite(),
      overrides: zod.record(
        zod.string(),
        zod
          .object({
            updatedAt: zod.number().finite(),
            value: valueSchema,
          })
          .passthrough(),
      ),
    })
    .passthrough();
}

export const AcpConfigOptionOverridesV1Schema = createAcpConfigOptionOverridesV1Schema(z);
export type AcpConfigOptionOverridesV1 = z.infer<typeof AcpConfigOptionOverridesV1Schema>;

export function buildAcpConfigOptionOverridesV1(params: Readonly<{
  updatedAt: number;
  overrides: Record<string, { updatedAt: number; value: string | number | boolean | null }>;
}>): AcpConfigOptionOverridesV1 {
  return {
    v: 1,
    updatedAt: params.updatedAt,
    overrides: params.overrides,
  };
}

export function createCodexRuntimeDescriptorV1Schema(zod: typeof z) {
  return zod
    .object({
      v: zod.literal(1),
      backendMode: zod.enum(CODEX_BACKEND_MODES),
    })
    .passthrough();
}

export const CodexRuntimeDescriptorV1Schema = createCodexRuntimeDescriptorV1Schema(z);
export type CodexRuntimeDescriptorV1 = z.infer<typeof CodexRuntimeDescriptorV1Schema>;

export function buildCodexRuntimeDescriptorV1(params: Readonly<{
  backendMode: CodexBackendMode;
}>): CodexRuntimeDescriptorV1 {
  return {
    v: 1,
    backendMode: params.backendMode,
  };
}

export function readCodexRuntimeDescriptorV1BackendMode(value: unknown): CodexBackendMode | null {
  const parsed = CodexRuntimeDescriptorV1Schema.safeParse(value);
  return parsed.success ? parsed.data.backendMode : null;
}
