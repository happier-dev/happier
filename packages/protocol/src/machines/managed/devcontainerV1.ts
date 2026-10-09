import * as z from 'zod/mini';
import { lazyDefinition } from '../../lazyZodSchema.js';
import { pluginJsonValuesEqual } from '../../plugins/actions/protocolComposableSchema.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const path = () => z.string().check(z.minLength(1), z.regex(/^[^\u0000]+$/u));
const childPath = () => z.string().check(z.regex(/^\/[^\u0000]*$/u));

/** Transient native disclosure. Only its digest belongs in retained launch choices. */
export const DevcontainerEffectReviewV1Schema = lazyDefinition(() => z.strictObject({
  kind: z.literal('devcontainer'),
  reviewedEffectDigest: z.string().check(z.regex(/^[a-f0-9]{64}$/u)),
  effects: z.array(z.strictObject({
    scope: z.enum(['host', 'child']),
    kind: z.enum(['initialize', 'image', 'build', 'compose', 'feature', 'mount', 'network', 'environment', 'user', 'lifecycle']),
    title: id(), details: z.array(z.string()),
  })),
}));
export type DevcontainerEffectReviewV1 = z.infer<typeof DevcontainerEffectReviewV1Schema>;

export const DevcontainerChildRelationV1Schema = lazyDefinition(() => z.strictObject({
  managedMachineId: id(), managedMachineKind: z.literal('devcontainer'), parentMachineId: id(),
}));
export const DevcontainerNativeObservationV1Schema = lazyDefinition(() => z.strictObject({
  nativeResourceId: id(), user: z.string().check(z.minLength(1), z.regex(/^[^\u0000\r\n]+$/u)),
  workspaceFolder: childPath(),
  storage: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('bind'), hostPath: path(), childPath: childPath() }),
    z.strictObject({ kind: z.literal('child'), childPath: childPath() }),
  ]),
}).check(z.superRefine((value, context) => {
  if (value.storage.childPath !== value.workspaceFolder) context.addIssue({ code: 'custom', path: ['storage', 'childPath'],
    message: 'Observed storage must address the observed child workspace.' });
})));
export const DevcontainerChildProjectionV1Schema = lazyDefinition(() => z.strictObject({
  relation: DevcontainerChildRelationV1Schema, observation: DevcontainerNativeObservationV1Schema,
}));
export type DevcontainerChildRelationV1 = z.infer<typeof DevcontainerChildRelationV1Schema>;
export type DevcontainerNativeObservationV1 = z.infer<typeof DevcontainerNativeObservationV1Schema>;
export type DevcontainerChildProjectionV1 = z.infer<typeof DevcontainerChildProjectionV1Schema>;

/** The retained resource and its physical controller are the sole producers. */
export function deriveManagedDevcontainerChildProjectionV1(input: Readonly<{
  managedMachineId: string; controllerMachineId: string; enrolledMachineId?: string;
  resource?: Readonly<{ devcontainerObservation?: DevcontainerNativeObservationV1 }>;
}>): DevcontainerChildProjectionV1 | undefined {
  const observation = input.resource?.devcontainerObservation;
  if (!input.enrolledMachineId || !observation) return undefined;
  return DevcontainerChildProjectionV1Schema.parse({ relation: { managedMachineId: input.managedMachineId,
    managedMachineKind: 'devcontainer', parentMachineId: input.controllerMachineId }, observation });
}

export function managedDevcontainerChildProjectionsEqualV1(left: DevcontainerChildProjectionV1 | undefined,
  right: DevcontainerChildProjectionV1 | undefined): boolean {
  return left === undefined || right === undefined ? left === right : pluginJsonValuesEqual(left, right);
}

/** Currentness belongs to the retained row, not controller reachability. */
export function isManagedDevcontainerChildProjectionCurrentV1(input: Readonly<{
  homeId: string; machineId: string; projection: DevcontainerChildProjectionV1 | undefined;
  managedMachine: Readonly<{
    id: string; homeId: string; enrolledMachineId?: string;
    controller: Readonly<{ machineId: string }>;
    allocation: string; creationState: string; archivedAt?: number;
    resource?: Readonly<{ devcontainerObservation?: DevcontainerNativeObservationV1 }>;
  }>;
}>): boolean {
  const row = input.managedMachine;
  if (!input.projection || row.homeId !== input.homeId || row.enrolledMachineId !== input.machineId
    || row.creationState !== 'active' || row.allocation !== 'bound' || row.archivedAt !== undefined) return false;
  return managedDevcontainerChildProjectionsEqualV1(input.projection,
    deriveManagedDevcontainerChildProjectionV1({ managedMachineId: row.id,
      controllerMachineId: row.controller.machineId, enrolledMachineId: row.enrolledMachineId, resource: row.resource }));
}
