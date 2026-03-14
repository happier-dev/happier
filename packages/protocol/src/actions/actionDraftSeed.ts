import { z } from 'zod';

import { buildBackendTargetKey, isBuiltInAgentTarget, type BackendTargetRefV1 } from '../backendTargets/backendTargetRef.js';
import type { ActionInputFieldHint, ActionSpec } from './actionSpecs.js';

function setByPath(obj: Record<string, any>, path: string, value: unknown): void {
  const parts = String(path ?? '')
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return;

  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    const next = cur[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cur[key] = {};
    }
    cur = cur[key];
  }
  cur[parts[parts.length - 1]!] = value;
}

function getByPath(obj: Record<string, any>, path: string): unknown {
  const parts = String(path ?? '')
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;

  let cur: unknown = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !(part in cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function splitPath(path: string): string[] {
  return String(path ?? '')
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
}

function cloneSeedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => cloneSeedValue(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneSeedValue(entry)]),
  );
}

function unwrapSeedSchema(
  schema: z.ZodTypeAny,
): Readonly<{ schema: z.ZodTypeAny; optional: boolean; nullable: boolean }> {
  let current = schema;
  let optional = false;
  let nullable = false;

  for (;;) {
    if (current instanceof z.ZodOptional) {
      optional = true;
      current = (current as any)._def.innerType;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      optional = true;
      current = (current as any)._def.innerType;
      continue;
    }
    if (current instanceof z.ZodNullable) {
      nullable = true;
      current = (current as any)._def.innerType;
      continue;
    }
    if (current instanceof z.ZodPipe) {
      current = (current as any)._def.in;
      continue;
    }
    break;
  }

  return { schema: current, optional, nullable };
}

function readDefaultValueAtPath(value: unknown, pathParts: readonly string[]): unknown {
  if (pathParts.length === 0) return value;

  let current: unknown = value;
  for (const part of pathParts) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function readSchemaSeedDefaultAtPath(
  schema: z.ZodTypeAny,
  path: string,
): Readonly<{ hasDefault: boolean; value: unknown }> {
  const pathParts = splitPath(path);
  const parsed = schema.safeParse(undefined);
  if (parsed.success && parsed.data !== undefined) {
    const value = readDefaultValueAtPath(parsed.data, pathParts);
    if (value !== undefined || pathParts.length === 0) {
      return { hasDefault: true, value };
    }
  }

  if (pathParts.length === 0) {
    return { hasDefault: false, value: undefined };
  }

  const unwrapped = unwrapSeedSchema(schema);
  if (unwrapped.optional || unwrapped.nullable) {
    return { hasDefault: false, value: undefined };
  }

  if (unwrapped.schema instanceof z.ZodObject) {
    const shape = (unwrapped.schema as any).shape ?? (unwrapped.schema as any)._def?.shape ?? {};
    const [head, ...rest] = pathParts;
    const childSchema = (shape as Record<string, z.ZodTypeAny>)[head];
    if (childSchema) {
      return readSchemaSeedDefaultAtPath(childSchema, rest.join('.'));
    }
  }

  return { hasDefault: false, value: undefined };
}

function getFieldHints(spec: ActionSpec): readonly ActionInputFieldHint[] {
  return Array.isArray(spec.inputHints?.fields) ? spec.inputHints!.fields : [];
}

function findPrimaryBackendSelectionField(hints: readonly ActionInputFieldHint[]): ActionInputFieldHint | null {
  // Convention: first multiselect field with an options source represents backend/engine selection.
  for (const hint of hints) {
    if (hint.widget !== 'multiselect') continue;
    if (typeof (hint as any).optionsSourceId === 'string' && String((hint as any).optionsSourceId).trim().length > 0) {
      return hint;
    }
  }
  return null;
}

function findInstructionsField(hints: readonly ActionInputFieldHint[]): ActionInputFieldHint | null {
  for (const hint of hints) {
    if (hint.path === 'instructions') return hint;
  }
  for (const hint of hints) {
    if (hint.widget === 'textarea') return hint;
  }
  return null;
}

function buildPrimarySelectionSeedValue(
  fieldPath: string,
  params: Readonly<{
    defaultBackendTarget?: BackendTargetRefV1 | null;
    defaultBackendId?: string | null;
  }>,
): readonly string[] {
  const path = String(fieldPath ?? '').trim();
  if (path === 'backendTargetKeys' || path.endsWith('.backendTargetKeys')) {
    if (params.defaultBackendTarget) {
      return [buildBackendTargetKey(params.defaultBackendTarget)];
    }
    const backendId = String(params.defaultBackendId ?? '').trim();
    return backendId ? [`agent:${backendId}`] : [];
  }
  const backendId = String(params.defaultBackendId ?? '').trim();
  if (backendId) return [backendId];
  if (params.defaultBackendTarget && isBuiltInAgentTarget(params.defaultBackendTarget)) {
    return [params.defaultBackendTarget.agentId];
  }
  return [];
}

export function buildActionDraftSeedInput(
  spec: ActionSpec,
  ctx: Readonly<{
    defaultBackendTarget?: BackendTargetRefV1 | null;
    defaultBackendId?: string | null;
    instructions?: string | null;
  }>,
): Record<string, unknown> {
  const hints = getFieldHints(spec);
  const seed: Record<string, any> = {};

  const backendField = findPrimaryBackendSelectionField(hints);
  if (backendField?.path && backendField.requireExplicitSelection !== true) {
    const selectionSeed = buildPrimarySelectionSeedValue(backendField.path, ctx);
    if (selectionSeed.length > 0) {
      setByPath(seed, backendField.path, selectionSeed);
    }
  }

  const instructions = ctx.instructions === null || ctx.instructions === undefined ? null : String(ctx.instructions);
  if (instructions !== null) {
    const instructionsField = findInstructionsField(hints);
    if (instructionsField?.path) {
      setByPath(seed, instructionsField.path, instructions);
    }
  }

  for (const hint of hints) {
    if (getByPath(seed, hint.path) !== undefined) continue;
    const fieldDefault = readSchemaSeedDefaultAtPath(spec.inputSchema, hint.path);
    if (!fieldDefault.hasDefault) continue;
    setByPath(seed, hint.path, cloneSeedValue(fieldDefault.value));
  }

  // Seed required selects with their first option. This keeps draft UIs usable even when the user
  // starts via a chip and the underlying input schema requires a value.
  for (const hint of hints) {
    if (hint.widget !== 'select') continue;
    if (hint.required !== true) continue;
    if (getByPath(seed, hint.path) !== undefined) continue;
    const options = Array.isArray((hint as any).options) ? ((hint as any).options as Array<{ value: unknown }>) : [];
    if (options.length === 0) continue;
    setByPath(seed, hint.path, options[0]!.value);
  }

  return seed;
}
