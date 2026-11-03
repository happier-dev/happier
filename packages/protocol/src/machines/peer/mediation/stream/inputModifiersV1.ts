import { z } from 'zod/mini';
import { BrowserInputModifierV1Schema } from '../../../../browser/input/v1.js';

/** Browser modifiers plus the native keyboard's Fn modifier (where the driver supports it). */
export const MachineLiveStreamKeyModifierV1Schema = z.union([BrowserInputModifierV1Schema, z.literal('fn')]);
