import { describe, expect, it } from 'vitest';

import { isOriginalAccountExecutionAction, isOriginalTerminalExecutionAction } from './externalActionExecutionAuthorization';

describe('paired terminal Action admission', () => {
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
