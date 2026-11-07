import { describe, expect, it } from 'vitest';
import { buildUiFeatureToggleChange, buildUiFeatureToggleDefaults, getUiFeatureDefinition,
    listUiFeatureToggleDefinitions, resolveUiFeatureToggleEnabled } from './featurePreferenceMutations.js';
import { evaluateFeatureDecisionBase } from '../../features/featureDecisionEngine.js';
import { getActionRequiredServerFeatureId } from '../actionRequiredServerFeature.js';

describe('Account feature opt-outs', () => {
    it.each(['deployments', 'bots', 'browser', 'search', 'sessions.conversations', 'sessions.board',
        'sessions.following', 'teams', 'providers.localDiscovery', 'devices'] as const)(
        '%s defaults on and its Account opt-out reaches the canonical decision', featureId => {
            expect(resolveUiFeatureToggleEnabled({}, featureId)).toBe(true);
            const settings = buildUiFeatureToggleChange({}, featureId, false);
            expect(evaluateFeatureDecisionBase({ featureId, scope: { scopeKind: 'runtime' },
                supportsClient: true, buildPolicy: 'neutral', serverSupported: true, serverEnabled: true,
                localPolicyEnabled: resolveUiFeatureToggleEnabled(settings, featureId) })).toMatchObject({
                state: 'disabled', blockedBy: 'local_policy', blockerCode: 'flag_disabled',
            });
        });
    it.each([
        ['deployments.prepare', 'deployments'], ['deployments.deploy', 'deployments'],
        ['deployments.publish.prepare', 'deployments'],
        ['deployments.targets.link', 'deployments'], ['template.draft', 'bots'],
        ['template.release', 'bots'], ['template.instantiate', 'bots'], ['template.updates.apply', 'bots'],
        ['session.bot.set', 'bots'],
    ] as const)('%s consumes the %s availability decision', (actionId, featureId) => {
        expect(getActionRequiredServerFeatureId(actionId)).toBe(featureId);
    });
    it.each(['deployments.receipts.get', 'deployments.receipts.observe', 'deployments.environments.get',
        'deployments.targets.unlink', 'deployments.environments.delete', 'deployments.teardown', 'deployments.cancel',
        'template.open', 'template.preview', 'template.follow.stop'])(
        '%s remains available for reading or recovery', actionId => {
            expect(getActionRequiredServerFeatureId(actionId)).toBeNull();
        });
    it('allows withdrawing the Bot marker after Bots are disabled', () => {
        expect(getActionRequiredServerFeatureId('session.bot.set', undefined, { bot: null })).toBeNull();
    });
});

it('keeps compact Usage representation support out of Account preferences and rendered feature controls', () => {
    expect(getUiFeatureDefinition('usage.compactBatch').settingsToggle).toBeUndefined();
    expect(resolveUiFeatureToggleEnabled({ featureToggles: { 'usage.compactBatch': false } }, 'usage.compactBatch')).toBe(true);
    expect(listUiFeatureToggleDefinitions().some(definition => definition.featureId === 'usage.compactBatch')).toBe(false);
    expect(buildUiFeatureToggleDefaults({ experimentalOnly: false })).not.toHaveProperty('usage.compactBatch');
});

describe('Workflows preference compatibility', () => {
    it('preserves the released preference as a fallback, with one canonical control and write', () => {
        const legacy = { featureToggles: { automations: false } };
        expect(resolveUiFeatureToggleEnabled(legacy, 'workflows')).toBe(false);
        expect(resolveUiFeatureToggleEnabled(legacy, 'automations')).toBe(false);
        const updated = buildUiFeatureToggleChange(legacy, 'automations', true);
        expect(updated.featureToggles).toEqual({ automations: true });
        expect(resolveUiFeatureToggleEnabled(updated, 'automations')).toBe(true);
        expect(buildUiFeatureToggleChange(updated, 'workflows', false).featureToggles).toEqual({ automations: false });
        const controls = listUiFeatureToggleDefinitions().filter(row => row.featureId === 'automations' || row.featureId === 'workflows');
        expect(controls.map(row => row.featureId)).toEqual(['workflows']);
    });
});
