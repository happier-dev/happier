import { ManagedNativeOperationReferenceV1Schema, type ManagedNativeOperationReferenceV1 } from '../../machines/managed/providerFactsV1.js';
import { lazyDefinition } from '../../lazyZodSchema.js';
import { jsonSchemaContainsReference } from '../../actions/actionInputJsonSchema.js';
import { projectZodProtocolSchema } from '../actions/internalProtocolZodAdapter.js';
import { PluginLocalizedStringV2Schema, type PluginLocalizedStringV2 } from './publicTypes.js';
import { createProtocolComposableSchema, embedProtocolJsonSchema, defineProtocolJsonValue, defineProtocolLiteral,
  defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolComposableSchema } from '../actions/protocolComposableSchema.js';

const referenceSchema: ProtocolComposableSchema<ManagedNativeOperationReferenceV1, ManagedNativeOperationReferenceV1> =
  projectZodProtocolSchema(lazyDefinition(() => ManagedNativeOperationReferenceV1Schema));
const localizedStatusSchema: ProtocolComposableSchema<PluginLocalizedStringV2, PluginLocalizedStringV2> =
  projectZodProtocolSchema(lazyDefinition(() => PluginLocalizedStringV2Schema));
type PreparationReference<T> = Omit<ManagedNativeOperationReferenceV1, 'value'> & { value: T };

/** Artifact and pending-operation identities share the incumbent qualified reference envelope. */
function preparationReference<I, O>(valueSchema: ProtocolComposableSchema<I, O>) {
  return createProtocolComposableSchema<PreparationReference<I>, PreparationReference<O>>(() => {
    const { definitions: _definitions, $defs: _defs, ...reference } = referenceSchema.jsonSchema;
    const { $schema: _dialect, ...value } = valueSchema.jsonSchema;
    return { ...reference, properties: { ...reference.properties,
      value: jsonSchemaContainsReference(value) ? embedProtocolJsonSchema(value, ['properties', 'value']) : value } };
  }, value => {
    const reference = referenceSchema.safeParse(value);
    if (!reference.success) return reference;
    const native = valueSchema.safeParse(reference.data.value);
    return native.success ? { success: true, data: { ...reference.data, value: native.data } } : native;
  });
}

/** Provider-native build contracts only; preset selection and operation custody belong to the host. */
export function defineMachineProvisionerPreparationSchemas<II, IO, AI, AO, NI, NO, LI, LO>(schemas: Readonly<{
  input: ProtocolComposableSchema<II, IO>;
  launch: ProtocolComposableSchema<LI, LO>;
  artifact: ProtocolComposableSchema<AI, AO>;
  nativeOperation: ProtocolComposableSchema<NI, NO>;
}>) {
  const closed = { policy: 'closed' } as const;
  const code = defineProtocolString({ minLength: 1 });
  const artifact = preparationReference(schemas.artifact);
  const nativeOperationRef = preparationReference(schemas.nativeOperation);
  const ready = defineProtocolObject({ kind: defineProtocolLiteral('ready'), artifact }, closed);
  const pending = defineProtocolObject({ kind: defineProtocolLiteral('pending'), nativeOperationRef }, closed);
  const refused = defineProtocolObject({ kind: defineProtocolLiteral('refused'), code,
    status: localizedStatusSchema.optional() }, closed);
  const unknown = defineProtocolObject({ kind: defineProtocolLiteral('unknown'), code, nativeOperationRef }, closed);
  return Object.freeze({
    buildInput: defineProtocolObject({ operationId: code, input: schemas.input }, closed),
    buildResult: defineProtocolUnion([ready, pending, refused, unknown]),
    inspectInput: defineProtocolUnion([
      defineProtocolObject({ nativeOperation: nativeOperationRef }, closed),
      defineProtocolObject({ operationId: code, launch: schemas.launch }, closed),
    ]),
    inspectResult: defineProtocolUnion([ready, pending,
      defineProtocolObject({ kind: defineProtocolLiteral('failed'), code, nativeOperationRef }, closed),
      defineProtocolObject({ kind: defineProtocolLiteral('absent') }, closed), unknown]),
    destroyInput: defineProtocolUnion([
      defineProtocolObject({ artifact, nativeOperation: nativeOperationRef.optional() }, closed),
      defineProtocolObject({ artifact: artifact.optional(), nativeOperation: nativeOperationRef }, closed),
    ]),
    destroyResult: defineProtocolUnion([
      defineProtocolObject({ kind: defineProtocolLiteral('confirmed') }, closed), pending, refused, unknown,
    ]),
  });
}

const preparationSchemas = defineMachineProvisionerPreparationSchemas({ input: defineProtocolJsonValue(),
  launch: defineProtocolJsonValue(), artifact: defineProtocolJsonValue(), nativeOperation: defineProtocolJsonValue() });
export const MachineProvisionerPreparationBuildInputV1Schema = preparationSchemas.buildInput;
export const MachineProvisionerPreparationBuildResultV1Schema = preparationSchemas.buildResult;
export const MachineProvisionerPreparationInspectInputV1Schema = preparationSchemas.inspectInput;
export const MachineProvisionerPreparationInspectResultV1Schema = preparationSchemas.inspectResult;
export const MachineProvisionerPreparationDestroyInputV1Schema = preparationSchemas.destroyInput;
export const MachineProvisionerPreparationDestroyResultV1Schema = preparationSchemas.destroyResult;
export type MachineProvisionerPreparationBuildInputV1 = ReturnType<typeof MachineProvisionerPreparationBuildInputV1Schema.parse>;
export type MachineProvisionerPreparationBuildResultV1 = ReturnType<typeof MachineProvisionerPreparationBuildResultV1Schema.parse>;
export type MachineProvisionerPreparationInspectInputV1 = ReturnType<typeof MachineProvisionerPreparationInspectInputV1Schema.parse>;
export type MachineProvisionerPreparationInspectResultV1 = ReturnType<typeof MachineProvisionerPreparationInspectResultV1Schema.parse>;
export type MachineProvisionerPreparationDestroyInputV1 = ReturnType<typeof MachineProvisionerPreparationDestroyInputV1Schema.parse>;
export type MachineProvisionerPreparationDestroyResultV1 = ReturnType<typeof MachineProvisionerPreparationDestroyResultV1Schema.parse>;
