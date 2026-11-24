import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { TeamCredentialExternalApiKeySummaryV1Schema } from '@happier-dev/protocol/teams';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { teamCredentialResourceFixture, teamMembershipFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');
const { applyTeamCredentialResource, resetTeamsSnapshotsForTests, teamCredentialExternalApiKeyObservations, teamCredentialExternalKeyObservationKey } = await import('@/sync/store/teams/teamsSnapshots');
const { captureServerCredentialAccountScopeLifetime, resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
const { useTeamCredentialUsageLimits } = await import('@/hooks/teams/useTeamCredentialResources');

const resourceId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';
const teamId = '299c21a2-4015-40ad-8940-38867c442c2c';
const groupId = '3d703df7-5a51-4be7-91ec-dc877ae861ab';
const membershipId = 'f20c797b-449f-4aa6-8b89-01fcfcaed022';
const groupName = 'Release reviewers';
const resourceName = 'Studio credential';

beforeEach(async () => { standardCleanup(); resetTeamsSnapshotsForTests(); await harness.reset(); });
afterEach(async () => { standardCleanup(); resetTeamsSnapshotsForTests(); await harness.reset(); });

it.each(['readable', 'denied', 'different revision'] as const)('identifies a readable limit being deleted (%s)', async visibility => {
    const accountId = 'reviewer';
    const serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://limit-review.test', accountId,
        teamsEnabled: true, credentialResourcesEnabled: true });
    await harness.selectHomes([serverId]);
    const limitId = '876c1059-e438-4752-bafd-d08dd94c6de4';
    const limitsRoute = '/v1/teams/credential-resources/limits/list';
    harness.answer(serverId, `POST ${limitsRoute}`, visibility !== 'denied' ? {
        body: { limits: [{ id: limitId, subjectKind: 'each_member', subjectId: '', period: 'week', metric: 'inference_requests',
            maximum: '500', enabled: true, currentWindow: { recorded: '0', resetsAtUtc: '2026-11-24T10:00:00Z' } }], nextCursor: null },
    } : { status: 403, body: { error: 'forbidden' } });
    const scope = { serverId, accountId };
    const limits = await renderHook(() => useTeamCredentialUsageLimits({
        scope, resourceId, resourceRevision: visibility === 'different revision' ? 2 : 1, enabled: true,
    }));
    try {
        await waitForHomeGovernance(() => expect(limits.getCurrent().status).toBe(visibility === 'denied' ? 'error' : 'ready'));
    } finally { await limits.unmount(); }
    const reads = harness.requestsFor(limitsRoute).length;
    const actionId = 'teams.credentials.limits.delete';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ resourceId, expectedRevision: 1, limitId });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={serverId} testID="credential-limit-delete" />);
    try {
        await waitForHomeGovernance(() => {
            const content = screen.getTextContent();
            expect(content).not.toContain(limitId);
            if (visibility === 'readable') {
                expect(content).toContain(t('teams.credentials.limits.subject.eachMember'));
                expect(content).toContain(t('teams.credentials.limits.period.week'));
                expect(content).toContain(t('teams.credentials.limits.metric.requests'));
                expect(content).toContain('500');
            } else {
                expect(content).toContain(t('common.unavailable'));
                expect(content).not.toContain('500');
            }
        });
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(limitId);
        expect(harness.requestsFor(limitsRoute)).toHaveLength(reads);
    } finally { await screen.unmount(); }
});

it.each([
    ['teams.credentials.list', { teamId, filter: 'needs_attention' }, 'teams.credentials.state.needsAttention', 'needs_attention'],
    ['teams.credentials.create', { teamId, resourceId, displayName: 'Research credential',
        source: { v: 1, kind: 'provider_connection', connectionId: 'provider', connectionSecurityFingerprint: 'connection-security:v1:test', credentialSlotId: 'api-key' },
        sessionUsePolicy: 'personal_allowed', brokerPlacement: null, requestPolicy: null,
        allMembersAllowedRoutes: null, groupGrants: [], memberGrants: [], usageLimits: [] },
        'teams.credentials.usePolicy.personalAllowed', 'personal_allowed'],
    ['teams.credentials.limits.upsert', { resourceId, expectedRevision: 1,
        limit: { subjectKind: 'resource', subjectId: '', period: 'day', metric: 'inference_requests', maximum: '125', enabled: true } },
        'teams.credentials.limits.metric.requests', 'inference_requests'],
] as const)('reuses the settings picker label in a %s review', async (actionId, input, label, code) => {
    const actionArgs = getActionSpec(actionId).inputSchema.parse(input);
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={null} testID="credential-choice-review" />);
    try {
        const text = screen.getTextContent();
        expect(text).toContain(t(label));
        expect(text).not.toContain(code);
        if (actionId === 'teams.credentials.limits.upsert') expect(text).toContain('125');
    } finally { await screen.unmount(); }
});

it.each(['readable', 'other Account'] as const)('reviews a Team credential audience (%s)', async visibility => {
    const accountId = 'reviewer';
    const serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://credential-review.test', accountId, teamsEnabled: true });
    await harness.selectHomes([serverId]);
    const resource = teamCredentialResourceFixture({ id: resourceId, teamId, displayName: resourceName });
    applyTeamCredentialResource({
        scope: { serverId, accountId: visibility === 'readable' ? accountId : 'other' },
        address: { serverId, teamId },
        resource,
        observedAt: 1,
    });
    const member = teamMembershipFixture({ id: membershipId, teamId });
    harness.answer(serverId, 'POST /v1/teams/members/get', { body: member });
    harness.answer(serverId, 'POST /v1/session-access/principals/resolve', {
        select: input => ({ body: { v: 1, principals: (input as { subjects: { kind: string; teamId?: string; groupId?: string }[] }).subjects
            .filter(subject => subject.kind === 'group' && subject.teamId === teamId && subject.groupId === groupId)
            .map(subject => ({ ...subject, teamName: 'Research', name: {
                kind: 'available', label: { content: { t: 'plain', v: groupName }, recipientEnvelope: null },
            } })) } }),
    });
    const actionId = 'teams.credentials.audience.set';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ resourceId, expectedRevision: 1,
        allMembersAllowedRoutes: null, groupGrants: [{ teamGroupId: groupId, allowedRoutes: ['brokered'] }],
        memberGrants: [{ teamMembershipId: membershipId, allowedRoutes: ['brokered'] }] });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={serverId} testID="credential-audience-review" />);
    try {
        await waitForHomeGovernance(() => {
            const text = screen.getTextContent();
            if (visibility === 'readable') {
                expect(text).toContain(resourceName);
                expect(text).toContain(groupName);
                expect(text).toContain('Ada');
            } else {
                expect(text).toContain(t('common.unavailable'));
                expect(text).not.toContain(resourceName);
                expect(text).not.toContain(groupName);
                expect(text).not.toContain('Ada');
            }
            for (const id of [resourceId, groupId, membershipId]) expect(text).not.toContain(id);
        });
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        for (const id of [resourceId, groupId, membershipId]) expect(screen.getTextContent()).toContain(id);
    } finally { await screen.unmount(); }
});

it('names selected protocols in a replacement request policy', async () => {
    const actionId = 'teams.credentials.update';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ resourceId, expectedRevision: 1, replacement: {
        requestPolicy: { allowedProtocolKinds: ['openai_responses', 'anthropic_messages'],
            allowedModelIds: ['model-for-release'], reasoningEffort: null },
    } });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={null} testID="credential-replacement-protocols" />);
    try {
        const text = screen.getTextContent();
        expect(text).toContain(t('teams.credentials.requestPolicy.protocol.openaiResponses'));
        expect(text).toContain(t('teams.credentials.requestPolicy.protocol.anthropicMessages'));
        expect(text).toContain('model-for-release');
        expect(text).not.toContain('openai_responses');
        expect(text).not.toContain('anthropic_messages');
    } finally { await screen.unmount(); }
});

it('distinguishes clearing a replacement request policy from leaving it alone', async () => {
    const actionId = 'teams.credentials.update';
    const review = (replacement: unknown) => <ApprovalReviewFacts actionId={actionId}
        actionArgs={getActionSpec(actionId).inputSchema.parse({ resourceId, expectedRevision: 1, replacement })}
        preview={null} status="open" serverId={null} testID="credential-replacement-clear" />;
    const screen = await renderScreen(review({ enabled: false }));
    const clear = t('approvals.clearsField', { field: 'Request policy' });
    try {
        expect(screen.getTextContent()).not.toContain(clear);
        await screen.update(review({ enabled: false, requestPolicy: null }));
        expect(screen.getTextContent()).toContain(clear);
    } finally { await screen.unmount(); }
});

it('reads the replacement usage limit’s own audience and measure', async () => {
    const actionId = 'teams.credentials.update';
    const limitId = '0b811ee3-29f3-42b5-9130-21d55a619ec4';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ resourceId, expectedRevision: 1, replacement: {
        usageLimitDelta: { deleteIds: [], upserts: [{ id: limitId, subjectKind: 'team_member', subjectId: membershipId,
            period: 'week', metric: 'inference_requests', maximum: '40', enabled: true }] },
    } });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={null} testID="credential-replacement-limit" />);
    try {
        const text = screen.getTextContent();
        expect(text).toContain(t('teams.credentials.limits.subject.member'));
        expect(text).toContain(t('teams.credentials.limits.metric.requests'));
        expect(text).toContain('40');
        expect(text).not.toContain('team_member');
        expect(text).not.toContain('inference_requests');
        expect(text).not.toContain(limitId);
        expect(text).not.toContain(membershipId);
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(limitId);
    } finally { await screen.unmount(); }
});

it.each([
    ['teams.credentials.externalKeys.authorize', true],
    ['teams.credentials.externalKeys.revoke', true],
    ['teams.credentials.externalKeys.revoke', false],
] as const)('reads the scoped external key label for %s (readable %s)', async (actionId, readable) => {
    const serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://credential-review.test', accountId: 'reviewer' });
    const resolution = await resolveServerCredentialAccountScope(serverId);
    if (resolution.kind !== 'bound') throw new Error('Missing reviewer credentials');
    const binding = captureServerCredentialAccountScopeLifetime(resolution);
    const address = { serverId, teamId };
    const keyId = '4a1db1f6-fc8a-4a73-a994-97cb3ef57615';
    const label = 'Studio integration key';
    const scope = readable ? binding.scope : { ...binding.scope, accountId: 'other' };
    applyTeamCredentialResource({ scope, address, resource: teamCredentialResourceFixture({
        id: resourceId, teamId, displayName: resourceName,
    }), observedAt: 1 });
    const key = TeamCredentialExternalApiKeySummaryV1Schema.parse({
        keyId, resourceId, teamMembershipId: membershipId,
        label: { content: { t: 'plain', v: label }, recipientEnvelope: null },
        displayPrefix: 'hapek_v1_4a1db1f6', createdAt: '2026-11-23T00:00:00Z',
        expiresAt: null, lastUsedAt: null, authenticationStatus: 'satisfied', canAuthorize: false,
    });
    teamCredentialExternalApiKeyObservations.apply(teamCredentialExternalKeyObservationKey(scope, address, resourceId), binding, [key]);
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId}
        actionArgs={getActionSpec(actionId).inputSchema.parse({ resourceId, keyId })}
        preview={null} status="open" serverId={serverId} testID="credential-external-key" />);
    try {
        await waitForHomeGovernance(() => {
            const text = screen.getTextContent();
            expect(text).not.toContain(keyId);
            if (readable) expect(text).toContain(label);
            else {
                expect(text).toContain(t('common.unavailable'));
                expect(text).not.toContain(label);
            }
        });
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(keyId);
    } finally { await screen.unmount(); }
});
