import { z } from '../zodRuntimePolicy.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { InputOptionSchema } from './inputFields.js';

/** Transient display/selection data only. No target, credential or admission proof. */
export const InputTypePickerLaunchInputV1Schema = z.strictObject({
  inputType: asProtocolZod(PluginContributionIdentityV1Schema), semantic: z.string().check(z.trim(), z.minLength(1)),
  value: z.optional(StrictJsonValueSchema), options: z.optional(z.readonly(z.array(InputOptionSchema))),
});
export type InputTypePickerLaunchInputV1 = z.infer<typeof InputTypePickerLaunchInputV1Schema>;
export function readInputTypePickerLaunchInput(value: unknown): InputTypePickerLaunchInputV1 | null {
  const parsed = InputTypePickerLaunchInputV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
