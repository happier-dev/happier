import { z } from 'zod';

import type { JsonValue } from '../../../json/strictJsonValue.js';
import { isStrictPluginJsonValue } from '../strictJsonValue.js';

/** UI spelling of Protocol's single normalized strict-JSON value owner. */
export type PluginUiJsonValueV1 = JsonValue;

export const PluginUiJsonValueV1Schema = z.custom<PluginUiJsonValueV1>(
  (value): value is PluginUiJsonValueV1 => isStrictPluginJsonValue(value),
  { message: 'Plugin UI descriptor values must be JSON-serializable.' },
);
