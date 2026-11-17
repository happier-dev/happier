import { DatabaseValueV1Schema, type DatabaseValueV1 } from '@happier-dev/database-protocol';

export type ConsoleParameterInput = Readonly<{ type: DatabaseValueV1['type']; text: string; nativeType?: string }>;
export function readConsoleParameter(input: ConsoleParameterInput): DatabaseValueV1 | undefined {
    const value = input.type === 'null' ? { type: input.type }
        : input.type === 'boolean' ? { type: input.type, value: input.text === 'true' ? true : input.text === 'false' ? false : undefined }
        : input.type === 'float' ? { type: input.type, value: ['NaN', 'Infinity', '-Infinity'].includes(input.text) ? input.text : input.text.trim() ? Number(input.text) : undefined }
        : input.type === 'binary' ? { type: input.type, encoding: 'base64', value: input.text }
        : input.type === 'temporal' ? { type: input.type, nativeType: input.nativeType, value: input.text }
        : { type: input.type, value: input.text };
    const parsed = DatabaseValueV1Schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}
export function parameterInput(value: DatabaseValueV1): ConsoleParameterInput {
    return { type: value.type, text: value.type === 'null' ? '' : String(value.value), ...(value.type === 'temporal' ? { nativeType: value.nativeType } : {}) };
}
