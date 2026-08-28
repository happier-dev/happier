/** @moduleRealm any */
import {
    arePluginMachineMaterializationRefsEqual as canonicalArePluginMachineMaterializationRefsEqual,
    arePluginMachineExecutionOriginsEqual as canonicalArePluginMachineExecutionOriginsEqual,
} from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginMachineExecutionOriginV1 } from './actions/executionOrigin.js';

/** Portable, host-stamped identity of one installed plugin materialization. */
export type PluginMachineMaterializationRefV1 = {
    machineId: string;
    materializationId: string;
    pluginId: string;
};

/** Exact host-stamped machine origin used for currentness and equality checks. */
export type { PluginMachineExecutionOriginV1 } from './actions/executionOrigin.js';

/** Exact equality for an already host-stamped plugin materialization. */
export const arePluginMachineMaterializationRefsEqual: (
    left: PluginMachineMaterializationRefV1,
    right: PluginMachineMaterializationRefV1,
) => boolean = canonicalArePluginMachineMaterializationRefsEqual;

/**
 * Browser-safe projection of Protocol/Admin's exact execution-origin equality
 * rule. It compares already host-stamped facts and never resolves a target.
 */
export const arePluginMachineExecutionOriginsEqual: (
    left: PluginMachineExecutionOriginV1,
    right: PluginMachineExecutionOriginV1,
) => boolean = canonicalArePluginMachineExecutionOriginsEqual;
