import { z } from 'zod';

import { RuntimeActionIdV1Schema, type RuntimeActionIdV1 } from '../actionIds.js';
import type { PreNormalizedActionSpec, PreNormalizedActionSurfaces } from '../actionSpecs.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { RUNTIME_DANGER_ACTION_IDS } from '../danger.js';
import { runtimeActionSideEffectClass } from '../safety.js';
import { isRuntimeActionExecutorReal, resolveRuntimeActionSurfaces } from '../surfaces.js';
import {
  BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS,
  BROWSER_RUNTIME_ACTION_OUTPUT_SCHEMAS,
  BROWSER_RUNTIME_ACTION_SPEC_FAMILY,
} from './browser.js';
import { type RuntimeActionSpecFamily, type RuntimeActionSpecTextMap } from './common.js';
import {
  COMPUTER_RUNTIME_ACTION_INPUT_SCHEMAS,
  COMPUTER_RUNTIME_ACTION_OUTPUT_SCHEMAS,
  COMPUTER_RUNTIME_ACTION_SPEC_FAMILY,
  projectComputerObservationInput,
} from './computer.js';
import {
  LOCAL_SERVICES_RUNTIME_ACTION_INPUT_SCHEMAS,
  LOCAL_SERVICES_RUNTIME_ACTION_OUTPUT_SCHEMAS,
  LOCAL_SERVICES_RUNTIME_ACTION_SPEC_FAMILY,
  LOCAL_SERVICE_CONTROL_ACTION_RPC_METHODS,
  resolveLocalServiceActionKindForRuntimeActionId,
} from './localServices.js';
import {
  PEER_MEDIATION_RUNTIME_ACTION_INPUT_SCHEMAS,
  PEER_MEDIATION_RUNTIME_ACTION_OUTPUT_SCHEMAS,
  PEER_MEDIATION_RUNTIME_ACTION_SPEC_FAMILY,
} from './peerMediation.js';
import {
  SIMULATOR_RUNTIME_ACTION_INPUT_SCHEMAS,
  SIMULATOR_RUNTIME_ACTION_OUTPUT_SCHEMAS,
  SIMULATOR_RUNTIME_ACTION_SPEC_FAMILY,
} from './simulator.js';

const RUNTIME_ACTION_SPEC_FAMILIES = Object.freeze([
  COMPUTER_RUNTIME_ACTION_SPEC_FAMILY,
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

/**
 * The sole aggregate runtime-schema owner. Family maps retain literal schema
 * carriers and this exhaustive merge gives the Action registry one concrete
 * input/output schema for every runtime id — no prefix fallback or unknown
 * public result carrier remains.
 */
type RuntimeActionInputSchemas = Readonly<
  typeof COMPUTER_RUNTIME_ACTION_INPUT_SCHEMAS
  & typeof BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS
  & typeof LOCAL_SERVICES_RUNTIME_ACTION_INPUT_SCHEMAS
  & typeof PEER_MEDIATION_RUNTIME_ACTION_INPUT_SCHEMAS
  & typeof SIMULATOR_RUNTIME_ACTION_INPUT_SCHEMAS
>;

type RuntimeActionOutputSchemas = Readonly<
  typeof COMPUTER_RUNTIME_ACTION_OUTPUT_SCHEMAS
  & typeof BROWSER_RUNTIME_ACTION_OUTPUT_SCHEMAS
  & typeof LOCAL_SERVICES_RUNTIME_ACTION_OUTPUT_SCHEMAS
  & typeof PEER_MEDIATION_RUNTIME_ACTION_OUTPUT_SCHEMAS
  & typeof SIMULATOR_RUNTIME_ACTION_OUTPUT_SCHEMAS
>;

export const RUNTIME_ACTION_INPUT_SCHEMAS: RuntimeActionInputSchemas = Object.freeze({
  ...COMPUTER_RUNTIME_ACTION_INPUT_SCHEMAS,
  ...BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS,
  ...LOCAL_SERVICES_RUNTIME_ACTION_INPUT_SCHEMAS,
  ...PEER_MEDIATION_RUNTIME_ACTION_INPUT_SCHEMAS,
  ...SIMULATOR_RUNTIME_ACTION_INPUT_SCHEMAS,
} as const satisfies Readonly<Record<RuntimeActionIdV1, z.ZodTypeAny>>);

export const RUNTIME_ACTION_OUTPUT_SCHEMAS: RuntimeActionOutputSchemas = Object.freeze({
  ...COMPUTER_RUNTIME_ACTION_OUTPUT_SCHEMAS,
  ...BROWSER_RUNTIME_ACTION_OUTPUT_SCHEMAS,
  ...LOCAL_SERVICES_RUNTIME_ACTION_OUTPUT_SCHEMAS,
  ...PEER_MEDIATION_RUNTIME_ACTION_OUTPUT_SCHEMAS,
  ...SIMULATOR_RUNTIME_ACTION_OUTPUT_SCHEMAS,
} as const satisfies Readonly<Record<RuntimeActionIdV1, z.ZodTypeAny>>);

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
> = Omit<PreNormalizedActionSpec, 'id' | 'inputSchema' | 'outputSchema' | 'surfaces'> & Readonly<{
  id: TActionId;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  surfaces: PreNormalizedActionSurfaces;
}>;

function createRuntimeActionSpecFor<
  const TActionId extends RuntimeActionIdV1,
  const TInputSchema extends z.ZodTypeAny,
  const TOutputSchema extends z.ZodTypeAny,
>(params: Readonly<{
  actionId: TActionId;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
}>): RuntimeActionSpecFor<TActionId, TInputSchema, TOutputSchema> {
  const { actionId } = params;
  const sideEffectClass = runtimeActionSideEffectClass(actionId);
  const title = RUNTIME_ACTION_TITLES[actionId] ?? actionId;
  const executorReal = isRuntimeActionExecutorReal(actionId);
  const humanDescription = RUNTIME_ACTION_DESCRIPTIONS[actionId] ?? title;
  const controlRpcMethod = Object.hasOwn(LOCAL_SERVICE_CONTROL_ACTION_RPC_METHODS, actionId)
    ? LOCAL_SERVICE_CONTROL_ACTION_RPC_METHODS[actionId as keyof typeof LOCAL_SERVICE_CONTROL_ACTION_RPC_METHODS] : undefined;
  const controlKind = resolveLocalServiceActionKindForRuntimeActionId(actionId);
  const requiresAnsweringClient = controlKind === 'copy_url' || controlKind === 'open_preview';
  return {
    id: actionId,
    title,
    description: executorReal ? humanDescription : RUNTIME_ACTION_PROJECTION_CONTRACT_DESCRIPTION,
    safety: RUNTIME_DANGER_ACTION_IDS.has(actionId) ? 'danger' : 'safe',
    placements: [],
    surfaces: {
      ...resolveRuntimeActionSurfaces(actionId),
      ...(actionId === 'localServices.launcher.start' || controlRpcMethod ? { rpc: true, cli: !requiresAnsweringClient, voice: !requiresAnsweringClient } : {}),
      ...(actionId === 'localServices.launcher.start' || (controlRpcMethod && !requiresAnsweringClient) ? { mcp: true } : {}),
    },
    sideEffectClass,
    outputSchema: params.outputSchema,
    inputSchema: params.inputSchema,
    ...(actionId === 'localServices.launcher.start' ? {
      executionPlacement: 'machine' as const,
      bindings: { rpcMethod: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START, voiceClientToolName: actionId.replaceAll('.', '_'),
        mcpToolName: actionId.replaceAll('.', '_') },
    } : {}),
    ...(controlRpcMethod ? { executionPlacement: 'machine' as const, bindings: { rpcMethod: controlRpcMethod,
      ...(!requiresAnsweringClient ? { voiceClientToolName: actionId.replaceAll('.', '_') } : {}),
      ...(!requiresAnsweringClient ? { mcpToolName: actionId.replaceAll('.', '_') } : {}) } } : {}),
    ...(actionId === 'projects.service.relocate' ? {
      executionPlacement: 'machine' as const,
      operation: { version: 1 as const, visibility: 'activity' as const, progress: 'reported' as const,
        presentation: { onStart: 'detail' as const } },
      ...(executorReal ? {
        cli: { commands: [{ path: ['projects', 'service', 'relocate'], visibility: 'canonical' as const }] },
        bindings: { mcpToolName: 'projects_service_relocate', voiceClientToolName: 'projects_service_relocate' },
      } : {}),
    } : {}),
    ...(actionId !== 'computer.secret.fill' && Object.hasOwn(COMPUTER_RUNTIME_ACTION_INPUT_SCHEMAS, actionId)
      ? { projectObservationInput: projectComputerObservationInput } : {}),
    inputHints: {
      title,
      description: executorReal ? humanDescription : RUNTIME_ACTION_PROJECTION_CONTRACT_HINT_DESCRIPTION,
      fields: [],
    },
  };
}

function createRuntimeActionSpec(actionId: RuntimeActionIdV1): RuntimeActionSpec {
  return createRuntimeActionSpecFor<RuntimeActionIdV1, RuntimeActionInputSchemas[RuntimeActionIdV1], RuntimeActionOutputSchemas[RuntimeActionIdV1]>({
    actionId,
    inputSchema: RUNTIME_ACTION_INPUT_SCHEMAS[actionId],
    outputSchema: RUNTIME_ACTION_OUTPUT_SCHEMAS[actionId],
  });
}

type RuntimeActionSpec = RuntimeActionSpecFor<
  RuntimeActionIdV1,
  RuntimeActionInputSchemas[RuntimeActionIdV1],
  RuntimeActionOutputSchemas[RuntimeActionIdV1]
>;

export const RUNTIME_ACTION_SPECS: readonly RuntimeActionSpec[] = Object.freeze(
  RuntimeActionIdV1Schema.options.map(createRuntimeActionSpec),
) satisfies readonly PreNormalizedActionSpec[];
