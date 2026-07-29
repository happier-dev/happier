import type { ValidateFunction } from 'ajv';

import type { PluginSettingFieldV2 } from '@happier-dev/protocol';

import { compilePluginJsonSchema } from '@/plugins/runtime/invocation/services/jsonSchemaValidation';

const validatorsByField = new WeakMap<PluginSettingFieldV2, ValidateFunction>();

export class PluginSettingFieldSchemaCompilationError extends Error {
    constructor() {
        super('Plugin setting schema cannot be compiled');
        this.name = 'PluginSettingFieldSchemaCompilationError';
    }
}

export function compilePluginSettingFieldSchema(
    field: PluginSettingFieldV2,
): ValidateFunction {
    const cached = validatorsByField.get(field);
    if (cached) return cached;

    let validate: ValidateFunction;
    try {
        validate = compilePluginJsonSchema(field.schema);
    } catch {
        throw new PluginSettingFieldSchemaCompilationError();
    }
    validatorsByField.set(field, validate);
    return validate;
}
