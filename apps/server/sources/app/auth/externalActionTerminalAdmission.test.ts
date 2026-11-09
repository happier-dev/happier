import { describe, expect, it } from 'vitest';

import { isOriginalAccountExecutionAction, isOriginalTerminalExecutionAction, readAdmittedDeploymentNativePrincipal } from './externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DEPLOYMENT_BACKUP_ACTION_IDS_V1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

describe('paired terminal Action admission', () => {
    it.each(DEPLOYMENT_BACKUP_ACTION_IDS_V1)('spends only the exact admitted native backup principal for %s', actionId => {
        const input = { serverId: 'srv_home', environmentId: 'environment', machineId: 'runtime', installationId: 'installation',
            targetLinkId: 'target', deploymentId: 'deployment', expectedRevision: 3, configRevision: 2,
            ...(actionId === 'deployments.backups.verify' ? { backupOperationId: 'capture', snapshotId: 'a'.repeat(64), level: 'manifestReadBack' } : {}),
            ...(actionId === 'deployments.backups.prune' ? { retention: { kind: 'keepEverything' } } : {}) };
        const { binding } = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'proof', binding: {
            accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
            serverIdentityId: input.serverId, machineId: input.machineId, installationId: input.installationId,
            actionId, requestId: 'backup', target: { kind: 'machine', machineId: input.machineId },
            accountEncryptionMode: 'plain', environmentId: input.environmentId,
            deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(actionId, input), requestEnvelopeDigest: 'a'.repeat(43),
        } });
        expect(readAdmittedDeploymentNativePrincipal(binding)).toMatchObject({ accountId: 'owner' });
        expect(readAdmittedDeploymentNativePrincipal({ ...binding, environmentId: 'foreign' })).toBeNull();
        expect(readAdmittedDeploymentNativePrincipal({ ...binding, machineId: 'foreign' })).toBeNull();
        expect(readAdmittedDeploymentNativePrincipal({ ...binding, installationId: 'replaced' })).toBeNull();
    });
    it('admits catalog Account roots and input-placed Provider Machine roots', () => {
        expect(isOriginalAccountExecutionAction('providers.connections.describe')).toBe(true);
        expect(isOriginalAccountExecutionAction('providers.defaults.set')).toBe(true);
        expect(isOriginalAccountExecutionAction('providers.connections.create_custom')).toBe(true);
        expect(isOriginalAccountExecutionAction('teams.list')).toBe(true);
        expect(isOriginalAccountExecutionAction('scm.hostingRepository.resolveAddress')).toBe(true);
    });
    it.each(['session.fork', 'session.message.send', 'session.board.item.upsert'])(
        'admits the catalog Session root %s without manufacturing requester provenance', actionId => {
            expect(isOriginalAccountExecutionAction(actionId)).toBe(true);
            expect(isOriginalTerminalExecutionAction(actionId)).toBe(true);
        },
    );

    it('keeps Session permission decisions human-decided for original automation roots', () => {
        expect(isOriginalAccountExecutionAction('session.permission.respond')).toBe(false);
        expect(isOriginalTerminalExecutionAction('session.permission.respond')).toBe(false);
    });

    it.each(['search.conversations', 'ui.find', 'workspace.tabs.list'])(
        'admits client Action %s only with installed Session provenance', actionId => {
            const origin = {
                sessionActionOrigin: { v: 1 as const, caller: { kind: 'session' as const,
                    sessionId: 'session', starterDepth: 0, turnDepth: 0 }, sourceTurnId: 'turn',
                    callerPermissionMode: null, requestId: 'request' },
                sessionActionSource: { machineId: 'machine', installationId: 'installation' },
            };
            for (const admit of [isOriginalAccountExecutionAction, isOriginalTerminalExecutionAction]) {
                expect(admit(actionId)).toBe(false);
                expect(admit(actionId, { sessionActionOrigin: origin.sessionActionOrigin })).toBe(false);
                expect(admit(actionId, { sessionActionSource: origin.sessionActionSource })).toBe(false);
                expect(admit(actionId, origin)).toBe(true);
            }
        },
    );

    it('admits the Machine repository resolver without manufacturing a Session origin', () => {
        // The QA terminal bearer authenticated ordinary reads, but the loaded
        // server's narrower allowlist refused this catalog-owned Machine Action.
        expect(isOriginalTerminalExecutionAction('scm.hostingRepository.resolveAddress')).toBe(true);
    });

    it.each([
        'action.spec.search', 'action.spec.get',
        'projects.sources.list', 'projects.sources.read', 'projects.sources.create',
        'projects.sources.update', 'projects.sources.delete',
        'projects.list', 'projects.workspace.update', 'projects.workspace.forget',
        'projects.visibility.set', 'projects.context.update',
        'projects.prepare', 'projects.script.run', 'projects.compute.exec',
        'widgets.area.layout.create', 'widgets.area.layout.rename',
        'artifact.access.grants.list',
    ])('admits catalog-authorized paired terminal Account Action %s', actionId => {
        expect(isOriginalTerminalExecutionAction(actionId)).toBe(true);
    });

    it('classifies plugin-provenance-only roots for Account execution without admitting paired terminals', () => {
        expect(isOriginalAccountExecutionAction('automation.conversation.targets.list')).toBe(true);
        expect(isOriginalAccountExecutionAction('scm.reviewWorkspace.materializePrepared')).toBe(true);
        expect(isOriginalTerminalExecutionAction('automation.conversation.targets.list')).toBe(false);
        expect(isOriginalTerminalExecutionAction('scm.reviewWorkspace.materializePrepared')).toBe(false);
    });
});
