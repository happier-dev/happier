import { describe, expect, it } from 'vitest';

import { describeRoleRowFacts, describeRoleSource } from './rolePresentation';
import { t } from '@/text';

describe('role source presentation', () => {
    it('names a plugin by its admitted display name rather than its opaque id', () => {
        const entry = { source: 'plugin' as const, pluginId: 'com.example.roles', pluginDisplayName: 'Example tools' };
        const label = describeRoleSource(entry);
        expect(label).toContain(entry.pluginDisplayName);
        expect(label).not.toContain(entry.pluginId);
    });
});

describe('role row facts', () => {
    const session = { kind: 'session' } as const;
    const engine = { agentTargetKey: 'backend:gone:configured:gone' };

    it('says to choose an engine when the role names one this Account has not enabled', () => {
        const line = describeRoleRowFacts({ roleId: 'writer', role: { engine, runsAs: session } }, { label: 'gone-model', unavailable: true });
        expect(line).toContain('gone-model');
        expect(line).toContain(t('roles.rail.chooseEngine'));
    });

    it('stays quiet about an engine the catalog can run, and about a role that pins none', () => {
        expect(describeRoleRowFacts({ roleId: 'writer', role: { engine, runsAs: session } }, { label: 'Claude', unavailable: false }))
            .not.toContain(t('roles.rail.chooseEngine'));
        expect(describeRoleRowFacts({ roleId: 'writer', role: { runsAs: session } }, { label: null, unavailable: false }))
            .toBe(t('roles.settings.runsAsSession'));
    });

    it('says the Orchestrator runs as this session rather than a runs-as it cannot change', () => {
        expect(describeRoleRowFacts({ roleId: 'orchestrator', role: { runsAs: session } }, { label: null, unavailable: false }))
            .toBe(t('roles.session.thisSession'));
    });
});
