import { z } from '../../zodRuntimePolicy.js';

import { BrowserAdapterCapabilitiesV1Schema } from '../adapters/v1.js';
import { BrowserCommandKindV1Schema } from '../control/v1.js';
import { BrowserEventKindV1Schema } from '../events/v1.js';

export const BrowserControlPlaneCapabilitiesV1Schema = z.strictObject({
    supportedCommands: z._default(z.optional(z.array(BrowserCommandKindV1Schema)), []),
    supportedEvents: z._default(z.optional(z.array(BrowserEventKindV1Schema)), []),
    adapters: z._default(z.optional(z.array(BrowserAdapterCapabilitiesV1Schema)), []),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
  });
export type BrowserControlPlaneCapabilitiesV1 = z.infer<typeof BrowserControlPlaneCapabilitiesV1Schema>;
