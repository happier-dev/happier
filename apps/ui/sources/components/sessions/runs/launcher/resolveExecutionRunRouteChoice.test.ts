import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { resolveSessionRoutePresentation } from '@/providers/session/resolveSessionRoutePresentation';
import { t } from '@/text';

import { resolveExecutionRunRouteChoice } from './resolveExecutionRunRouteChoice';

const AGENT = 'agent:happier.agent.codex/codex';
const applied = { agentTargetKey: AGENT, providerConnectionId: ProviderConnectionIdSchema.parse('pc_gateway'), modelId: 'fable-5.1' };
const presentation = resolveSessionRoutePresentation({
    phase: 'running', selection: null, appliedSelection: applied,
    native: { label: 'Codex pool', authSource: 'connected', connectedCount: 1 },
    appliedProviderSource: { connectionId: 'pc_gateway', providerName: 'Main gateway', connectionName: 'Main gateway',
        connectionRole: 'default', connectionDisplayNameMode: 'automatic' },
});

describe('resolveExecutionRunRouteChoice', () => {
    it('includes the applied native pool in the inherited choice label', () => {
        const nativeSelection = { ...applied, providerConnectionId: null };
        const nativePresentation = resolveSessionRoutePresentation({
            phase: 'running', selection: null, appliedSelection: nativeSelection,
            native: { label: 'Work pool', authSource: 'connected', connectedCount: 1 },
        });
        expect(resolveExecutionRunRouteChoice({ inherits: true, inheritedSelection: nativeSelection, inheritedRoutePresentation: nativePresentation }))
            .toEqual({ label: `${t('runPage.menu.selectionInherited')} · Work pool · fable-5.1`, inheritDetail: 'Work pool · fable-5.1' });
    });
    it('names the parent model by its catalog title in both the chip and what inheriting means', () => {
        const nativeSelection = { ...applied, providerConnectionId: null, modelId: 'claude-haiku-4-5' };
        const nativePresentation = resolveSessionRoutePresentation({
            phase: 'running', selection: null, appliedSelection: nativeSelection,
            native: { label: 'Work pool', authSource: 'connected', connectedCount: 1 },
        });
        const choice = resolveExecutionRunRouteChoice({ inherits: true, inheritedSelection: nativeSelection,
            inheritedRoutePresentation: nativePresentation, inheritedModelLabel: 'Haiku 4.5' });
        expect(choice.inheritDetail).toBe('Work pool · Haiku 4.5');
        expect(choice.label).toBe(`${t('runPage.menu.selectionInherited')} · Work pool · Haiku 4.5`);
    });
    it('names the session route and model a new Run inherits', () => {
        expect(resolveExecutionRunRouteChoice({ inherits: true, inheritedSelection: applied, inheritedRoutePresentation: presentation }))
            .toEqual({
                label: `${t('runPage.menu.selectionInherited')} · Main gateway · fable-5.1`,
                inheritDetail: 'Main gateway · fable-5.1',
            });
    });

    it('names an applied Team model without representing it as a native Provider tuple', () => {
        const teamCredentialModel = { kind: 'team_credential_provider_model' as const,
            teamId: 'team-a', resourceId: 'resource-a', expectedResourceRevision: 0,
            deliveryMode: 'brokered' as const, agentTargetKey: AGENT, modelId: 'shared-model' };
        const { kind: _kind, ...ref } = teamCredentialModel;
        const teamPresentation = resolveSessionRoutePresentation({ phase: 'running', selection: null,
            appliedSelection: { source: 'team_resource', ...ref },
            native: { label: 'Native', authSource: 'native', connectedCount: 0 },
            teamSources: [{ teamId: 'team-a', resourceId: 'resource-a', displayName: 'Coding pool · Engineering' }],
        });
        expect(resolveExecutionRunRouteChoice({ inherits: true, inheritedSelection: null,
            inheritedTeamCredentialModel: teamCredentialModel, inheritedRoutePresentation: teamPresentation }))
            .toEqual({ label: `${t('runPage.menu.selectionInherited')} · Coding pool · Engineering · shared-model`,
                inheritDetail: 'Coding pool · Engineering · shared-model' });
    });

    it('says the Run has its own choice, and still shows what inheriting would mean', () => {
        expect(resolveExecutionRunRouteChoice({ inherits: false, inheritedSelection: applied, inheritedRoutePresentation: presentation }))
            .toEqual({ label: t('runPage.menu.selectionExplicit'), inheritDetail: 'Main gateway · fable-5.1' });
    });

    it('guesses nothing when the parent route is not known', () => {
        expect(resolveExecutionRunRouteChoice({ inherits: true, inheritedSelection: null, inheritedRoutePresentation: null }))
            .toEqual({ label: t('runPage.menu.selectionInherited'), inheritDetail: null });
    });
});
