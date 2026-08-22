import { z } from 'zod';

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
  ctx: z.RefinementCtx,
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
      ctx.addIssue({ code: 'custom', path: current.path, message: 'External-session linkData is too deeply nested.' });
      return false;
    }
    if (current.value === null || typeof current.value !== 'object') continue;

    if (Array.isArray(current.value)) {
      entries += current.value.length;
      if (entries > MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_ENTRIES) {
        ctx.addIssue({ code: 'custom', message: 'External-session linkData has too many entries.' });
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
      ctx.addIssue({ code: 'custom', message: 'External-session linkData has too many entries.' });
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

export const PluginAgentExternalSessionLinkDataSchema: z.ZodType<PluginAgentExternalSessionLinkData> = z
  .unknown()
  .transform((value, ctx) => {
    let snapshot: unknown;
    try {
      snapshot = cloneStrictPluginJsonValue(value, 'External-session linkData');
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'External-session linkData must contain strict JSON data.',
      });
      return z.NEVER;
    }
    if (!isPlainObject(snapshot)) {
      ctx.addIssue({ code: 'custom', message: 'External-session linkData must be a JSON object.' });
      return z.NEVER;
    }
    const linkData = snapshot as PluginAgentExternalSessionLinkData;
    if (!validateLinkDataBounds(linkData, ctx)) return z.NEVER;
    if (measureSerializedValidatedStrictPluginJsonUtf8Bytes(
      linkData,
      'External-session linkData',
      MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES,
    ) > MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'External-session linkData exceeds the serialized-byte limit.' });
      return z.NEVER;
    }
    return linkData;
  }) as z.ZodType<PluginAgentExternalSessionLinkData>;
