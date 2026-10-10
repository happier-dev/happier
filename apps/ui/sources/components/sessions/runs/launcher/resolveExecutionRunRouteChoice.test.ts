import { describe, expect, it } from 'vitest';

import { resolveSessionRoutePresentation } from '@/providers/session/resolveSessionRoutePresentation';
import { t } from '@/text';

import { resolveExecutionRunRouteChoice } from './resolveExecutionRunRouteChoice';

const AGENT = 'agent:happier.agent.codex/codex';
const applied = { agentTargetKey: AGENT, providerConnectionId: 'pc_gateway', modelId: 'fable-5.1' };
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
    it('names the session route and model a new Run inherits', () => {
        expect(resolveExecutionRunRouteChoice({ inherits: true, inheritedSelection: applied, inheritedRoutePresentation: presentation }))
            .toEqual({
                label: `${t('runPage.menu.selectionInherited')} · Main gateway · fable-5.1`,
                inheritDetail: 'Main gateway · fable-5.1',
            });
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
