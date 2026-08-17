import { z } from 'zod';

import { RuntimeActionIdV1Schema, type RuntimeActionIdV1 } from '../actionIds.js';
import type { ActionSpecWithoutApproval } from '../actionSpecs.js';
import { RUNTIME_DANGER_ACTION_IDS } from '../danger.js';
import { runtimeActionSideEffectClass } from '../safety.js';
import { isRuntimeActionExecutorReal, resolveRuntimeActionSurfaces } from '../surfaces.js';
import {
  BrowserCommandDispatchResultV1Schema,
  BrowserNavigateCommandV1Schema,
} from '../../browser/control/v1.js';
import { BROWSER_RUNTIME_ACTION_SPEC_FAMILY } from './browser.js';
import { PassthroughEmptyObjectSchema, type RuntimeActionSpecFamily, type RuntimeActionSpecTextMap } from './common.js';
import { LOCAL_SERVICES_RUNTIME_ACTION_SPEC_FAMILY } from './localServices.js';
import { PEER_MEDIATION_RUNTIME_ACTION_SPEC_FAMILY } from './peerMediation.js';
import { SIMULATOR_RUNTIME_ACTION_SPEC_FAMILY } from './simulator.js';

const RUNTIME_ACTION_SPEC_FAMILIES: readonly RuntimeActionSpecFamily[] = Object.freeze([
  BROWSER_RUNTIME_ACTION_SPEC_FAMILY,
  LOCAL_SERVICES_RUNTIME_ACTION_SPEC_FAMILY,
  PEER_MEDIATION_RUNTIME_ACTION_SPEC_FAMILY,
  SIMULATOR_RUNTIME_ACTION_SPEC_FAMILY,
]);

function mergeRuntimeActionTextMaps(
  readMap: (family: RuntimeActionSpecFamily) => RuntimeActionSpecTextMap | undefined,
): RuntimeActionSpecTextMap {
  return Object.freeze(Object.assign({}, ...RUNTIME_ACTION_SPEC_FAMILIES.map((family) => readMap(family) ?? {})));
}

const RUNTIME_ACTION_TITLES = mergeRuntimeActionTextMaps((family) => family.titles);
const RUNTIME_ACTION_DESCRIPTIONS = mergeRuntimeActionTextMaps((family) => family.descriptions);

function runtimeActionInputSchema(actionId: RuntimeActionIdV1): z.ZodTypeAny {
  for (const family of RUNTIME_ACTION_SPEC_FAMILIES) {
    const schema = family.inputSchemaForAction(actionId);
    if (schema) return schema;
  }
  return PassthroughEmptyObjectSchema;
}

function runtimeActionOutputSchema(actionId: RuntimeActionIdV1): z.ZodTypeAny {
  for (const family of RUNTIME_ACTION_SPEC_FAMILIES) {
    const schema = family.outputSchemaForAction(actionId);
    if (schema) return schema;
  }
  return z.unknown();
}

// UX-3: the fail-closed projection-contract copy belongs only to runtime actions whose executor is
// not yet real. Enabled runtime actions surface human-facing copy from the family maps.
const RUNTIME_ACTION_PROJECTION_CONTRACT_DESCRIPTION =
  'Runtime-unification action projection contract. It remains fail-closed until the owning runtime adapter enables a concrete surface and executor.';
const RUNTIME_ACTION_PROJECTION_CONTRACT_HINT_DESCRIPTION =
  'No UI, tool, RPC, or SDK surface is enabled until the runtime owner wires a real executor and feature gate.';

type RuntimeActionSpecFor<
  TActionId extends RuntimeActionIdV1,
  TInputSchema extends z.ZodTypeAny,
  TOutputSchema extends z.ZodTypeAny,
  TPlugin extends boolean,
> = Omit<ActionSpecWithoutApproval, 'id' | 'inputSchema' | 'outputSchema' | 'surfaces'> & Readonly<{
  id: TActionId;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  surfaces: ActionSpecWithoutApproval['surfaces'] & Readonly<{ plugin: TPlugin }>;
}>;

function createRuntimeActionSpecFor<
  const TActionId extends RuntimeActionIdV1,
  const TInputSchema extends z.ZodTypeAny,
  const TOutputSchema extends z.ZodTypeAny,
  const TPlugin extends boolean,
>(params: Readonly<{
  actionId: TActionId;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  plugin: TPlugin;
}>): RuntimeActionSpecFor<TActionId, TInputSchema, TOutputSchema, TPlugin> {
  const { actionId } = params;
  const sideEffectClass = runtimeActionSideEffectClass(actionId);
  const title = RUNTIME_ACTION_TITLES[actionId] ?? actionId;
  const executorReal = isRuntimeActionExecutorReal(actionId);
  if (params.plugin && !executorReal) {
    throw new Error(`Runtime action ${actionId} cannot enable the plugin surface without a real executor.`);
  }
  const humanDescription = RUNTIME_ACTION_DESCRIPTIONS[actionId] ?? title;
  return {
    id: actionId,
    title,
    description: executorReal ? humanDescription : RUNTIME_ACTION_PROJECTION_CONTRACT_DESCRIPTION,
    safety: RUNTIME_DANGER_ACTION_IDS.has(actionId) ? 'danger' : 'safe',
    placements: [],
    surfaces: {
      ...resolveRuntimeActionSurfaces(actionId),
      plugin: params.plugin,
    },
    sideEffectClass,
    outputSchema: params.outputSchema,
    inputSchema: params.inputSchema,
    inputHints: {
      title,
      description: executorReal ? humanDescription : RUNTIME_ACTION_PROJECTION_CONTRACT_HINT_DESCRIPTION,
      fields: [],
    },
  };
}

function createRuntimeActionSpec(actionId: RuntimeActionIdV1) {
  if (actionId === 'browser.navigate') {
    return createRuntimeActionSpecFor({
      actionId,
      inputSchema: BrowserNavigateCommandV1Schema,
      outputSchema: BrowserCommandDispatchResultV1Schema,
      plugin: true,
    });
  }

  return createRuntimeActionSpecFor({
    actionId,
    inputSchema: runtimeActionInputSchema(actionId),
    outputSchema: runtimeActionOutputSchema(actionId),
    plugin: false,
  });
}

export const RUNTIME_ACTION_SPECS = Object.freeze(
  RuntimeActionIdV1Schema.options.map(createRuntimeActionSpec),
) satisfies readonly ActionSpecWithoutApproval[];
