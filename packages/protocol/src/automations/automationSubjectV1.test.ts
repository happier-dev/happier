import { describe, expect, it } from 'vitest';
import { readPluginAutomationSubjectV1, projectPluginAutomationSubjectsV1 } from './automationPluginSubjectV1.js';
import { AutomationDatabaseSubjectV1Schema, AutomationSubjectV1Schema, projectAutomationDatabaseSubjectV1,
    projectAutomationSubjectStructuralV1, automationSubjectKeyV1, automationSubjectSharedKeyV1,
    automationSubjectKeyMatchesV1, automationSubjectMatchesV1, type AutomationSubjectV1 } from './automationSubjectV1.js';
import { DatabaseManualTargetV1Schema, DatabaseWorktreeTargetV1Schema } from '../databases/databaseTargetIdentityV1.js';

// Canonical serialization order and framing cannot be controlled through UI authoring.
// These pure identity rules complement, and do not replace, P01.F1–F7.
describe('automation subject identity', () => {
    it('separates Homes, kinds and workflows while canonicalizing plugin identity object order', () => {
        const subject: AutomationSubjectV1 = { kind: 'plugin', serverId: 'home', pluginId: 'example.tickets', subjectKindId: 'ticket', identity: { team: 'one', id: 'two' } };
        expect(automationSubjectKeyV1(subject)).toBe(automationSubjectKeyV1({ ...subject, identity: { id: 'two', team: 'one' } }));
        expect(automationSubjectKeyV1(subject)).not.toBe(automationSubjectKeyV1({ ...subject, serverId: 'other' }));
        expect(automationSubjectKeyV1(subject)).not.toBe(automationSubjectKeyV1({ ...subject, pluginId: 'another.tickets' }));
        expect(automationSubjectKeyV1(subject, 'workflow-a')).not.toBe(automationSubjectKeyV1(subject, 'workflow-b'));
        expect(automationSubjectKeyV1({ kind: 'session', serverId: 'home', sessionId: 'same' })).not.toBe(
            automationSubjectKeyV1({ kind: 'machine', serverId: 'home', machineId: 'same' }));
    });

    it('matches approval profiles only as bound context and exact resources by qualified identity', () => {
        const profile: AutomationSubjectV1 = { kind: 'approvalProfile', serverId: 'home', profileId: 'profile' };
        expect(automationSubjectMatchesV1(profile, [{ role: 'operand', subject: profile }])).toBe(false);
        expect(automationSubjectMatchesV1(profile, [{ role: 'context', subject: profile }])).toBe(true);
        expect(automationSubjectMatchesV1(profile, [{ role: 'context', subject: { ...profile, serverId: 'other' } }])).toBe(false);
        expect(automationSubjectMatchesV1(undefined, [])).toBe(true);
    });

    it('compares shared structural keys in their workflow namespace with the same context-role rule', () => {
        const profile: AutomationSubjectV1 = { kind: 'approvalProfile', serverId: 'home', profileId: 'profile' };
        const key = automationSubjectKeyV1(profile, 'workflow-a');
        // The server has only the local digest for an encrypted authored subject.
        expect(automationSubjectSharedKeyV1(automationSubjectKeyV1(profile), 'workflow-a')).toBe(key);
        const context = [{ role: 'context' as const, subject: profile }];
        expect(automationSubjectKeyMatchesV1(key, context, 'workflow-a', 'approvalProfile')).toBe(true);
        expect(automationSubjectKeyMatchesV1(key, [{ role: 'context', kind: profile.kind,
            key: automationSubjectKeyV1(profile) }], 'workflow-a', 'approvalProfile')).toBe(true);
        expect(automationSubjectKeyMatchesV1(key, [{ role: 'operand', kind: profile.kind,
            key: automationSubjectKeyV1(profile) }], 'workflow-a', 'approvalProfile')).toBe(false);
        expect(automationSubjectKeyMatchesV1(key, context, 'workflow-b', 'approvalProfile')).toBe(false);
        expect(automationSubjectKeyMatchesV1(key, context, 'workflow-a', 'machine')).toBe(false);
        expect(automationSubjectKeyMatchesV1(key, [{ role: 'operand', subject: profile }], 'workflow-a')).toBe(false);
        expect(automationSubjectKeyMatchesV1(key, [{ role: 'context', subject: { ...profile, serverId: 'other' } }], 'workflow-a')).toBe(false);
    });

    it('matches sanitized Database bindings across worktrees, manual targets and Homes without execution values', () => {
        const workspace = { serverId: 'home', machineId: 'machine', workspaceId: 'checkout-one', rootPath: '/private/one' };
        const context = { accountId: 'owner', workspace, installationId: 'installation', projectKey: 'project' };
        const worktreeTarget = DatabaseWorktreeTargetV1Schema.parse({ kind: 'worktree', ...context,
            source: { kind: 'env_file', path: '.env.local', variable: 'DATABASE_URL' } });
        const manualTarget = DatabaseManualTargetV1Schema.parse({ kind: 'manual', ...context, savedSecretId: 'saved-connection' });
        const environmentInput = { kind: 'database' as const, serverId: 'home',
            target: { kind: 'environment' as const, environmentId: 'environment',
                service: 'postgres', database: 'app' } };
        const environment = projectAutomationDatabaseSubjectV1(AutomationDatabaseSubjectV1Schema.parse(environmentInput));
        expect(environment).toEqual(environmentInput);
        expect(automationSubjectKeyV1(environment)).toBe(automationSubjectKeyV1(environmentInput));
        const worktree = projectAutomationDatabaseSubjectV1(AutomationDatabaseSubjectV1Schema.parse({
            kind: 'database', serverId: 'home', target: worktreeTarget }));
        const manual = projectAutomationDatabaseSubjectV1(AutomationDatabaseSubjectV1Schema.parse({
            kind: 'database', serverId: 'home', target: manualTarget }));
        expect(AutomationSubjectV1Schema.parse(worktree)).toEqual(worktree);
        expect(automationSubjectMatchesV1(worktree, [{ role: 'operand', subject: worktree }])).toBe(true);
        const otherCheckout = AutomationDatabaseSubjectV1Schema.parse({ ...worktree, target: { ...worktreeTarget,
            workspace: { ...workspace, workspaceId: 'checkout-two', rootPath: '/private/two' } } });
        for (const other of [otherCheckout, manual, environment,
            AutomationDatabaseSubjectV1Schema.parse({ ...worktree, serverId: 'other-home' })]) {
            expect(automationSubjectMatchesV1(worktree, [{ role: 'operand', subject: other }])).toBe(false);
        }
        expect(automationSubjectMatchesV1(manual, [{ role: 'operand', subject: environment }])).toBe(false);
        // Endpoint rotation belongs to execution; the admitted owner binding stays the identity.
        const executions = ['postgres://first/private', 'postgres://rotated/private'].map(connectionUrl => ({
            target: worktreeTarget, connectionUrl,
        }));
        expect(executions.map(execution => automationSubjectKeyV1(projectAutomationDatabaseSubjectV1(
            AutomationDatabaseSubjectV1Schema.parse({ kind: 'database', serverId: 'home', target: execution.target })))))
            .toEqual([automationSubjectKeyV1(worktree), automationSubjectKeyV1(worktree)]);
        expect(AutomationDatabaseSubjectV1Schema.safeParse({ ...worktree,
            target: { ...worktreeTarget, connectionUrl: executions[0]!.connectionUrl } }).success).toBe(false);
        expect(AutomationDatabaseSubjectV1Schema.safeParse({ ...manual,
            target: { ...manualTarget, credential: 'secret-value' } }).success).toBe(false);
        const selector = projectAutomationSubjectStructuralV1(worktree);
        expect(selector).toEqual({ subjectKind: 'database', subjectKey: automationSubjectKeyV1(worktree) });
        expect(JSON.stringify(selector)).not.toContain('private');
        expect(JSON.stringify(selector)).not.toContain('DATABASE_URL');
    });
});


describe('declared plugin subject ingress', () => {
    const kind = { pluginId: 'example.tickets', definition: { id: 'ticket', label: 'Ticket',
        identitySchema: { type: 'object', properties: { ticketId: { type: 'string' } },
            required: ['ticketId'], additionalProperties: false }, listAction: 'list-tickets' } } as const;
    const subject = { serverId: 'home', pluginId: kind.pluginId, subjectKindId: 'ticket', identity: { ticketId: 'one' } };

    it('admits only the qualified declaration and its identity schema', () => {
        expect(readPluginAutomationSubjectV1({ ...subject, subjectKinds: [kind] })).toEqual({ ok: true, subject: { kind: 'plugin', ...subject } });
        expect(readPluginAutomationSubjectV1({ ...subject, pluginId: 'example.other', subjectKinds: [kind] }))
            .toEqual({ ok: false, code: 'subject_kind_unavailable' });
        expect(readPluginAutomationSubjectV1({ ...subject, identity: { ticketId: 1 }, subjectKinds: [kind] }))
            .toEqual({ ok: false, code: 'invalid_subject_identity' });
        expect(readPluginAutomationSubjectV1({ ...subject, identity: { ticketId: 'one', arbitrary: true }, subjectKinds: [kind] }))
            .toEqual({ ok: false, code: 'invalid_subject_identity' });
    });

    it('projects the declared payload operand rather than an unrelated identity', () => {
        const read = projectPluginAutomationSubjectsV1({ ...subject, subjectKinds: [kind],
            projections: [{ kind: 'plugin', subjectKindId: 'ticket', identityField: 'ticket' }],
            value: { ticket: { ticketId: 'two' }, identity: subject.identity } });
        expect(read).toEqual({ ok: true, subjects: [{ role: 'operand', subject: { kind: 'plugin', ...subject, identity: { ticketId: 'two' } } }] });
    });
});
