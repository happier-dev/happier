import type {
    PluginJsonSchemaValidator,
    PluginSettingFieldV2,
} from '@happier-dev/protocol';
import { isBoundedPluginPerActiveServerValueV1 } from '@happier-dev/protocol/plugins/contributions/settings';

import {
    compilePluginSettingFieldSchema,
    PluginSettingFieldSchemaCompilationError,
} from '@/plugins/settings/fieldSchemaValidation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { PluginContextServiceError } from './errors';

function settingsError(code: string, message: string): PluginContextServiceError {
    return new PluginContextServiceError(code, message);
}

function validatorForField(pluginId: string, field: PluginSettingFieldV2): PluginJsonSchemaValidator {
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
    fields: readonly PluginSettingFieldV2[];
    value: unknown;
}>): void {
    const isPerActiveServerMap = params.fields.some((field) => (
        field.presentation?.binding?.kind === 'perActiveServer'
        && field.presentation.binding.byServerIdSettingId === params.field.id
    ));
    if (!isValidPluginJsonSchemaValue(validatorForField(params.pluginId, params.field), params.value)
        || (isPerActiveServerMap && !isBoundedPluginPerActiveServerValueV1(params.value))) {
        throw settingsError(
            'PLUGIN_SETTINGS_VALIDATION_FAILED',
            `Plugin setting '${params.field.id}' failed schema validation`,
        );
    }
}
