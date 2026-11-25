import { expect, it } from 'vitest';
import { t } from '@/text';
import { presentReviewLauncherReviewer } from './reviewLauncherReviewerPresentation';
import { resolveExecutionRunLauncherBackendChoices } from './resolveExecutionRunLauncherBackendChoices';

it('presents the account choice for an engine without a runner or selectable models', () => {
    const choices = resolveExecutionRunLauncherBackendChoices({ intent: 'review', enabledAgentIds: ['coderabbit'], executionRunsBackends: {},
        reviewEngines: [{ engineId: 'coderabbit', value: 'agent:happier.review.coderabbit/coderabbit', label: 'CodeRabbit', enabled: true,
            available: true, capabilities: { structuredNarration: false } }] });
    const reviewer = { kind: 'engine' as const, engineId: 'coderabbit' };
    expect(presentReviewLauncherReviewer(reviewer, 0, [reviewer], choices[0]!).subtitle)
        .toBe(t('connectedServices.authModal.nativeAuthTitle'));
    const connected = { ...reviewer, connectedServices: { v: 2 as const, bindingsByServiceId: {
        'happier.review.coderabbit/coderabbit-account': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
    } } };
    expect(presentReviewLauncherReviewer(connected, 0, [connected], choices[0]!).subtitle)
        .toBe(t('settings.connectedAccounts'));
});

it('names the unset runner model with the grid owner’s CLI settings choice', () => {
    const choices = resolveExecutionRunLauncherBackendChoices({ intent: 'review', enabledAgentIds: ['codex'], executionRunsBackends: {},
        reviewEngines: [{ engineId: 'codex', value: 'agent:happier.agent.codex/codex', label: 'Codex', enabled: true,
            available: true, capabilities: { structuredNarration: false } }] });
    const reviewer = { kind: 'engine' as const, engineId: 'codex' };
    expect(presentReviewLauncherReviewer(reviewer, 0, [reviewer], choices[0]!).subtitle)
        .toBe(`Codex · ${t('agentInput.model.useCliSettings')}`);
});
