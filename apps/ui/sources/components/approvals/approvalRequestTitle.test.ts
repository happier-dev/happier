import { describe, expect, it } from 'vitest';

import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { projectApprovalReviewInput } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { readActionApprovalReview } from './actionApprovalReview';
import { resolveApprovalRequestTitle } from './approvalRequestTitle';

describe('resolveApprovalRequestTitle', () => {
    it('recognizes a stored generated installation title with punctuation instead of repeating its Action', () => {
        const spec = getActionSpec('machines.managed.bootstrap.respond');
        const result = resolveApprovalRequestTitle({ actionId: spec.id, storedTitle: `${spec.title}.` });
        expect(result.title).toBe(spec.title);
        expect(result.actionTitle).toBeNull();
    });
    it.each([
        ['a Store install', { machineId: 'm', source: { kind: 'marketplace', sourceId: 'store', pluginId: 'acme.tools', version: '1.2.0' } }, 'acme.tools'],
        ['an installed plugin', { machineId: 'm', source: { kind: 'installed', pluginId: 'acme.tools' } }, 'acme.tools'],
        ['a local folder', { machineId: 'm', kind: 'path', path: '/workspace/reviewed-plugin/' }, 'reviewed-plugin'],
        ['a Windows folder', { machineId: 'm', kind: 'path', path: 'C:\\plugins\\reviewed-plugin' }, 'reviewed-plugin'],
        ['an npm package', { machineId: 'm', kind: 'npm', path: '@acme/tools' }, '@acme/tools'],
    ])('names a generated plugin install after what it installs: %s, before a review is evaluated', (_label, actionArgs, name) => {
        const spec = getActionSpec('plugins.install');
        const result = resolveApprovalRequestTitle({ actionId: spec.id, actionArgs, storedTitle: `${spec.title}.` });
        expect(result.title.endsWith(`\u00b7 ${name}`)).toBe(true);
        expect(result.actionTitle).toBeNull();
    });
    it('keeps a plugin install request\'s own authored sentence', () => {
        const result = resolveApprovalRequestTitle({ actionId: 'plugins.install', storedTitle: 'Install reviewed plugin',
            actionArgs: { machineId: 'm', kind: 'path', path: '/workspace/reviewed-plugin' } });
        expect(result.title).toBe('Install reviewed plugin');
    });
    it('names a Create approval after its reviewed machine instead of the routing Home', () => {
        const actionArgs = { selection: { kind: 'one-off', homeId: 'home', launch: {
            provider: { pluginId: 'custom.machine', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {},
        }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } };
        const spec = getActionSpec('machines.managed.acquire');
        for (const [status, args] of [['pending', actionArgs], ['executed', projectApprovalReviewInput(spec, actionArgs)]] as const) {
            const title = resolveApprovalRequestTitle({ storedTitle: null, actionId: spec.id, actionArgs: args, status, subject: 'This Home' }).title;
            expect(title).toContain('Build box');
            expect(title).not.toContain('This Home');
        }
    });
    const args = { controllerMachineId: 'machine-1', relationshipId: 'relationship_1' };

    it('titles a request by its Action when the stored first line only restates the request\'s own summary', () => {
        // A request stored before its Action copy was reworded still carries the old generated sentence.
        const stored = 'Synchronize this linked workspace relationship now.';
        const resolved = resolveApprovalRequestTitle({
            storedTitle: stored, previewSummary: stored, actionId: 'workspace.sync.relationship.flush', actionArgs: args,
        });
        expect(resolved.title).toBe('Sync workspace now');
        expect(resolved.actionTitle).toBeNull();
    });

    it('keeps an authored title that differs from the request summary', () => {
        const resolved = resolveApprovalRequestTitle({
            storedTitle: 'Release night sync', previewSummary: 'Synchronize these linked folders now.',
            actionId: 'workspace.sync.relationship.flush', actionArgs: args,
        });
        expect(resolved.title).toBe('Release night sync');
    });

    it('titles an Agent-requested Service Stop or Restart by the Service, from the summary the request stores', () => {
        const target = { kind: 'managed_service', managedServiceId: 'managed-a', machineId: 'worker',
            declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'httpPort' } } };
        for (const [actionId, action, summary, title] of [
            ['localServices.actions.stopManaged', 'stop_managed', 'Stop httpPort.', 'Stop httpPort?'],
            ['localServices.actions.restartManaged', 'restart_managed', 'Restart httpPort.', 'Restart httpPort?'],
        ] as const) {
            expect(resolveApprovalRequestTitle({ storedTitle: summary, actionId, actionArgs: { requestId: 'r', target, action } }).title).toBe(title);
        }
    });
    it('names a plugin Update by what it does, in its title and its decision, and a first install as an install', () => {
        const review = createPluginInstallationReviewFixture({ pluginId: 'acme.storage', displayName: 'Acme Storage', version: '1.1.0' });
        const request = (pendingReview: Record<string, unknown>) => ApprovalRequestV2Schema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'cli' }, actionId: 'plugins.install',
            actionArgs: { source: { kind: 'installed', pluginId: 'acme.storage' } }, summary: 'Install plugin',
            executionOriginV1: { v: 1, authority: 'present_user', caller: { kind: 'host' }, requestId: 'plugin-change',
                surface: 'ui', serverId: 'home', actionId: 'plugins.install' },
            preview: { actionId: 'plugins.install', pluginInstall: { permissionsDisclosure: 'daemonEvaluated', pendingReview: {
                kind: 'reviewRequired', reviewKind: 'installation', pendingChangeId: 'pending', review, ...pendingReview } } },
        });
        const update = request({ reason: 'authorityExpansion', currentVersion: '1.0.0', authorityExpansion: ['requiredHostAccess'] });
        const install = request({ reason: 'firstInstall', currentVersion: null, authorityExpansion: [] });
        const titleOf = (approval: typeof update) => resolveApprovalRequestTitle({ storedTitle: approval.summary,
            actionId: approval.actionId, actionArgs: approval.actionArgs, preview: approval.preview }).title;
        expect(titleOf(update)).toBe('Update plugin · Acme Storage');
        expect(readActionApprovalReview(update).approveVerb).toBe('Update');
        expect(titleOf(install)).toBe('Install plugin · Acme Storage');
        expect(readActionApprovalReview(install).approveVerb).toBe('Install');
    });
});
