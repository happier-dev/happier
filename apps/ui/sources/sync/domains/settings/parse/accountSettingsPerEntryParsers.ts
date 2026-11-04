import {
    ActionsSettingsV1Schema,
} from '@happier-dev/protocol';
import { z } from 'zod';

import { dbgSettings } from '../debugSettings';
import { AIBackendProfileSchema } from '../../profiles/profileCompatibility';
import { SavedSecretSchema } from '../savedSecretTypes';
import { voiceSettingsParse } from '../voiceSettings';
import {
    ExecutionRunsGuidanceEntrySchema,
} from '../registry/account/accountRuntimeSettingDefinitions';

type ParseContext = Readonly<{
    debug: boolean;
    isDev: boolean;
}>;

// Read projection and raw writeback must agree on which entries this client understands.
export const accountSettingsArrayEntrySchemas: ReadonlyMap<string, z.ZodType> = new Map<string, z.ZodType>([
    ['profiles', AIBackendProfileSchema],
    ['secrets', SavedSecretSchema],
    ['executionRunsGuidanceEntries', ExecutionRunsGuidanceEntrySchema],
]);

function logInvalidSettingEntry(params: {
    context: ParseContext;
    key: string;
    issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; code: string; message: string }>;
    message: string;
}) {
    if (!(params.context.isDev || params.context.debug)) return;

    console.warn(params.message, params.issues);
    if (params.context.debug) {
        dbgSettings('settingsParse: invalid special-case field', {
            key: params.key,
            issues: params.issues,
        });
    }
}

export function applyAccountSettingsPerEntryParsing(params: {
    key: string;
    value: unknown;
    result: Record<string, unknown>;
    context: ParseContext;
}): boolean {
    const { key, value, result, context } = params;

    const entrySchema = accountSettingsArrayEntrySchemas.get(key);
    if (entrySchema) {
        if (Array.isArray(value)) {
            const parsedEntries: unknown[] = [];
            for (const rawEntry of value) {
                const parsedEntry = entrySchema.safeParse(rawEntry);
                if (parsedEntry.success) {
                    parsedEntries.push(parsedEntry.data);
                } else {
                    logInvalidSettingEntry({
                        context,
                        key,
                        issues: parsedEntry.error.issues,
                        message: `[settingsParse] Omitting unreadable ${key} entry from the runtime projection`,
                    });
                }
            }
            result[key] = parsedEntries;
        }
        return true;
    }

    if (key === 'actionsSettingsV1') {
        const parsedActionsSettings = ActionsSettingsV1Schema.safeParse(value);
        if (parsedActionsSettings.success) {
            result.actionsSettingsV1 = parsedActionsSettings.data;
        }
        return true;
    }

    if (key === 'voice') {
        result.voice = voiceSettingsParse(value);
        return true;
    }

    return false;
}
