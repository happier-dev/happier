import { z } from 'zod';

export type PluginUiJsonValueV1 =
  | null
  | boolean
  | number
  | string
  | readonly PluginUiJsonValueV1[]
  | { readonly [key: string]: PluginUiJsonValueV1 };

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPluginUiJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): value is PluginUiJsonValueV1 {
  if (value === null) return true;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }

  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.every((item) => isPluginUiJsonValue(item, seen));
  }

  if (!isPlainObject(value)) return false;
  return Object.values(value).every((item) => isPluginUiJsonValue(item, seen));
}

export const PluginUiJsonValueV1Schema = z.custom<PluginUiJsonValueV1>(
  (value): value is PluginUiJsonValueV1 => isPluginUiJsonValue(value),
  { message: 'Plugin UI descriptor values must be JSON-serializable.' },
);
