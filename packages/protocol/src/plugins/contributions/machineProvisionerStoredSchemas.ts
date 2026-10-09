import { z } from 'zod';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { ProtocolValidationError, type ProtocolComposableSchema, type ProtocolSchemaSafeParseResult } from '../actions/protocolComposableSchema.js';

/** Persistence-only reader. It deliberately cannot be used as an Action schema. */
export type MachineProvisionerStoredReaderV1<TOutput> = Readonly<{
  parse(value: unknown): TOutput;
  safeParse(value: unknown): ProtocolSchemaSafeParseResult<TOutput>;
}>;

/** Prepare only on a retained-data read path; descriptor discovery never loads the compiler. */
export function prepareMachineProvisionerStoredSchemas<LI, LO, RI, RO, NI, NO>(schemas: Readonly<{
  launch: ProtocolComposableSchema<LI, LO>; resource: ProtocolComposableSchema<RI, RO>; nativeOperation: ProtocolComposableSchema<NI, NO>;
}>): Promise<Readonly<{ launchStored: MachineProvisionerStoredReaderV1<LO>; resourceStored: MachineProvisionerStoredReaderV1<RO>; nativeOperationStored: MachineProvisionerStoredReaderV1<NO> }>>;
export function prepareMachineProvisionerStoredSchemas<LI, LO, RI, RO>(schemas: Readonly<{
  launch: ProtocolComposableSchema<LI, LO>; resource: ProtocolComposableSchema<RI, RO>;
}>): Promise<Readonly<{ launchStored: MachineProvisionerStoredReaderV1<LO>; resourceStored: MachineProvisionerStoredReaderV1<RO> }>>;
export async function prepareMachineProvisionerStoredSchemas<LI, LO, RI, RO, NI, NO>(schemas: Readonly<{
  launch: ProtocolComposableSchema<LI, LO>; resource: ProtocolComposableSchema<RI, RO>; nativeOperation?: ProtocolComposableSchema<NI, NO>;
}>) {
  const { createPluginJsonSchemaZodValueAdapter } = await import('../actions/jsonSchemaValidation.js');
  function reader<I, O>(declared: ProtocolComposableSchema<I, O>): MachineProvisionerStoredReaderV1<O> {
    const stored = createStoredReadSchema(createPluginJsonSchemaZodValueAdapter(declared.jsonSchema));
    const safeParse = (value: unknown): ProtocolSchemaSafeParseResult<O> => {
      const projected = z.safeParse(stored, value);
      if (projected.success) return declared.safeParse(projected.data);
      return { success: false, error: new ProtocolValidationError(projected.error.issues.map(issue => ({
        code: issue.code, message: issue.message, path: issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number'),
      }))) };
    };
    return Object.freeze({ safeParse, parse(value: unknown): O {
      const parsed = safeParse(value);
      if (!parsed.success) throw parsed.error;
      return parsed.data;
    } });
  }
  return Object.freeze({ launchStored: reader(schemas.launch), resourceStored: reader(schemas.resource),
    ...(schemas.nativeOperation ? { nativeOperationStored: reader(schemas.nativeOperation) } : {}),
  });
}
