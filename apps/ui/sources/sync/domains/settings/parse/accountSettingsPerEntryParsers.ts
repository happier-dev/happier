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

    if (key === 'profiles') {
        if (Array.isArray(value)) {
            const parsedProfiles: Array<z.infer<typeof AIBackendProfileSchema>> = [];
            for (const rawProfile of value) {
                const parsedProfile = AIBackendProfileSchema.safeParse(rawProfile);
                if (parsedProfile.success) {
                    parsedProfiles.push(parsedProfile.data);
                } else {
                    logInvalidSettingEntry({
                        context,
                        key,
                        issues: parsedProfile.error.issues,
                        message: '[settingsParse] Dropping invalid profile entry',
                    });
                }
            }
            result.profiles = parsedProfiles;
        }
        return true;
    }

    if (key === 'secrets') {
        if (Array.isArray(value)) {
            const parsedSecrets: Array<z.infer<typeof SavedSecretSchema>> = [];
            for (const rawSecret of value) {
                const parsedSecret = SavedSecretSchema.safeParse(rawSecret);
                if (parsedSecret.success) {
                    parsedSecrets.push(parsedSecret.data);
                } else {
                    logInvalidSettingEntry({
                        context,
                        key,
                        issues: parsedSecret.error.issues,
                        message: '[settingsParse] Dropping invalid secret entry',
                    });
                }
            }
            result.secrets = parsedSecrets;
        }
        return true;
    }

    if (key === 'executionRunsGuidanceEntries') {
        if (Array.isArray(value)) {
            const parsedEntries: Array<z.infer<typeof ExecutionRunsGuidanceEntrySchema>> = [];
            for (const rawEntry of value) {
                const parsedEntry = ExecutionRunsGuidanceEntrySchema.safeParse(rawEntry);
                if (parsedEntry.success) {
                    parsedEntries.push(parsedEntry.data);
                } else {
                    logInvalidSettingEntry({
                        context,
                        key,
                        issues: parsedEntry.error.issues,
                        message: '[settingsParse] Dropping invalid executionRunsGuidance entry',
                    });
                }
            }
            result.executionRunsGuidanceEntries = parsedEntries;
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
