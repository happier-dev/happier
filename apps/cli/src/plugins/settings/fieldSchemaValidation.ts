import {
    compilePluginJsonSchema,
    type PluginJsonSchemaValidator,
    type PluginSettingFieldV2,
} from '@happier-dev/protocol';

const validatorsByField = new WeakMap<PluginSettingFieldV2, PluginJsonSchemaValidator>();

export class PluginSettingFieldSchemaCompilationError extends Error {
    constructor() {
        super('Plugin setting schema cannot be compiled');
        this.name = 'PluginSettingFieldSchemaCompilationError';
    }
}

export function compilePluginSettingFieldSchema(
    field: PluginSettingFieldV2,
): PluginJsonSchemaValidator {
    const cached = validatorsByField.get(field);
    if (cached) return cached;

    let validate: PluginJsonSchemaValidator;
    try {
        validate = compilePluginJsonSchema(field.schema);
    } catch {
        throw new PluginSettingFieldSchemaCompilationError();
    }
    validatorsByField.set(field, validate);
    return validate;
}
