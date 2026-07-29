import type { ValidateFunction } from 'ajv';

import type { PluginSettingFieldV2 } from '@happier-dev/protocol';

import {
    compilePluginSettingFieldSchema,
    PluginSettingFieldSchemaCompilationError,
} from '@/plugins/settings/fieldSchemaValidation';
import { isValidPluginJsonSchemaValue } from '@/plugins/runtime/invocation/services/jsonSchemaValidation';
import { PluginContextServiceError } from './errors';

function settingsError(code: string, message: string): PluginContextServiceError {
    return new PluginContextServiceError(code, message);
}

function validatorForField(pluginId: string, field: PluginSettingFieldV2): ValidateFunction {
    try {
        return compilePluginSettingFieldSchema(field);
    } catch (error) {
        if (!(error instanceof PluginSettingFieldSchemaCompilationError)) throw error;
        throw settingsError(
            'PLUGIN_SETTINGS_SCHEMA_INVALID',
            `Plugin setting '${pluginId}/${field.id}' has an invalid schema`,
        );
    }
}

export function assertPluginSettingFieldValue(params: Readonly<{
    pluginId: string;
    field: PluginSettingFieldV2;
    value: unknown;
}>): void {
    if (!isValidPluginJsonSchemaValue(validatorForField(params.pluginId, params.field), params.value)) {
        throw settingsError(
            'PLUGIN_SETTINGS_VALIDATION_FAILED',
            `Plugin setting '${params.field.id}' failed schema validation`,
        );
    }
}
