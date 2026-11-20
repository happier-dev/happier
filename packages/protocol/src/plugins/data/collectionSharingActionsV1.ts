import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginCollectionContractRefV1Schema, type PluginCollectionContractRefV1 } from './collectionContractRefV1.js';
import { AccountDataCollectionValueV1Schema } from './collectionLogicalValueV1.js';
import { PluginCollectionSharingAddressV1Schema, PluginCollectionSharingGrantsResponseV1Schema,
  PluginCollectionSharingListRequestV1Schema, PluginCollectionSharingMutationResponseV1Schema,
  PluginCollectionSharingPutRequestV1Schema, PluginCollectionSharingResourceV1Schema,
  PluginCollectionSharingRevokeGrantRequestV1Schema, PluginCollectionSharingSetGrantRequestV1Schema } from './collectionSharingV1.js';
import { PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1 as ids, type PluginCollectionSharingActionIdV1 } from './collectionSharingActionIdsV1.js';

const listInput = lazyZodSchema(() => z.strictObject({ collectionRef: PluginCollectionContractRefV1Schema,
  ...z.pick(PluginCollectionSharingListRequestV1Schema, { cursor: true, limit: true, sharedWithTeamId: true }).shape }));
const getInput = lazyZodSchema(() => z.strictObject({ collectionRef: PluginCollectionContractRefV1Schema,
  ...z.pick(PluginCollectionSharingAddressV1Schema, { ownerAccountId: true, rowId: true }).shape }));
const putInput = lazyZodSchema(() => z.strictObject({ collectionRef: PluginCollectionContractRefV1Schema,
  ...z.pick(PluginCollectionSharingPutRequestV1Schema, { ownerAccountId: true, expectedRevision: true }).shape,
  value: AccountDataCollectionValueV1Schema }));
const listGrantsInput = lazyZodSchema(() => z.strictObject({ collectionRef: PluginCollectionContractRefV1Schema,
  ...z.pick(PluginCollectionSharingAddressV1Schema, { rowId: true }).shape }));
const setGrantInput = lazyZodSchema(() => z.strictObject({ collectionRef: PluginCollectionContractRefV1Schema,
  ...z.pick(PluginCollectionSharingSetGrantRequestV1Schema, { rowId: true, principal: true, accessLevel: true, expectedRevision: true }).shape }));
const revokeGrantInput = lazyZodSchema(() => z.strictObject({ collectionRef: PluginCollectionContractRefV1Schema,
  ...z.pick(PluginCollectionSharingRevokeGrantRequestV1Schema, { rowId: true, principal: true }).shape }));
const rowOutput = lazyZodSchema(() => z.strictObject({
  ...z.pick(PluginCollectionSharingResourceV1Schema, { ownerAccountId: true, access: true }).shape,
  ...z.pick(PluginCollectionSharingResourceV1Schema.shape.row, { rowId: true, revision: true }).shape,
  value: AccountDataCollectionValueV1Schema,
}));
const listOutput = lazyZodSchema(() => z.strictObject({
  rows: z.array(z.extend(rowOutput, { sharedWithTeamScope: PluginCollectionSharingResourceV1Schema.shape.sharedWithTeamScope })),
  nextCursor: z.optional(z.string()),
}));
const grantsOutput = lazyZodSchema(() => z.pick(PluginCollectionSharingGrantsResponseV1Schema, { ownerAccountId: true, access: true, grants: true }));

export const PluginCollectionSharingActionInputSchemasV1 = {
  [ids.list]: listInput, [ids.get]: getInput, [ids.put]: putInput,
  [ids.listGrants]: listGrantsInput, [ids.setGrant]: setGrantInput, [ids.revokeGrant]: revokeGrantInput,
} as const;
export const PluginCollectionSharingActionOutputSchemasV1 = {
  [ids.list]: listOutput, [ids.get]: rowOutput, [ids.put]: rowOutput,
  [ids.listGrants]: grantsOutput, [ids.setGrant]: PluginCollectionSharingMutationResponseV1Schema,
  [ids.revokeGrant]: PluginCollectionSharingMutationResponseV1Schema,
} as const;
export type PluginCollectionSharingActionInputV1 = z.infer<typeof PluginCollectionSharingActionInputSchemasV1[PluginCollectionSharingActionIdV1]>;
export type PluginCollectionSharingActionRequestV1 = {
  [Id in PluginCollectionSharingActionIdV1]: Readonly<{ actionId: Id; input: z.infer<typeof PluginCollectionSharingActionInputSchemasV1[Id]>; signal?: AbortSignal }>
}[PluginCollectionSharingActionIdV1];
type LogicalRow = z.infer<typeof rowOutput>;
type GrantResult = z.infer<typeof grantsOutput>;
type Operand<T> = Omit<T, 'collectionRef'>;
export type PluginCollectionSharingActionClientV1 = Readonly<{
  sharedWithMe: (input: Operand<z.infer<typeof listInput>>) => Promise<Readonly<{ rows: readonly LogicalRow[]; nextCursor?: string }>>;
  get: (input: Operand<z.infer<typeof getInput>>) => Promise<LogicalRow>;
  put: (input: Operand<z.infer<typeof putInput>>) => Promise<LogicalRow>;
  listGrants: (rowId: string) => Promise<Readonly<Omit<GrantResult, 'grants'> & { grants: readonly GrantResult['grants'][number][] }>>;
  setGrant: (rowId: string, input: Omit<Operand<z.infer<typeof setGrantInput>>, 'rowId'>) => Promise<Readonly<{ changed: boolean }>>;
  revokeGrant: (rowId: string, input: Omit<Operand<z.infer<typeof revokeGrantInput>>, 'rowId'>) => Promise<Readonly<{ changed: boolean }>>;
}>;
export type PluginCollectionSharingActionResultV1 = Awaited<ReturnType<PluginCollectionSharingActionClientV1[keyof PluginCollectionSharingActionClientV1]>>;

/** The realm resolves its existing Account-bound logical client; this owner only dispatches parsed operands. */
export function createPluginCollectionSharingActionExecuteV1(options: Readonly<{
  resolveClient: (collectionRef: PluginCollectionContractRefV1, signal?: AbortSignal) => Promise<PluginCollectionSharingActionClientV1>;
}>): (request: PluginCollectionSharingActionRequestV1) => Promise<PluginCollectionSharingActionResultV1> {
  return async (request: PluginCollectionSharingActionRequestV1) => {
    const client = await options.resolveClient(request.input.collectionRef, request.signal);
    switch (request.actionId) {
      case ids.list: { const { collectionRef: _, ...input } = request.input; return client.sharedWithMe(input); }
      case ids.get: { const { collectionRef: _, ...input } = request.input; return client.get(input); }
      case ids.put: { const { collectionRef: _, ...input } = request.input; return client.put(input); }
      case ids.listGrants: return client.listGrants(request.input.rowId);
      case ids.setGrant: { const { collectionRef: _, rowId, ...input } = request.input; return client.setGrant(rowId, input); }
      case ids.revokeGrant: { const { collectionRef: _, rowId, ...input } = request.input; return client.revokeGrant(rowId, input); }
    }
  };
}
