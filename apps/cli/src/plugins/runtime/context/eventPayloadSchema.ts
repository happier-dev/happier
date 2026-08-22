import {
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
} from '@happier-dev/protocol';

type ValidationResult = Readonly<
    | { success: true }
    | { success: false; message: string }
>;

/**
 * Event publication and subscription filters use the Protocol-owned JSON
 * Schema compiler.  This boundary owns only the host-facing disposition; it
 * must not recreate a narrower second schema evaluator.
 */
export function validatePluginEventPayloadSchema(params: Readonly<{
    payloadSchema: object;
    payload: unknown;
}>): ValidationResult {
    try {
        const validate = compilePluginJsonSchema(params.payloadSchema);
        return isValidPluginJsonSchemaValue(validate, params.payload)
            ? { success: true }
            : { success: false, message: 'payload does not match the declared plugin JSON Schema' };
    } catch {
        return { success: false, message: 'payload or schema must contain bounded strict JSON data' };
    }
}
