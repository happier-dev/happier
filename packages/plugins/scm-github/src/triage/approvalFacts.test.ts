import { describeApprovalRequestFields, formatApprovalFieldValues, getApprovalFieldValues, projectTargetActionApprovalInput } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import { GITHUB_TRIAGE_ACTION_IDS_V1, PLUGIN_MANIFEST } from '../manifest.js';

describe('GitHub Triage write approval facts', () => {
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
        const facts = (action.confirmation?.inputFields ?? []).flatMap(({ path, title }) => {
            const value = formatApprovalFieldValues(getApprovalFieldValues(projected.input, path));
            return value === null ? [] : [[resolvePluginLocalizedStringV2Text(title), value]];
        });
        expect({
            facts: Object.fromEntries(facts),
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
});
