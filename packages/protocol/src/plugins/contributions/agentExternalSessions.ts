import { z } from '../../zodRuntimePolicy.js';

import {
  cloneStrictPluginJsonValue,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from './strictJsonValue.js';

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

function isPlainObject(value: unknown): value is PluginAgentExternalSessionLinkDataObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateLinkDataBounds(
  value: PluginAgentExternalSessionLinkDataValue,
  ctx: z.core.ParsePayload,
): boolean {
  const pending: Array<Readonly<{
    value: PluginAgentExternalSessionLinkDataValue;
    depth: number;
    path: PropertyKey[];
  }>> = [{ value, depth: 0, path: [] }];
  let entries = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    if (current.depth > MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_DEPTH) {
      ctx.issues.push({ code: 'custom', path: current.path, message: 'External-session linkData is too deeply nested.', input: ctx.value });
      return false;
    }
    if (current.value === null || typeof current.value !== 'object') continue;

    if (Array.isArray(current.value)) {
      entries += current.value.length;
      if (entries > MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_ENTRIES) {
        ctx.issues.push({ code: 'custom', message: 'External-session linkData has too many entries.', input: ctx.value });
        return false;
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: current.value[index]!,
          depth: current.depth + 1,
          path: [...current.path, index],
        });
      }
      continue;
    }

    const object = current.value as PluginAgentExternalSessionLinkDataObject;
    const keys = Object.keys(object);
    entries += keys.length;
    if (entries > MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_ENTRIES) {
      ctx.issues.push({ code: 'custom', message: 'External-session linkData has too many entries.', input: ctx.value });
      return false;
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      pending.push({
        value: object[key]!,
        depth: current.depth + 1,
        path: [...current.path, key],
      });
    }
  }

  return true;
}

export const PluginAgentExternalSessionLinkDataSchema: z.ZodMiniType<PluginAgentExternalSessionLinkData> = z.pipe(z
  .unknown(), z.transform((value, ctx) => {
    let snapshot: unknown;
    try {
      snapshot = cloneStrictPluginJsonValue(value, 'External-session linkData');
    } catch (error) {
      ctx.issues.push({
        code: 'custom',
        message: error instanceof Error ? error.message : 'External-session linkData must contain strict JSON data.', input: ctx.value });
      return z.NEVER;
    }
    if (!isPlainObject(snapshot)) {
      ctx.issues.push({ code: 'custom', message: 'External-session linkData must be a JSON object.', input: ctx.value });
      return z.NEVER;
    }
    const linkData = snapshot as PluginAgentExternalSessionLinkData;
    if (!validateLinkDataBounds(linkData, ctx)) return z.NEVER;
    if (measureSerializedValidatedStrictPluginJsonUtf8Bytes(
      linkData,
      'External-session linkData',
      MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES,
    ) > MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES) {
      ctx.issues.push({ code: 'custom', message: 'External-session linkData exceeds the serialized-byte limit.', input: ctx.value });
      return z.NEVER;
    }
    return linkData;
  })) as z.ZodMiniType<PluginAgentExternalSessionLinkData>;
