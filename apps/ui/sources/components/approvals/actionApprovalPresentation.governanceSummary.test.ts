import { afterEach, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { buildApprovalPreviewSummary } from '@happier-dev/protocol/actions/actionExecutor';
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
