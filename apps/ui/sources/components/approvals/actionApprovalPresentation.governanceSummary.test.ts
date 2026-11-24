import { afterEach, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { buildApprovalPreviewSummary } from '@happier-dev/protocol/actions/actionExecutor';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { preloadTranslations, setPreferredLanguageFromSettings } from '@/text';
import { presentActionApproval, readApprovalPreviewSummary } from './actionApprovalPresentation';

afterEach(() => setPreferredLanguageFromSettings('en'));

const teamId = '3d703df7-5a51-4be7-91ec-dc877ae861ab';
const workspaceId = '71e59706-1817-4d58-99aa-890ac15b5ad5';

it.each([
    { actionId: 'teams.archive', input: { v: 1, teamId }, words: /invitations.*révoquées/ },
    { actionId: 'teams.policy.set', input: { v: 1, teamId, managedDefaults: null }, words: /paramètres par défaut.*groupes/ },
    { actionId: 'teams.policy.set', input: { v: 1, teamId, authenticationPolicy: null, previousAuthenticationPolicy: null }, words: /connexion.*Home/ },
    { actionId: 'machines.presets.prepare', input: { homeId: 'home', id: teamId, expectedRevision: 1, machineId: 'machine' }, words: /image.*frais/ },
    { actionId: 'teams.credentials.audience.set', input: { resourceId: teamId, expectedRevision: 1,
        allMembersAllowedRoutes: ['vendor-native'], groupGrants: [], memberGrants: [] }, words: /livraison native.*plan de contrôle/ },
    { actionId: 'teams.setup.run', input: { serverId: teamId, homeId: teamId, machineId: teamId, repositories: [
        { id: workspaceId, input: { serverId: teamId, machineId: teamId, source: { kind: 'workspace', workspaceId },
            materialization: { kind: 'attach' } } },
    ] }, words: /Rattacher Espace de travail/ },
    { actionId: 'teams.setup.run', input: { serverId: teamId, homeId: teamId, machineId: teamId, repositories: [],
        machine: { homeId: teamId, machineId: teamId, targets: [{ homeId: teamId, machineId: teamId,
            sources: [{ kind: 'direct', setup: {} }], desiredRevision: 1, recipePlans: [], removeItemKeys: [workspaceId],
        }] },
    }, words: /1 à supprimer/ },
] as const)('translates pending $actionId consequences in both hosts', async ({ actionId, input, words }) => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    const spec = getActionSpec(actionId);
    const actionArgs = spec.inputSchema.parse(input);
    const preview = { summary: buildApprovalPreviewSummary(spec, actionArgs) };
    const request = { actionId, actionArgs, status: 'open' as const };
    for (const summary of [readApprovalPreviewSummary(preview, request),
        presentActionApproval({ ...request, preview, kind: 'confirmation' }).summary]) {
        expect(summary).toMatch(words);
        expect(summary).not.toContain(teamId);
        expect(summary).not.toContain(workspaceId);
    }
});

const group = { intent: { kind: 'group_create', groupId: teamId, instanceIds: [workspaceId], title: 'Design lab' } };
const lifecycleCases = [
    { status: 'open', words: /^This will / },
    { status: 'approved', words: /^This will / },
    { status: 'executing', words: /^This will / },
    { status: 'rejected', words: /wasn’t made.*was to / },
    { status: 'canceled', words: /wasn’t made.*was to / },
    { status: 'executed', words: /Completed the request to/ },
    { status: 'failed', words: /couldn’t be completed.*was to / },
    { status: 'outcome_unknown', words: /outcome is unknown.*was to / },
] as const satisfies readonly { status: ApprovalRequest['status']; words: RegExp }[];

it.each([
    { actionId: 'home.hub.layout.update', args: group, title: 'Add a group to Home', substance: /Design lab.*Machines/ },
    { actionId: 'teams.policy.set', args: { v: 1, teamId, managedDefaults: null }, title: 'Set Team policy',
        substance: /Team member defaults and all Group overrides/ },
    { actionId: 'home.settings.set', args: { expectedRevision: 1, values: { HAPPIER_HOME_DISPLAY_NAME: null } },
        title: 'Set Home settings', substance: /Home settings/ },
    { actionId: 'teams.create', args: { v: 1, name: 'Research', requestKey: 'create-research' }, title: 'Create Team',
        substance: /Research/ },
] as const)('keeps the $actionId request identifiable across its lifecycle', ({ actionId, args, title, substance }) => {
    const spec = getActionSpec(actionId);
    const actionArgs = spec.inputSchema.parse(args);
    const homeLayoutWidgets = ['Machines'];
    // A retained preview may carry the original request's sentence even after it settles.
    const preview = { summary: buildApprovalPreviewSummary(spec, actionArgs) };
    for (const { status, words } of lifecycleCases) {
        const request = { actionId, actionArgs, status };
        const presentation = presentActionApproval({ ...request, preview, homeLayoutWidgets });
        expect(presentation.title, status).toBe(title);
        for (const summary of [presentation.summary, readApprovalPreviewSummary(null, request, null, homeLayoutWidgets),
            readApprovalPreviewSummary(preview, request, null, homeLayoutWidgets)]) {
            expect(summary, status).toMatch(words);
            expect(summary, status).toMatch(substance);
        }
    }
});

it('describes the Session Team clear without claiming it removed access or treating a refused execution as completed', () => {
    const actionId = 'session.access.context.set';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ sessionId: workspaceId, primaryTeamId: null });
    const request = { actionId, actionArgs };
    expect(readApprovalPreviewSummary(null, { ...request, status: 'open' })).toMatch(/clear the primary Team/i);
    expect(readApprovalPreviewSummary(null, { ...request, status: 'rejected' })).toMatch(/wasn’t made.*clear the primary Team/);
    expect(readApprovalPreviewSummary(null, { ...request, status: 'executed', execution: { executedAtMs: 1, ok: false, errorCode: 'denied' } }))
        .toMatch(/couldn’t be completed/);
    expect(readApprovalPreviewSummary(null, { ...request, status: 'executed', execution: { executedAtMs: 1, ok: true,
        result: { changed: true, primaryTeamId: null, teamGrants: [{ teamId, name: 'Design studio', accessLevel: 'edit' }] } } }))
        .toBe('Team cleared\nDesign studio — Can steer');
});
