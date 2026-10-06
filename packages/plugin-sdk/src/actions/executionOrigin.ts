import { PluginMachineExecutionOriginV1Schema as canonicalPluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';

import type { PluginMachineExecutionOriginV1 } from './actionTypeMap.generated.js';
import { projectProtocolValue } from '../protocol/projectProtocolValue.js';

/** Exact Protocol execution-origin evidence returned by contributed Action execution. */
export const PluginMachineExecutionOriginV1Schema: Readonly<{
  parse(value: unknown): PluginMachineExecutionOriginV1;
  safeParse(value: unknown):
    | Readonly<{ success: true; data: PluginMachineExecutionOriginV1 }>
    | Readonly<{ success: false; error: unknown }>;
}> = projectProtocolValue(canonicalPluginMachineExecutionOriginV1Schema);
/** Exact Protocol execution-origin fact used for contributed Action currentness. */
export type { PluginMachineExecutionOriginV1 };
