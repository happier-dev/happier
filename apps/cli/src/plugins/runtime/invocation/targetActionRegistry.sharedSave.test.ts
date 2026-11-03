import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';

import { createAccountPluginSecretCustodyRouter } from '../context/accountPluginSecretCustody';
import { createStableDeclaredPluginSecretsHost, type PluginSharedSaveAdmission } from '../context/secrets';
import { createTargetActionHostBindingResolver } from '../hostAccess/resolve';
import { createManagedPluginSourceCustody } from '../lifecycle/contributions/runtimeIdentity.testkit';
import type { PluginRuntimeOccurrenceId } from '../runtimeSlots';
import { createPluginInvocationServiceBinding, createPluginInvocationServicesFactory } from './services/factory';
import { createPluginInvocationSecretRedactor } from './services/logger';
import { createTargetActionInvocationRegistry } from './targetActionRegistry';

describe('reviewed shared-save Action admission', () => {
    it.each(['reviewed', 'normalized', 'mutatedPurpose', 'replay', 'cancel', 'stale', 'mismatch', 'proposedOnly', 'missingPurpose', 'wrongAudience', 'wrongId'] as const)(
        'uses real declaration and Account custody after %s admission', async scenario => {
            const pluginId = 'acme.shared-save';
            const occurrenceId = 'shared-save-1' as PluginRuntimeOccurrenceId;
            const controller = new AbortController();
            let currentOccurrence: string | null = occurrenceId;
            const snapshot = { source: 'network' as const, scopeKey: 'shared-save-account', settings: accountSettingsParse({}),
                settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] };
            const writes: Array<{ name: string; value: string; audience: unknown; createdByPlugin: unknown }> = [];
            const custody = createAccountPluginSecretCustodyRouter({
                owner: { readSnapshot: () => snapshot, async updateOnce() { throw new Error('Shared saves do not write Settings'); } },
                // Resource persistence is the boundary. Declaration routing,
                // audience comparison, currentness and redaction remain real.
                resources: { async create() { throw new Error('Shared saves do not create personal secrets'); }, async delete() {},
                    async createShared(input) {
                        input.assertCurrent();
                        writes.push({ name: input.name, value: input.value, audience: input.audience, createdByPlugin: input.createdByPlugin });
                        return { ref: 'happier:shared-secret:v1:reviewed-resource', resourceRevision: 1 };
                    } },
            });
            const secretRedactor = createPluginInvocationSecretRedactor();
            const services = createPluginInvocationServicesFactory({ secretRedactor, loggerSink: { write() {} },
                secrets: createStableDeclaredPluginSecretsHost({ resolveCustody: custody.resolve,
                    declarations: ['database', 'backup'].map(id => ({ pluginId, declaration: { id, custody: 'account' } })) }),
            });
            const reviewedInput = { id: 'database', purpose: scenario === 'missingPurpose' ? '' : 'data.connection',
                audience: { teamGrants: ['reviewed-team'] } };
            const input = scenario === 'normalized'
                ? { id: 'backup', purpose: 'proposed.purpose', audience: { teamGrants: ['proposed-team'] } }
                : reviewedInput;
            const admissions: Array<PluginSharedSaveAdmission | undefined> = [];
            let handlerRuns = 0;
            let approvals = 0;
            const registry = createTargetActionInvocationRegistry({
                actions: [{ pluginId, pluginVersion: '1.0.0', localId: 'save', occurrenceId,
                    sourceCustody: createManagedPluginSourceCustody('shared-save-generation'),
                    definition: { id: 'save', dangerLevel: scenario === 'proposedOnly' ? 'safe' : 'writesRemote', scopes: ['global'], surfaces: ['cli'],
                        ...(scenario === 'proposedOnly' ? {} : { confirmation: { title: 'Save generated connection' } }) },
                    ...(scenario === 'normalized' ? { inputParser: () => ({ success: true as const, data: reviewedInput }) } : {}),
                    async handler(handlerInput, context) {
                        handlerRuns++;
                        if (scenario === 'mutatedPurpose' && handlerInput !== null && typeof handlerInput === 'object' && !Array.isArray(handlerInput)) {
                            Reflect.set(handlerInput, 'purpose', 'unreviewed.purpose');
                        }
                        return await context.services.secrets.saveShared(scenario === 'wrongId' ? 'backup' : 'database', {
                            label: 'Generated connection', bytes: new TextEncoder().encode('generated-secret'),
                            audience: { teamGrants: [scenario === 'wrongAudience' ? 'unreviewed-team' : 'reviewed-team'] },
                        });
                    } }],
                createServices: (...args) => {
                    admissions.push(args[0].sharedSaveAdmission);
                    return services(...args);
                },
                resolveHostBinding: createTargetActionHostBindingResolver({ createServiceBinding: createPluginInvocationServiceBinding }),
                readCurrentPluginOccurrenceId: () => currentOccurrence,
                resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId,
                    desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
                    resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
            });
            try {
                const result = await registry.invoke({ pluginId, localId: 'save', input, surface: 'cli', signal: controller.signal,
                    ...(scenario === 'replay' ? { requireCurrentIntent: true, isApprovalRequiredByActionSettings: () => false } : {}),
                    requestCurrentIntent: async request => {
                        approvals++;
                        expect(request.action.input).toEqual(reviewedInput);
                        if (scenario === 'cancel') controller.abort();
                        if (scenario === 'stale') currentOccurrence = 'shared-save-replacement';
                        return { status: 'approved', fingerprint: scenario === 'mismatch' ? 'unrelated-reviewed-input' : request.fingerprint,
                            ...(scenario === 'replay' ? { artifactId: 'existing-approved-save' } : {}) };
                    },
                });
                expect(approvals).toBe(scenario === 'proposedOnly' ? 0 : 1);
                if (scenario === 'reviewed' || scenario === 'normalized' || scenario === 'mutatedPurpose' || scenario === 'replay') {
                    expect(result).toEqual({ status: 'executed', value: { ref: 'happier:shared-secret:v1:reviewed-resource', resourceRevision: 1 } });
                    expect(admissions.at(-1)).toMatchObject({ id: 'database', purpose: 'data.connection',
                        audience: { teamGrants: ['reviewed-team'] } });
                    expect(writes).toEqual([{ name: 'Generated connection', value: 'generated-secret',
                        audience: { accountGrants: [], teamGrants: ['reviewed-team'], groupGrants: [] }, createdByPlugin: { pluginId, secretId: 'database' } }]);
                } else {
                    expect(result.status).not.toBe('executed');
                    expect(writes).toEqual([]);
                    if (scenario === 'proposedOnly' || scenario === 'missingPurpose' || scenario === 'wrongAudience' || scenario === 'wrongId') {
                        expect(result).toMatchObject({ code: 'plugin_secret_save_not_admitted' });
                    } else expect(handlerRuns).toBe(0);
                }
            } finally { registry.dispose(); }
        },
    );
});
