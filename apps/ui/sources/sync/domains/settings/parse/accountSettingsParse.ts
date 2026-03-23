import { z } from 'zod';

import { dbgSettings } from '../debugSettings';
import { applyAccountSettingsCompatibilityMigrations } from './accountSettingsCompatibilityMigrations';
import {
    DROPPED_ACCOUNT_SETTINGS_KEYS,
    isDroppedLegacyServerSelectionKey,
} from './accountSettingsLegacyCleanup';
import { applyAccountSettingsPerEntryParsing } from './accountSettingsPerEntryParsers';

export function parseAccountSettings<TSettings extends Record<string, unknown>>(params: {
    settings: unknown;
    schema: z.ZodObject<z.ZodRawShape>;
    defaults: TSettings;
    supportedSchemaVersion: number;
    pruneResult: (settings: TSettings) => TSettings;
    debugEnabled: boolean;
    isDev: boolean;
}): TSettings {
    if (!params.settings || typeof params.settings !== 'object') {
        return { ...params.defaults };
    }

    const input = params.settings as Record<string, unknown>;
    const inputSchemaVersion = typeof input.schemaVersion === 'number' ? input.schemaVersion : params.supportedSchemaVersion;
    const result: Record<string, unknown> = { ...params.defaults };

    for (const key of Object.keys(params.schema.shape)) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) continue;

        if (applyAccountSettingsPerEntryParsing({
            key,
            value: input[key],
            result,
            context: {
                debug: params.debugEnabled,
                isDev: params.isDev,
            },
        })) {
            continue;
        }

        const schema = params.schema.shape[key] as z.ZodTypeAny;
        const parsedField = schema.safeParse(input[key]);
        if (parsedField.success) {
            result[key] = parsedField.data;
        } else if (params.isDev || params.debugEnabled) {
            console.warn(`[settingsParse] Invalid settings field "${String(key)}" - using default`, parsedField.error.issues);
            if (params.debugEnabled) {
                dbgSettings('settingsParse: invalid field', {
                    key: String(key),
                    issues: parsedField.error.issues.map((issue) => ({
                        path: issue.path,
                        code: issue.code,
                        message: issue.message,
                    })),
                });
            }
        }
    }

    const migrated = applyAccountSettingsCompatibilityMigrations({
        input,
        settings: result,
        inputSchemaVersion,
        supportedSchemaVersion: params.supportedSchemaVersion,
    }) as Record<string, unknown>;

    for (const [key, value] of Object.entries(input)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (isDroppedLegacyServerSelectionKey(key)) continue;
        if (DROPPED_ACCOUNT_SETTINGS_KEYS.has(key)) continue;
        if (!Object.prototype.hasOwnProperty.call(params.schema.shape, key)) {
            Object.defineProperty(migrated, key, {
                value,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
    }

    return params.pruneResult(migrated as TSettings);
}
