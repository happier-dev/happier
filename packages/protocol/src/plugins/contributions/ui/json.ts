import { z } from 'zod';

import { isStrictPluginJsonValue } from '../strictJsonValue.js';

export type PluginUiJsonValueV1 =
  | null
  | boolean
  | number
  | string
  | readonly PluginUiJsonValueV1[]
  | { readonly [key: string]: PluginUiJsonValueV1 };

export const PluginUiJsonValueV1Schema = z.custom<PluginUiJsonValueV1>(
  (value): value is PluginUiJsonValueV1 => isStrictPluginJsonValue(value),
  { message: 'Plugin UI descriptor values must be JSON-serializable.' },
);
