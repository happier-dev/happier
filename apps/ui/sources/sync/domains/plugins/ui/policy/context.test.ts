import { describe, expect, it } from 'vitest';

import { createPluginUiSessionPolicyEvaluationContext } from './context';
import { evaluatePluginUiPolicy } from './evaluate';
import { createPluginUiProjectPolicyEvaluationContext } from './projectContext';

it('adds canonical Project policy facts while preserving other host-owned facts', () => {
    const context = createPluginUiProjectPolicyEvaluationContext({ platform: 'web', data: { plugin: { enabled: true }, project: { id: 'stale' } } },
        { kind: 'project', projectKey: 'logical-project', repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' } });
    expect(evaluatePluginUiPolicy({ availability: { when: { all: [
        { fact: 'plugin.enabled', operator: 'equals', value: true },
        { fact: 'project.id', operator: 'equals', value: 'logical-project' },
        { fact: 'project.repository.kind', operator: 'equals', value: 'github' },
    ] } } }, context)).toMatchObject({ visible: true, enabled: true });
});

describe('createPluginUiSessionPolicyEvaluationContext', () => {
    it('projects the exact mounted Session facts into canonical availability evaluation', () => {
        const context = createPluginUiSessionPolicyEvaluationContext({
            platform: 'web',
            channel: 'internal',
            isFeatureEnabled: (id) => id === 'sessions.handoff',
        }, {
            pluginEnabled: true,
            sessionAgentId: 'happier.agent.codex',
            sessionState: 'waiting',
            machineId: 'machine-b',
            projectId: 'project-1',
            browserExists: false,
        });

        expect(evaluatePluginUiPolicy({
            availability: {
                when: {
                    all: [
                        { fact: 'plugin.enabled', operator: 'equals', value: true },
                        { fact: 'session.exists', operator: 'equals', value: true },
                        { fact: 'session.agentId', operator: 'equals', value: 'happier.agent.codex' },
                        { fact: 'session.state', operator: 'equals', value: 'waiting' },
                        { fact: 'machine.id', operator: 'equals', value: 'machine-b' },
                        { fact: 'project.exists', operator: 'equals', value: true },
                        { fact: 'project.id', operator: 'equals', value: 'project-1' },
                        { fact: 'browser.exists', operator: 'equals', value: false },
                        { fact: 'host.feature', operator: 'enabled', value: 'sessions.handoff' },
                    ],
                },
            },
        }, context)).toMatchObject({ visible: true, enabled: true });
    });

    it('leaves unavailable Session capabilities unknown instead of inventing support', () => {
        const context = createPluginUiSessionPolicyEvaluationContext({}, {
            pluginEnabled: true,
            sessionAgentId: null,
            sessionState: null,
            machineId: null,
            projectId: null,
            browserExists: false,
        });

        expect(evaluatePluginUiPolicy({
            availability: {
                when: { fact: 'session.capability', operator: 'contains', value: 'message.edit' },
            },
        }, context)).toMatchObject({
            visible: false,
            enabled: false,
            diagnostics: ['availability_fact_unavailable'],
        });
    });
});
