import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { describe, expect, it } from 'vitest';

import { describeApprovalActionFields, projectApprovalStructuredAnswers } from './approvalFieldValues';
import { readApprovalPreviewSummary } from './ApprovalPreviewCard';
import { readBuiltInSettingDeclarationV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';

it('reads the declared request effect instead of a stored generic Action description', () => {
    const anchor = 'delegation.workDepthLimit';
    const declaration = readBuiltInSettingDeclarationV1(anchor)!;
    const generic = { summary: 'Discover declared settings, read or change bound preferences' };
    expect(readApprovalPreviewSummary(generic, { actionId: 'settings.set', actionArgs: { anchor, value: 3 } }))
        .toBe(`Change “${declaration.title}” to 3.`);
    expect(readApprovalPreviewSummary({ summary: 'Requested effect' }, { actionId: 'session.title.set', actionArgs: {} }))
        .toBe('Requested effect');
    expect(readApprovalPreviewSummary(undefined, { actionId: 'settings.set', actionArgs: { anchor, value: 3 } }))
        .toBeNull();
});

it('keeps captured widget names when rendering a stored removal preview', () => {
    const actionArgs = { ref: { surface: { serverId: 'home', accountId: 'account', owner: {
        kind: 'pluginArea', pluginId: 'examples.widget-areas', pageId: 'overview', area: 'pinned',
    } }, instanceId: 'removed-copy' } };
    expect(readApprovalPreviewSummary({ summary: 'Remove the widget from Plugin page · Pinned area.',
        widgetPresentation: { widgetName: 'Directory count', pageName: 'Widget areas', areaName: 'Pinned' } },
        { actionId: 'widgets.item.remove', actionArgs })).toBe('Remove “Directory count” from Widget areas · Pinned.');
});

describe('projectApprovalStructuredAnswers', () => {
    it('preserves the exact released scalar question and answer content', () => {
        expect(projectApprovalStructuredAnswers([
            { question: '  Use the compatibility path?  ', answer: '  Yes, once  ' },
        ])).toEqual({
            kind: 'valid',
            answers: [{ question: '  Use the compatibility path?  ', values: ['  Yes, once  '] }],
        });
    });

    it('reports a malformed entry instead of silently dropping it beside valid content', () => {
        expect(projectApprovalStructuredAnswers([
            { question: 'Shown question', values: ['Yes'] },
            { question: 'Malformed', values: [{ secret: 'must-not-render' }] },
        ])).toEqual({ kind: 'unrepresentable', reason: 'malformed_entry' });
    });

    it('reports an entry that carries no answer at all', () => {
        expect(projectApprovalStructuredAnswers([{ question: 'Empty', values: [] }]))
            .toEqual({ kind: 'unrepresentable', reason: 'malformed_entry' });
    });

    it('reports a duplicated question rather than an indistinguishable empty projection', () => {
        expect(projectApprovalStructuredAnswers([
            { question: 'Same question', values: ['A'] },
            { question: 'Same question', values: ['B'] },
        ])).toEqual({ kind: 'unrepresentable', reason: 'duplicate_question' });
    });

    it('reports an aggregate payload above the canonical protocol bound', () => {
        expect(projectApprovalStructuredAnswers(Array.from({ length: 16 }, (_, index) => ({
            question: `Question ${index}`,
            values: [`oversized-answer-${index}-${'x'.repeat(16_360)}`],
        })))).toEqual({ kind: 'unrepresentable', reason: 'exceeds_protocol_bounds' });
    });

    it('treats an absent answers field as carrying nothing rather than as malformed', () => {
        expect(projectApprovalStructuredAnswers([undefined]))
            .toEqual({ kind: 'valid', answers: [] });
    });
});

describe('describeApprovalActionFields', () => {
    it('presents a valid structured payload without withholding the decision', () => {
        const presentation = describeApprovalActionFields({
            actionId: 'session.user_action.answer',
            actionArgs: {
                sessionId: 'session-1',
                requestId: 'ask-1',
                answers: [{ question: 'Continue?', values: ['Yes'] }],
            },
        });

        expect(presentation.unrepresentable).toBeNull();
        expect(presentation.rows).toContainEqual(expect.objectContaining({
            kind: 'structuredAnswers',
            path: 'answers',
            answers: [{ question: 'Continue?', values: ['Yes'] }],
        }));
    });

    it('withholds the whole structured field and every value once one entry is unrepresentable', () => {
        const presentation = describeApprovalActionFields({
            actionId: 'session.user_action.answer',
            actionArgs: {
                sessionId: 'session-1',
                requestId: 'ask-1',
                answers: [
                    { question: 'Shown question', values: ['Yes'] },
                    { question: 'Malformed', values: [{ secret: 'must-not-render' }] },
                ],
            },
        });

        expect(presentation.unrepresentable).toEqual({ path: 'answers', reason: 'malformed_entry' });
        expect(presentation.rows).toContainEqual(expect.objectContaining({
            kind: 'unrepresentable',
            path: 'answers',
            reason: 'malformed_entry',
        }));
        // Nothing from the payload survives into the presentation: an approval must
        // never stringify an arbitrary JSON leaf, and partial content would imply the
        // reader saw everything they are consenting to.
        const serialized = JSON.stringify(presentation);
        expect(serialized).not.toContain('must-not-render');
        expect(serialized).not.toContain('Shown question');
    });

    it('withholds an over-bound structured field instead of dropping the row silently', () => {
        const presentation = describeApprovalActionFields({
            actionId: 'session.user_action.answer',
            actionArgs: {
                sessionId: 'session-1',
                requestId: 'ask-oversized',
                answers: Array.from({ length: 16 }, (_, index) => ({
                    question: `Question ${index}`,
                    values: [`oversized-answer-${index}-${'x'.repeat(16_360)}`],
                })),
            },
        });

        expect(presentation.unrepresentable).toEqual({ path: 'answers', reason: 'exceeds_protocol_bounds' });
        expect(JSON.stringify(presentation)).not.toContain('oversized-answer-0');
    });

    it('leaves ordinary scalar fields fully visible and approvable', () => {
        const presentation = describeApprovalActionFields({
            actionId: 'session.title.set',
            actionArgs: { sessionId: 'session-1', title: 'New title from MCP' },
        });

        expect(presentation.unrepresentable).toBeNull();
        expect(presentation.rows).toContainEqual(expect.objectContaining({
            kind: 'value',
            value: 'New title from MCP',
        }));
    });

    it('admits a required field whose schema declares null, and still withholds one that is absent or not nullable', () => {
        const item = {
            v: 1,
            title: 'Release checklist',
            frame: 'card',
            height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: '# Release checklist' } } },
        };
        const creation = {
            actionId: 'session.board.item.upsert',
            actionArgs: {
                sessionId: 'session-1',
                itemId: 'release-checklist',
                expectedItemRevision: null,
                item,
                placement: { tabId: 'overview', width: 'wide' },
            },
        } as const;
        const createPresentation = describeApprovalActionFields(creation);
        expect(createPresentation.unrepresentable).toBeNull();
        expect(createPresentation.rows).toContainEqual(
            expect.objectContaining({ kind: 'value', path: 'itemId', value: 'release-checklist' }),
        );

        // The same field, absent: the observation-safe context really is missing.
        const { expectedItemRevision: _omitted, ...withoutRevision } = creation.actionArgs;
        expect(describeApprovalActionFields({ actionId: 'session.board.item.upsert', actionArgs: withoutRevision }).unrepresentable)
            .toEqual({ path: 'expectedItemRevision', reason: 'missing_required_context' });

        // A layout edit against a Board that has no layout yet also declares null.
        expect(describeApprovalActionFields({
            actionId: 'session.board.layout.update',
            actionArgs: { sessionId: 'session-1', expectedLayoutRevision: null, operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' } },
        }).unrepresentable).toBeNull();

        // Removal's revisions are not nullable, so a null there is not admitted context.
        expect(describeApprovalActionFields({
            actionId: 'session.board.item.remove',
            actionArgs: { sessionId: 'session-1', itemId: 'release-checklist', expectedItemRevision: null, expectedLayoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
        }).unrepresentable).toEqual({ path: 'expectedItemRevision', reason: 'missing_required_context' });
    });

    it('shows the exact Team and member targets for deferred governance approvals', () => {
        expect(describeApprovalActionFields({
            actionId: 'teams.members.remove',
            actionArgs: { v: 1, teamId: 'team-acme', membershipId: 'membership-alice' },
        })).toEqual({
            rows: [
                { kind: 'value', path: 'teamId', title: 'Team ID', value: 'team-acme' },
                { kind: 'value', path: 'membershipId', title: 'Membership ID', value: 'membership-alice' },
            ],
            unrepresentable: null,
        });

        expect(describeApprovalActionFields({
            actionId: 'teams.archive',
            actionArgs: { v: 1, teamId: 'team-acme' },
        })).toEqual({
            rows: [
                { kind: 'value', path: 'teamId', title: 'Team ID', value: 'team-acme' },
            ],
            unrepresentable: null,
        });
    });

    it('presents canonical invitation context without exposing the bearer or continuation reference', () => {
        const bearer = 'a'.repeat(43);
        const bearerPresentation = describeApprovalActionFields({
            actionId: 'teams.invitations.accept',
            actionArgs: { v: 1, token: bearer },
            preview: {
                actionId: 'teams.invitations.accept',
                actionArgs: {
                    homeServerId: 'srv-home-acme',
                    continuation: { teamId: 'team-acme' },
                    teamName: 'Acme Platform',
                    role: 'member',
                    historyAccess: 'from_membership',
                    state: 'active',
                    expiresAt: 1234,
                    recipientEmailMask: 'a•••@example.com',
                },
            },
        });
        expect(bearerPresentation).toEqual({
            rows: [
                { kind: 'value', path: 'homeServerId', title: 'Home ID', value: 'srv-home-acme' },
                { kind: 'value', path: 'continuation.teamId', title: 'Team ID', value: 'team-acme' },
                { kind: 'value', path: 'teamName', title: 'Team name', value: 'Acme Platform' },
                { kind: 'value', path: 'role', title: 'Team role', value: 'member' },
                { kind: 'value', path: 'historyAccess', title: 'History access', value: 'from_membership' },
                { kind: 'value', path: 'state', title: 'Invitation state', value: 'active' },
                { kind: 'value', path: 'expiresAt', title: 'Expires at', value: '1234' },
                { kind: 'value', path: 'recipientEmailMask', title: 'Recipient', value: 'a•••@example.com' },
            ],
            unrepresentable: null,
        });
        expect(JSON.stringify(bearerPresentation)).not.toContain(bearer);

        const continuationPresentation = describeApprovalActionFields({
            actionId: 'teams.invitations.accept',
            actionArgs: {
                v: 1,
                continuation: {
                    v: 1,
                    kind: 'post_auth_invitation',
                    reference: 'opaque-continuation-reference',
                    teamId: 'team-acme',
                },
            },
            preview: {
                actionId: 'teams.invitations.accept',
                actionArgs: { continuation: { teamId: 'team-acme' } },
            },
        });
        expect(continuationPresentation).toEqual({
            rows: [
                { kind: 'value', path: 'continuation.teamId', title: 'Team ID', value: 'team-acme' },
            ],
            unrepresentable: null,
        });
        expect(JSON.stringify(continuationPresentation)).not.toContain('opaque-continuation-reference');
    });

    it('shows safe invitation intent without exposing request or result bearers', () => {
        const createPresentation = describeApprovalActionFields({
            actionId: 'teams.invitations.create',
            actionArgs: {
                v: 1,
                teamId: 'team-acme',
                recipientEmail: 'alice@example.com',
                role: 'member',
                historyAccess: 'from_membership',
                requestKey: 'private-retry-key',
            },
        });
        expect(createPresentation).toEqual({
            rows: [
                { kind: 'value', path: 'teamId', title: 'Team ID', value: 'team-acme' },
                { kind: 'value', path: 'recipientEmail', title: 'Recipient email', value: 'alice@example.com' },
                { kind: 'value', path: 'role', title: 'Team role', value: 'member' },
                { kind: 'value', path: 'historyAccess', title: 'History access', value: 'from_membership' },
            ],
            unrepresentable: null,
        });
        expect(JSON.stringify(createPresentation)).not.toContain('private-retry-key');

        const reissuePresentation = describeApprovalActionFields({
            actionId: 'teams.invitations.reissue',
            actionArgs: {
                v: 1,
                teamId: 'team-acme',
                invitationId: 'invitation-alice',
                recipientEmail: 'replacement@example.com',
                requestKey: 'another-private-retry-key',
            },
        });
        expect(reissuePresentation.rows).toEqual([
            { kind: 'value', path: 'teamId', title: 'Team ID', value: 'team-acme' },
            { kind: 'value', path: 'invitationId', title: 'Invitation ID', value: 'invitation-alice' },
            { kind: 'value', path: 'recipientEmail', title: 'Recipient email', value: 'replacement@example.com' },
        ]);
        expect(JSON.stringify(reissuePresentation)).not.toContain('another-private-retry-key');
        expect(JSON.stringify(reissuePresentation)).not.toContain('joinUrl');
    });
});

it('does not repeat a retained installation title through its historical preview summary', () => {
    const spec = getActionSpec('machines.managed.bootstrap.respond');
    const actionArgs = spec.approvalPresentation?.projectInput?.(spec.inputSchema.parse({
        serverId: 'profile', homeId: 'home', managedId: 'managed', operationId: 'operation', taskId: 'task',
        purpose: 'approve', approved: true, prompt: { kind: 'ssh.trustHost', message: 'Trust this machine?',
            host: 'guest.example', keyType: 'ssh-ed25519', fingerprint: 'SHA256:guest', existingFingerprint: null },
    }));
    expect(readApprovalPreviewSummary({ summary: 'Answer the installation question for this machine.' },
        { actionId: spec.id, actionArgs })).toBeNull();
});
