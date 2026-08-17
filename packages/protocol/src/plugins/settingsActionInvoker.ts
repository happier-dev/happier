import type { JsonValue } from '../json/strictJsonValue.js';
import type {
  PluginSettingFieldIdV2,
  PluginSettingsActionDeclarationV2,
} from './contributions/settings.js';

const MAX_PATCH_FIELDS = 16;
const MAX_PATCH_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 32_768;

type SettingsSnapshot = Readonly<{
  values: Readonly<Record<string, JsonValue>>;
  revision: string;
}>;

function assertCurrent(
  signal: AbortSignal,
  isCurrent: () => boolean,
  createError: (code: string, message: string) => Error,
): void {
  if (signal.aborted || !isCurrent()) {
    throw createError(
      'plugin_settings_action_generation_retired',
      'Plugin settings action generation is no longer current',
    );
  }
}

function cloneCanonicalJson(
  value: unknown,
  createError: (code: string, message: string) => Error,
): JsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw createError('plugin_settings_action_patch_bounded', 'Plugin settings action patch exceeds structural limits');
    }
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') {
      if (Number.isFinite(candidate)) return candidate;
      throw createError('plugin_settings_action_result_invalid', 'Plugin settings action returned a non-JSON patch value');
    }
    if (typeof candidate !== 'object' || ancestors.has(candidate)) {
      throw createError('plugin_settings_action_result_invalid', 'Plugin settings action returned a non-JSON patch value');
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const ownKeys = Reflect.ownKeys(candidate);
        if (ownKeys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/u.test(key)))) {
          throw createError('plugin_settings_action_result_invalid', 'Plugin settings action returned a non-canonical JSON array');
        }
        const output: JsonValue[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw createError('plugin_settings_action_result_invalid', 'Plugin settings action returned a non-canonical JSON array');
          }
          output.push(visit(descriptor.value, depth + 1));
        }
        return output;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw createError('plugin_settings_action_result_invalid', 'Plugin settings action returned a non-canonical JSON object');
      }
      const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== 'string') {
          throw createError('plugin_settings_action_result_invalid', 'Plugin settings action returned a non-canonical JSON object');
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw createError('plugin_settings_action_result_invalid', 'Plugin settings action returned a non-canonical JSON object');
        }
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally {
      ancestors.delete(candidate);
    }
  };
  return visit(value, 0);
}

function plainDataProperty(
  owner: object,
  key: string,
  createError: (code: string, message: string) => Error,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw createError('plugin_settings_action_result_invalid', 'Plugin settings action returned an invalid patch result');
  }
  return descriptor.value;
}

function normalizePatch(
  declaration: PluginSettingsActionDeclarationV2,
  result: unknown,
  createError: (code: string, message: string) => Error,
): Readonly<Record<string, JsonValue>> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw createError('plugin_settings_action_result_invalid', 'Plugin settings action returned an invalid patch result');
  }
  const resultPrototype = Object.getPrototypeOf(result);
  if (resultPrototype !== Object.prototype && resultPrototype !== null) {
    throw createError('plugin_settings_action_result_invalid', 'Plugin settings action returned an invalid patch result');
  }
  const resultKeys = Reflect.ownKeys(result);
  if (resultKeys.length !== 1 || resultKeys[0] !== 'patch') {
    throw createError('plugin_settings_action_result_invalid', 'Plugin settings action returned an invalid patch result');
  }
  const patch = plainDataProperty(result, 'patch', createError);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw createError('plugin_settings_action_result_invalid', 'Plugin settings action returned an invalid patch result');
  }
  const patchPrototype = Object.getPrototypeOf(patch);
  if (patchPrototype !== Object.prototype && patchPrototype !== null) {
    throw createError('plugin_settings_action_result_invalid', 'Plugin settings action returned an invalid patch result');
  }
  const patchKeys = Reflect.ownKeys(patch);
  if (patchKeys.some((key) => typeof key !== 'string')) {
    throw createError('plugin_settings_action_result_invalid', 'Plugin settings action returned an invalid patch result');
  }
  const fieldIds = patchKeys as string[];
  if (fieldIds.length === 0 || fieldIds.length > MAX_PATCH_FIELDS) {
    throw createError('plugin_settings_action_patch_bounded', 'Plugin settings action patch exceeds the field limit');
  }
  const allowed = new Set(declaration.patchFieldIds);
  const normalized: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const fieldId of fieldIds) {
    if (!allowed.has(fieldId)) {
      throw createError(
        'plugin_settings_action_patch_field_forbidden',
        `Plugin settings action cannot patch undeclared field '${fieldId}'`,
      );
    }
    normalized[fieldId] = cloneCanonicalJson(plainDataProperty(patch, fieldId, createError), createError);
  }
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MAX_PATCH_BYTES) {
    throw createError('plugin_settings_action_patch_bounded', 'Plugin settings action patch exceeds the JSON byte limit');
  }
  return Object.freeze(normalized);
}

/** Host-only lifecycle coordinator. Persistence/schema authority stays in the host adapter. */
export function createHostPluginSettingsActionInvoker<Context = undefined, ApplyResult = unknown>(ports: Readonly<{
  createError(code: string, message: string): Error;
  confirm(input: Readonly<{
    declaration: PluginSettingsActionDeclarationV2;
    signal: AbortSignal;
    /** The stamped host invocation identity whose lifecycle owns this prompt. */
    context: Context | undefined;
  }>): boolean | Promise<boolean>;
  snapshot(input: Readonly<{ signal: AbortSignal; context: Context | undefined }>): SettingsSnapshot | Promise<SettingsSnapshot>;
  execute(
    input: Readonly<{
      actionId: string;
      settings: Readonly<Record<PluginSettingFieldIdV2, JsonValue>>;
    }>,
    context: Context,
    options: Readonly<{ signal: AbortSignal }>,
  ): Readonly<{ patch: Readonly<Record<PluginSettingFieldIdV2, JsonValue>> }> | Promise<Readonly<{
    patch: Readonly<Record<PluginSettingFieldIdV2, JsonValue>>;
  }>>;
  applyPatch(input: Readonly<{
    declaration: PluginSettingsActionDeclarationV2;
    snapshot: SettingsSnapshot;
    patch: Readonly<Record<string, JsonValue>>;
    signal: AbortSignal;
    context: Context | undefined;
  }>): ApplyResult | Promise<ApplyResult>;
}>) {
  const active = new Map<string, object>();
  return Object.freeze({
    async invoke(input: Readonly<{
      key: string;
      declaration: PluginSettingsActionDeclarationV2;
      userGesture: boolean;
      signal: AbortSignal;
      isCurrent(): boolean;
      context?: Context;
    }>): Promise<ApplyResult> {
      if (!input.userGesture) {
        throw ports.createError('plugin_settings_action_user_gesture_required', 'Plugin settings actions require an explicit user gesture');
      }
      if (active.has(input.key)) {
        throw ports.createError('plugin_settings_action_busy', 'This plugin settings action already has an invocation in flight');
      }
      const reservation = Object.freeze({});
      const retireReservation = () => {
        if (active.get(input.key) === reservation) active.delete(input.key);
      };
      active.set(input.key, reservation);
      input.signal.addEventListener('abort', retireReservation, { once: true });
      try {
        assertCurrent(input.signal, input.isCurrent, ports.createError);
        if (input.declaration.confirmation.kind === 'required') {
          const confirmed = await ports.confirm({
            declaration: input.declaration,
            signal: input.signal,
            context: input.context,
          });
          assertCurrent(input.signal, input.isCurrent, ports.createError);
          if (!confirmed) {
            throw ports.createError('plugin_settings_action_confirmation_declined', 'Plugin settings action confirmation was declined');
          }
        }
        const snapshot = await ports.snapshot({ signal: input.signal, context: input.context });
        assertCurrent(input.signal, input.isCurrent, ports.createError);
        const result = await ports.execute({
          actionId: input.declaration.id,
          settings: snapshot.values,
        }, input.context as Context, { signal: input.signal });
        assertCurrent(input.signal, input.isCurrent, ports.createError);
        const patch = normalizePatch(input.declaration, result, ports.createError);
        const applied = await ports.applyPatch({
          declaration: input.declaration,
          snapshot,
          patch,
          signal: input.signal,
          context: input.context,
        });
        assertCurrent(input.signal, input.isCurrent, ports.createError);
        return applied;
      } finally {
        input.signal.removeEventListener('abort', retireReservation);
        retireReservation();
      }
    },
  });
}
