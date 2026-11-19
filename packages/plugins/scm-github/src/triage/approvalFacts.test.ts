import { describeApprovalRequestFields, formatApprovalFieldValues, getApprovalFieldValues, projectTargetActionApprovalInput } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import { JIRA_ACTIONS } from '../../../jira/src/contracts.js';
import { PLUGIN_MANIFEST as JIRA_MANIFEST } from '../../../jira/src/manifest.js';
import { LINEAR_ACTIONS } from '../../../linear/src/contracts.js';
import { PLUGIN_MANIFEST as LINEAR_MANIFEST } from '../../../linear/src/manifest.js';
import { GITHUB_TRIAGE_ACTION_IDS_V1, PLUGIN_MANIFEST } from '../manifest.js';

function reviewFacts(action: (typeof PLUGIN_MANIFEST.contributes.actions)[number], input: unknown) {
    const facts = (action.confirmation?.inputFields ?? []).flatMap(({ path, title }) => {
        const value = formatApprovalFieldValues(getApprovalFieldValues(input, path));
        return value === null ? [] : [[resolvePluginLocalizedStringV2Text(title), value]];
    });
    return Object.fromEntries(facts);
}

describe('Triage write approval facts', () => {
    it('shows the repository, Account and supplied issue fields without exposing source configuration', () => {
        const action = PLUGIN_MANIFEST.contributes.actions.find(({ id }) => id === GITHUB_TRIAGE_ACTION_IDS_V1.create)!;
        const token = 'private-source-configuration-sentinel';
        const input = {
            v: 1,
            instance: {
                ...createTriageSourceV1Fixture().configuredInstance,
                locator: { v: 1, displayLabel: 'Octo Release Account' },
                configuration: { v: 1, token },
            },
            kindId: 'issue',
            fields: { scopeId: 'octo/example', title: 'Fix launch', body: 'Steps to reproduce', assigneeIds: ['octocat'], labelIds: ['bug'] },
        };
        const projected = projectTargetActionApprovalInput(input, action.secretInputPaths ?? [])!;
        const facts = reviewFacts(action, projected.input);
        expect({
            facts,
            approvalInputContainsToken: JSON.stringify(projected.input).includes(token),
            approvalDetailsContainToken: JSON.stringify(describeApprovalRequestFields({
                kind: 'plugin_target_action', input: projected.input, secretInputPaths: action.secretInputPaths, approvalInputCustody: 'live_only',
            })).includes(token),
        }).toEqual({
            facts: {
                Repository: 'octo/example',
                'Connected Account': 'Octo Release Account',
                Title: 'Fix launch',
                Description: 'Steps to reproduce',
                Assignees: 'octocat',
                Labels: 'bug',
            },
            approvalInputContainsToken: false,
            approvalDetailsContainToken: false,
        });
    });

    it('shows the Jira issue key on a comment approval', () => {
        const action = JIRA_MANIFEST.contributes.actions.find(({ id }) => id === JIRA_ACTIONS.comment)!;
        const input = { entry: { lastKnownLocator: { displayPath: 'OPS-42' } }, body: 'Deployment verified' };
        expect(reviewFacts(action, input)).toMatchObject({ Issue: 'OPS-42', Comment: 'Deployment verified' });
    });

    it('shows the Linear issue identifier on an edit approval', () => {
        const action = LINEAR_MANIFEST.contributes.actions.find(({ id }) => id === LINEAR_ACTIONS.edit)!;
        const input = { lastKnownLocator: { displayPath: 'APP-21' }, fields: { title: 'Fix workspace launch' } };
        expect(reviewFacts(action, input)).toMatchObject({ Issue: 'APP-21', Title: 'Fix workspace launch' });
    });
});
