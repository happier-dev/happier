import { z } from 'zod';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { InputOptionSchema } from './inputFields.js';

/** Transient display/selection data only. No target, credential or admission proof. */
export const InputTypePickerLaunchInputV1Schema = z.object({
  inputType: asProtocolZod(PluginContributionIdentityV1Schema), semantic: z.string().trim().min(1),
  value: StrictJsonValueSchema.optional(), options: z.array(InputOptionSchema).readonly().optional(),
}).strict();
export type InputTypePickerLaunchInputV1 = z.infer<typeof InputTypePickerLaunchInputV1Schema>;
export function readInputTypePickerLaunchInput(value: unknown): InputTypePickerLaunchInputV1 | null {
  const parsed = InputTypePickerLaunchInputV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
