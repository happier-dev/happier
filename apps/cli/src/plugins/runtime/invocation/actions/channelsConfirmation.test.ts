import { describe, expect, it } from 'vitest';

import { PluginActionContributionV2Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { pluginActionRequiresPresentUserIntent } from '@happier-dev/protocol/plugins/actions/invocation';

import { PLUGIN_MANIFEST } from '../../../../../../../packages/plugins/channels/src/manifest.js';

function declaredAction(id: string) {
    const declaration = PLUGIN_MANIFEST.contributes?.actions?.find((action) => action.id === id);
    expect(declaration, id).toBeDefined();
    return PluginActionContributionV2Schema.parse(declaration);
}

describe('Channels management confirmation through the host policy owner', () => {
    it.each([
        'connection/create-v1',
        'connection/update-v1',
        'connection/poll-retry-v1',
        'connection/setup-remediate-v1',
        'ingress/retry-v1',
        'stream/notice-dismiss-v1',
        'binding/session-projection-notice-dismiss-v1',
    ])('lets a person invoke reversible %s directly while preserving automated approval policy', (id) => {
        const action = declaredAction(id);
        expect(pluginActionRequiresPresentUserIntent(action, 'ui', undefined, 'present_user')).toBe(false);
        expect(pluginActionRequiresPresentUserIntent(action, 'ui', undefined, 'account_automation')).toBe(true);
        // Provider setup remediation repairs remote state and retains CLI Ask.
        expect(pluginActionRequiresPresentUserIntent(action, 'cli', undefined, 'account_automation'))
            .toBe(id === 'connection/setup-remediate-v1');
        for (const surface of ['agent', 'mcp']) {
            expect(pluginActionRequiresPresentUserIntent(action, surface, undefined, 'account_automation')).toBe(true);
        }
        expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: true },
            'ui', undefined, 'present_user')).toBe(true);
    });

    it.each([
        ['binding/create-v1', {}],
        ['binding/create-v1', { enabled: false }],
        ['binding/update-v1', { enabled: false }],
    ] as const)('saves a paused %s without a second own-UI decision (%j)', (id, input) => {
        const action = declaredAction(id);
        expect(pluginActionRequiresPresentUserIntent(action, 'ui', input, 'present_user')).toBe(false);
        expect(pluginActionRequiresPresentUserIntent(action, 'ui', input, 'account_automation')).toBe(true);
        expect(pluginActionRequiresPresentUserIntent(action, 'agent', input, 'account_automation')).toBe(true);
        expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: true },
            'ui', input, 'present_user')).toBe(true);
    });

    it.each(['binding/create-v1', 'binding/update-v1'])('uses the in-flow own-UI decision for %s while automation and Ask remain held', (id) => {
        const action = declaredAction(id);
        const input = { enabled: true };
        expect(pluginActionRequiresPresentUserIntent(action, 'ui', input, 'present_user')).toBe(false);
        expect(pluginActionRequiresPresentUserIntent(action, 'ui', undefined, 'present_user')).toBe(false);
        // Routing an agent/plugin-initiated change through UI does not give it
        // the person's authority or consume the person's in-flow decision.
        expect(pluginActionRequiresPresentUserIntent(action, 'ui', input, 'account_automation')).toBe(true);
        expect(pluginActionRequiresPresentUserIntent(action, 'agent', input, 'account_automation')).toBe(true);
        expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: true },
            'ui', input, 'present_user')).toBe(true);
    });

    it('changes own-UI binding enablement directly while automation and Ask remain held', () => {
        const action = declaredAction('binding/set-enabled-v1');
        const input = { bindingId: 'binding-1', expectedRevision: 1, enabled: false };
        expect(pluginActionRequiresPresentUserIntent(action, 'ui', input, 'present_user')).toBe(false);
        expect(pluginActionRequiresPresentUserIntent(action, 'ui', { ...input, enabled: true }, 'present_user')).toBe(false);
        expect(pluginActionRequiresPresentUserIntent(action, 'ui', undefined, 'present_user')).toBe(false);
        expect(pluginActionRequiresPresentUserIntent(action, 'ui', { ...input, enabled: true }, 'account_automation')).toBe(true);
        expect(pluginActionRequiresPresentUserIntent(action, 'agent', input, 'account_automation')).toBe(true);
        expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: true },
            'ui', input, 'present_user')).toBe(true);
    });

    it.each([
        ['connection/delete-v1', true],
        ['binding/delete-v1', true],
        ['connection/transfer-v1', true],
        ['connection/update-v1', false],
    ] as const)('uses the declared consequence for CLI %s (Ask: %s)', (id, requiresConfirmation) => {
        expect(pluginActionRequiresPresentUserIntent(declaredAction(id), 'cli', undefined, 'account_automation'))
            .toBe(requiresConfirmation);
    });

    it.each([
        'connection/delete-v1',
        'connection/transfer-v1',
    ])('retains a person’s confirmation for irreversible %s', (id) => {
        expect(pluginActionRequiresPresentUserIntent(declaredAction(id), 'ui', undefined, 'present_user')).toBe(true);
    });
});
