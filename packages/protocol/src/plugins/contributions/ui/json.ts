import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import type { JsonValue } from '../../../json/strictJsonValue.js';
import { isStrictPluginJsonValue } from '../strictJsonValue.js';
import { PluginJsonValueV2Schema } from '../jsonSchema.js';

/** UI spelling of Protocol's single normalized strict-JSON value owner. */
export type PluginUiJsonValueV1 = JsonValue;

export const PluginUiJsonValueV1Schema = lazyZodSchema(() => {
  const schema = z.custom<PluginUiJsonValueV1>(
    (value): value is PluginUiJsonValueV1 => isStrictPluginJsonValue(value),
    { message: 'Plugin UI descriptor values must be JSON-serializable.' },
  );
  schema._zod.processJSONSchema = (context, _json, params) => {
    z.core.process(PluginJsonValueV2Schema, context, params);
    context.seen.get(schema)!.ref = PluginJsonValueV2Schema;
  };
  return schema;
});
