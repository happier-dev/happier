import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { AccountSettingMutationV1Schema, applyAccountSettingMutationV1 } from '../../account/settings/accountSettingMutationV1.js';
import { SettingsDeclarationActionInputSchemasV1, SettingsDeclarationMutationReversalV1Schema } from '../settingsDeclarationActionFamily.js';
import { scmGitRoutingStorage } from './accountSettingBindings.js';
import { captureSettingMutationV1, restoreSettingMutationV1 } from './settingMutationReversal.js';

describe('bound setting mutation receipts', () => {
    it('restores the released commit-message Agent choice after a captured runner mutation', () => {
        const raw = { scmCommitMessageGeneratorBackendId: 'codex' };
        const mutation = AccountSettingMutationV1Schema.parse({ operations: [
            { op: 'set', key: 'scmCommitMessageGeneratorRunnerV1', value: { v: 1, mode: 'auto' } },
        ] });
        const applied = applyAccountSettingMutationV1(raw, mutation);
        const captured = captureSettingMutationV1(raw, mutation);
        if (applied.status === 'invalid' || !captured) throw new Error('Expected captured runner mutation');
        const receipt = SettingsDeclarationMutationReversalV1Schema.parse({ scope: { serverId: 'home', accountId: 'account' },
            beforeVersion: 1, appliedVersion: 2, ...captured });
        const reversal = restoreSettingMutationV1(applied.raw, mutation, { kind: 'restore', ...receipt });
        if (reversal.status !== 'prepared') throw new Error('Expected runner reversal');
        const restored = applyAccountSettingMutationV1(applied.raw, reversal.mutation);
        expect(restored).toEqual({ status: 'applied', raw: {
            scmCommitMessageGeneratorRunnerV1: accountSettingsParse(raw).scmCommitMessageGeneratorRunnerV1,
        } });
    });

    it('resets compound bound keys without historical receipt versions and refuses substituted or changed keys', () => {
        const delta = scmGitRoutingStorage.mutate(accountSettingsParse({}), 'happier.scm.backend.git/git');
        if (!delta) throw new Error('Routing default must be admitted');
        const mutation = AccountSettingMutationV1Schema.parse({ operations: Object.keys(delta).map(key => ({ op: 'reset', key })) });
        const raw = { favoriteMachines: ['concurrent'], scmGitRepoPreferredBackend: 'plugin',
            scmGitRepoPreferredBackendQualifiedId: 'external.scm/backend' };
        const request = SettingsDeclarationActionInputSchemasV1['settings.reset'].parse({ anchor: 'sourceControl.gitRouting', expected: {
            changes: [
                { key: 'scmGitRepoPreferredBackend', applied: { value: 'plugin' } },
                { key: 'scmGitRepoPreferredBackendQualifiedId', applied: { value: 'external.scm/backend' } },
            ],
        } });
        if (!request.expected) throw new Error('Expected conditional reset');
        const restore = restoreSettingMutationV1(raw, mutation, { kind: 'reset', expected: request.expected });
        expect(restore.status).toBe('prepared');
        if (restore.status !== 'prepared') throw new Error('Expected reset');
        expect(applyAccountSettingMutationV1(raw, restore.mutation)).toMatchObject({ status: 'applied', raw: { favoriteMachines: ['concurrent'] } });
        expect(restoreSettingMutationV1({ ...raw, scmGitRepoPreferredBackend: 'git' }, mutation,
            { kind: 'reset', expected: request.expected })).toEqual({ status: 'conflict' });
        expect(restoreSettingMutationV1(raw, mutation, { kind: 'reset', expected: { changes: [
            { key: 'favoriteMachines', applied: { value: ['concurrent'] } },
        ] } })).toEqual({ status: 'invalid' });
    });
    it('applies the canonical nested reset mutation without removing its owning object', () => {
        const raw = { voice: { enabled: true, assistantLanguage: 'fr' } };
        const mutation = AccountSettingMutationV1Schema.parse({ operations: [{ op: 'set', key: 'voice',
            value: { enabled: false, assistantLanguage: 'fr' } }] });
        const reset = restoreSettingMutationV1(raw, mutation, { kind: 'reset', expected: { value: raw.voice } });
        expect(reset.status).toBe('prepared');
        if (reset.status !== 'prepared') throw new Error('Expected nested reset');
        expect(applyAccountSettingMutationV1(raw, reset.mutation)).toMatchObject({ status: 'applied',
            raw: { voice: { enabled: false, assistantLanguage: 'fr' } } });
    });
    it('compares a conditional reset against the declaration leaf rather than its storage object', () => {
        const homeAtmosphere = accountSettingsParse({}).homeAtmosphere;
        const raw = { homeAtmosphere: { ...homeAtmosphere, planet: { ...homeAtmosphere.planet, digits: false } } };
        const mutation = AccountSettingMutationV1Schema.parse({ operations: [{ op: 'set', key: 'homeAtmosphere',
            value: { ...homeAtmosphere, planet: { ...homeAtmosphere.planet, digits: true } } }] });
        const readDigits = (settings: Readonly<Record<string, unknown>>) => accountSettingsParse(settings).homeAtmosphere.planet.digits;
        expect(restoreSettingMutationV1(raw, mutation, { kind: 'reset', expected: { value: false } }, readDigits))
            .toEqual({ status: 'prepared', mutation });
        expect(restoreSettingMutationV1({ homeAtmosphere: { ...homeAtmosphere, planet: { ...homeAtmosphere.planet, digits: true } } },
            mutation, { kind: 'reset', expected: { value: false } }, readDigits)).toEqual({ status: 'conflict' });
    });
    it('does not disclose a nested SecretString through an otherwise readable object setting receipt', () => {
        const voice = { enabled: false, retained: { apiKey: { _isSecretValue: true, value: 'test-only-secret' } } };
        const mutation = AccountSettingMutationV1Schema.parse({ operations: [{ op: 'set', key: 'voice', value: { ...voice, enabled: true } }] });
        expect(captureSettingMutationV1({ voice }, mutation)).toBeNull();
        const clean = AccountSettingMutationV1Schema.parse({ operations: [{ op: 'set', key: 'voice', value: { enabled: true } }] });
        expect(captureSettingMutationV1({}, clean, { voice })).toBeNull();
        const receipt = SettingsDeclarationMutationReversalV1Schema.parse({ scope: { serverId: 'home', accountId: 'account' },
            beforeVersion: 1, appliedVersion: 2, before: { value: voice }, applied: { value: { ...voice, enabled: true } } });
        expect(restoreSettingMutationV1({ voice: { ...voice, enabled: true } }, mutation, receipt)).toEqual({ status: 'invalid' });
    });
    it('restores the real compound producer across unrelated changes and rejects affected-key drift or substituted keys', () => {
        const baseline = { favoriteMachines: ['original'] };
        const delta = scmGitRoutingStorage.mutate(accountSettingsParse(baseline), 'happier.scm.backend.sapling/sapling');
        if (!delta) throw new Error('Routing intent must be admitted');
        const mutation = AccountSettingMutationV1Schema.parse({ operations: Object.entries(delta).map(([key, value]) => ({ op: 'set', key, value })) });
        const captured = captureSettingMutationV1(baseline, mutation);
        expect(captured).not.toBeNull();
        const receipt = SettingsDeclarationMutationReversalV1Schema.parse({ scope: { serverId: 'home', accountId: 'account' },
            beforeVersion: 1, appliedVersion: 2, ...captured });
        const applied = applyAccountSettingMutationV1(baseline, mutation);
        if (applied.status === 'invalid') throw new Error(applied.reason);
        const concurrent = { ...applied.raw, favoriteMachines: ['concurrent'] };
        // Host Action inputs carry this discriminator in addition to the captured receipt.
        const restoreInput = { kind: 'restore' as const, ...receipt };
        const restore = restoreSettingMutationV1(concurrent, mutation, restoreInput);
        expect(restore.status).toBe('prepared');
        if (restore.status !== 'prepared') throw new Error('Expected restore');
        expect(applyAccountSettingMutationV1(concurrent, restore.mutation)).toMatchObject({ status: 'applied', raw: { favoriteMachines: ['concurrent'] } });
        const first = mutation.operations[0];
        if (!first || !('changes' in receipt)) throw new Error('Expected compound receipt');
        expect(restoreSettingMutationV1({ ...concurrent, [first.key]: 'different' }, mutation, receipt)).toEqual({ status: 'conflict' });
        const substituted = { ...receipt, changes: receipt.changes.map((change, index) => index === 0
            ? { key: 'favoriteMachines', before: { value: ['unwanted'] }, applied: { value: ['concurrent'] } } : change) };
        expect(restoreSettingMutationV1(concurrent, mutation, SettingsDeclarationMutationReversalV1Schema.parse(substituted)))
            .toEqual({ status: 'invalid' });
    });
});
