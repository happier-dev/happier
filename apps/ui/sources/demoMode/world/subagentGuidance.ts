import type { Settings } from '@/sync/domains/settings/settings';

/**
 * A5 "One session. A whole team of agents."
 *
 * The sub-agent settings screen only shows the delegation model once the
 * execution-runs substrate is on AND guidance rules exist; with an empty rule
 * list it renders its own "no rules yet" stub under a headline about a team of
 * agents. These are the rules the stage shows, written the way a real team
 * would write them: which kind of job leaves the session, and who picks it up.
 */
export function buildDemoSubagentGuidanceEntries(): Settings['executionRunsGuidanceEntries'] {
    return [
        {
            id: 'demo-guidance-review',
            title: 'Send diffs out for a second opinion',
            description:
                'Before proposing a large change, delegate a review pass to a different agent and fold its findings back into this session.',
            enabled: true,
            suggestedIntent: 'review',
            suggestedBackendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        },
        {
            id: 'demo-guidance-research',
            title: 'Delegate wide code searches',
            description:
                'Repository-wide searches and dependency archaeology go to a delegate so the main session keeps its context for the change itself.',
            enabled: true,
            suggestedIntent: 'delegate',
            suggestedBackendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        },
        {
            id: 'demo-guidance-plan',
            title: 'Plan migrations before touching files',
            description:
                'Multi-package migrations start with a planning run that lists the owners and the order of the edits; implementation only starts once that plan comes back.',
            enabled: true,
            suggestedIntent: 'plan',
            suggestedBackendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
        },
    ];
}
