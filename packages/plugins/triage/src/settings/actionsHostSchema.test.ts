import { describe, expect, it } from 'vitest';

import { PluginError } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
} from '@happier-dev/plugin-sdk/manifest';
import type { ScopedSettingsService } from '@happier-dev/plugin-sdk/settings';
import { PluginSettingsContributionV2Schema } from '@happier-dev/protocol';

import { TRIAGE_ACTIONS_SETTINGS_CONTRIBUTION_V1 } from './actionsContribution.js';
import {
    TRIAGE_ACTIONS_SETTING_ID_V1,
    TRIAGE_DEFAULT_ACTIONS_V1,
    mutateTriageAction,
    parseTriageActions,
    readTriageActions,
} from './actions.js';
import { createTestkitAccountSettings } from './testkit/accountSettings.test-support.js';

/**
 * The write the editor really makes, crossing the REAL host Settings validator.
 *
 * Every focused test in `actions.test.ts` stops at the plugin's own reader: it
 * proves `settings/actions.ts` agrees with itself. Nothing proved that the
 * value that owner emits is admitted by the schema this plugin DECLARES, and
 * the host compiles that declaration with `compilePluginJsonSchema` and refuses
 * a `set` whose value fails it (`plugin_settings_validation_failed`,
 * `apps/cli/src/plugins/runtime/invocation/services/settings.ts`). A member the
 * declaration omits is therefore not a documentation gap — it makes the write
 * unstorable, with a perfectly valid catalog in front of the person.
 *
 * The validator here is the host's own, not a copy of its rules: the same
 * `compilePluginJsonSchema`/`isValidPluginJsonSchemaValue` pair the daemon
 * compiles the declared field with, applied to the exact declared schema.
 */

const declaredField = TRIAGE_ACTIONS_SETTINGS_CONTRIBUTION_V1.fields[0]!;
const validateDeclaredValue = compilePluginJsonSchema(declaredField.schema);

/**
 * A Settings service that refuses exactly what the host refuses.
 *
 * The shared testkit stands in for persistence and revision, which is the real
 * boundary; it does not know this plugin's declaration. Wrapping its `set` with
 * the compiled declared schema is what makes a write here fail for the same
 * reason it would fail on a daemon.
 */
function hostValidatingSettings(
    settings: ScopedSettingsService,
): Pick<ScopedSettingsService, 'snapshot' | 'set'> {
    return {
        snapshot: (options) => settings.snapshot(options),
        set: async (id, value, options) => {
            if (id === TRIAGE_ACTIONS_SETTING_ID_V1
                && !isValidPluginJsonSchemaValue(validateDeclaredValue, value)) {
                throw new PluginError({
                    code: 'plugin_settings_validation_failed',
                    message: `Plugin setting '${id}' failed schema validation`,
                });
            }
            return await settings.set(id, value, options);
        },
    };
}

describe('the declared triage.actions field and its one owner', () => {
    it('is a declaration the host settings model accepts', () => {
        expect(
            PluginSettingsContributionV2Schema.safeParse(
                JSON.parse(JSON.stringify(TRIAGE_ACTIONS_SETTINGS_CONTRIBUTION_V1)),
            ).success,
        ).toBe(true);
    });

    it('admits the exact value the owner writes for the shipped seed', async () => {
        const account = createTestkitAccountSettings();
        const result = await mutateTriageAction({
            settings: hostValidatingSettings(account.settings),
            mintActionId: () => 'minted',
        }, {
            kind: 'update',
            expectedRevision: account.revision(),
            actionId: 'review',
            label: 'Review',
            enabled: true,
            appliesTo: ['pullRequest'],
            profileId: null,
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
        });

        expect(result.status).toBe('applied');
        // Stored, and readable back as itself: a value the host admits but this
        // build cannot re-read would be the same defect facing the other way.
        expect(parseTriageActions(account.read(TRIAGE_ACTIONS_SETTING_ID_V1)).kind).toBe('parsed');
    });

    it('admits a review action configured with a prompt reference', async () => {
        const account = createTestkitAccountSettings();
        const result = await mutateTriageAction({
            settings: hostValidatingSettings(account.settings),
            mintActionId: () => 'minted',
        }, {
            kind: 'create',
            expectedRevision: account.revision(),
            label: 'Review with my instructions',
            enabled: true,
            appliesTo: ['pullRequest'],
            profileId: 'profile-1',
            workspaceMode: 'pull_request',
            target: { kind: 'reviewStart', promptInvocationId: 'invocation-1' },
        });

        expect(result.status).toBe('applied');
        const stored = account.read(TRIAGE_ACTIONS_SETTING_ID_V1) as JsonValue;
        expect(isValidPluginJsonSchemaValue(validateDeclaredValue, stored)).toBe(true);
    });

    it('admits every action the owner ships as its seed', async () => {
        const account = createTestkitAccountSettings();
        const settings = hostValidatingSettings(account.settings);
        for (const seeded of TRIAGE_DEFAULT_ACTIONS_V1) {
            const result = await mutateTriageAction({
                settings,
                mintActionId: () => seeded.actionId,
            }, {
                kind: 'update',
                expectedRevision: account.revision(),
                actionId: seeded.actionId,
                label: seeded.label,
                enabled: seeded.enabled,
                appliesTo: seeded.appliesTo,
                profileId: seeded.profileId,
                workspaceMode: seeded.workspaceMode,
                target: seeded.target,
            });
            expect([seeded.actionId, result.status]).toEqual([seeded.actionId, 'applied']);
        }
        const read = await readTriageActions({ settings: account.settings });
        expect(read.kind).toBe('parsed');
    });
});
