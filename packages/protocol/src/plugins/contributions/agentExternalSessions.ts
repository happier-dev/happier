import { z } from 'zod';

export const MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES = 64 * 1024;
export const MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_DEPTH = 8;
export const MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_ENTRIES = 256;

export interface PluginAgentExternalSessionLinkDataArray
  extends ReadonlyArray<PluginAgentExternalSessionLinkDataValue> {}
export interface PluginAgentExternalSessionLinkDataObject {
  readonly [key: string]: PluginAgentExternalSessionLinkDataValue;
}
export type PluginAgentExternalSessionLinkDataValue =
  | null
  | boolean
  | number
  | string
  | PluginAgentExternalSessionLinkDataArray
  | PluginAgentExternalSessionLinkDataObject;

export type PluginAgentExternalSessionLinkData = PluginAgentExternalSessionLinkDataObject;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const INVALID_LINK_DATA = Symbol('invalid-link-data');

function snapshotBoundedJsonValue(
  value: unknown,
  depth: number,
  path: PropertyKey[],
  state: { entries: number },
  ctx: z.RefinementCtx,
): PluginAgentExternalSessionLinkDataValue | typeof INVALID_LINK_DATA {
  if (depth > MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_DEPTH) {
    ctx.addIssue({ code: 'custom', path, message: 'External-session linkData is too deeply nested.' });
    return INVALID_LINK_DATA;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    ctx.addIssue({ code: 'custom', path, message: 'External-session linkData numbers must be finite.' });
    return INVALID_LINK_DATA;
  }
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    const expectedKeys = new Set<PropertyKey>(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
    if (ownKeys.length !== expectedKeys.size || ownKeys.some((key) => !expectedKeys.has(key))) {
      ctx.addIssue({ code: 'custom', path, message: 'External-session linkData arrays cannot carry extra or sparse fields.' });
      return INVALID_LINK_DATA;
    }
    state.entries += value.length;
    if (state.entries > MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_ENTRIES) {
      ctx.addIssue({ code: 'custom', message: 'External-session linkData has too many entries.' });
      return INVALID_LINK_DATA;
    }
    const snapshot: PluginAgentExternalSessionLinkDataValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        ctx.addIssue({ code: 'custom', path: [...path, index], message: 'External-session linkData fields must be enumerable data properties.' });
        return INVALID_LINK_DATA;
      }
      const item = snapshotBoundedJsonValue(descriptor.value, depth + 1, [...path, index], state, ctx);
      if (item === INVALID_LINK_DATA) return INVALID_LINK_DATA;
      snapshot.push(item);
    }
    return Object.freeze(snapshot);
  }
  if (!isPlainObject(value)) {
    ctx.addIssue({ code: 'custom', path, message: 'External-session linkData must contain only JSON values.' });
    return INVALID_LINK_DATA;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    ctx.addIssue({ code: 'custom', path, message: 'External-session linkData keys must be strings.' });
    return INVALID_LINK_DATA;
  }
  state.entries += keys.length;
  if (state.entries > MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_ENTRIES) {
    ctx.addIssue({ code: 'custom', message: 'External-session linkData has too many entries.' });
    return INVALID_LINK_DATA;
  }
  const snapshot: Record<string, PluginAgentExternalSessionLinkDataValue> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      ctx.addIssue({ code: 'custom', path: [...path, key], message: 'External-session linkData fields must be enumerable data properties.' });
      return INVALID_LINK_DATA;
    }
    const item = snapshotBoundedJsonValue(descriptor.value, depth + 1, [...path, key], state, ctx);
    if (item === INVALID_LINK_DATA) return INVALID_LINK_DATA;
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: item,
    });
  }
  return Object.freeze(snapshot);
}

export const PluginAgentExternalSessionLinkDataSchema: z.ZodType<PluginAgentExternalSessionLinkData> = z
  .unknown()
  .transform((value, ctx) => {
    if (!isPlainObject(value)) {
      ctx.addIssue({ code: 'custom', message: 'External-session linkData must be a JSON object.' });
      return z.NEVER;
    }
    const snapshot = snapshotBoundedJsonValue(value, 0, [], { entries: 0 }, ctx);
    if (snapshot === INVALID_LINK_DATA || Array.isArray(snapshot) || !isPlainObject(snapshot)) return z.NEVER;
    const serializedBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    if (serializedBytes > MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'External-session linkData exceeds the serialized-byte limit.' });
      return z.NEVER;
    }
    return snapshot;
  }) as z.ZodType<PluginAgentExternalSessionLinkData>;
