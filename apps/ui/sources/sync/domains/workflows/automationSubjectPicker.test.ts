import { describe, expect, it } from 'vitest';
import { DATABASE_TARGETS_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';

import { projectAutomationSubjectPickerActionPage, resolveAutomationSubjectPickerListRead } from './automationSubjectPicker';

describe('automation subject picker read ownership', () => {
    it('keeps Environment coverage incomplete even when there is no continuation cursor', () => {
        const page = { ok: true, items: [], nextCursor: null, coverage: 'partial' };
        expect(projectAutomationSubjectPickerActionPage({ kind: { kind: 'environment' }, serverId: 'home-a', result: page }).coverage).toBe('partial');
        expect(projectAutomationSubjectPickerActionPage({ kind: { kind: 'backup' }, serverId: 'home-a',
            result: { ok: true, items: [], nextCursor: null } }).coverage).toBe('unknown');
    });
    it('preserves a Project key and incomplete incumbent coverage without substituting its App id', () => {
        expect(projectAutomationSubjectPickerActionPage({ kind: { kind: 'project' }, serverId: 'home-a', result: {
            items: [{ project: { serverId: 'home-a', projectKey: 'opaque-project-key' }, sourceId: 'different-app-id',
                label: 'Checkout', rootPath: '/repo' }], truncated: true, coverage: 'partial',
        } })).toEqual({ items: [{ label: 'Checkout', subject: { kind: 'project', serverId: 'home-a', projectKey: 'opaque-project-key' } }],
            nextCursor: null, coverage: 'partial' });
    });

    it('projects Machine resource identities without claiming completeness absent from the input owner', () => {
        expect(projectAutomationSubjectPickerActionPage({ kind: { kind: 'machine' }, serverId: 'home-b', result: {
            items: [{ machineId: 'machine-1', installationId: 'installation-other', label: 'Workbench', presence: 'offline' }],
        } })).toEqual({ items: [{ label: 'Workbench', subject: { kind: 'machine', serverId: 'home-b', machineId: 'machine-1' } }],
            nextCursor: null, coverage: 'unknown' });
    });
    it('asks the Machine Action for its existing UI input acquisition instead of the Voice disclosure projection', () => {
        expect(resolveAutomationSubjectPickerListRead({ kind: { kind: 'machine' }, serverId: 'home-a' }))
            .toEqual({ kind: 'action', actionId: 'machines.list', serverId: 'home-a', input: { serverId: 'home-a', refresh: true } });
    });
    it('preserves a Source owner’s partial page and qualifies every App identity with its Home', () => {
        expect(projectAutomationSubjectPickerActionPage({ kind: { kind: 'app' }, serverId: 'home-b', result: {
            ok: true, sources: [{ id: 'source-1', revision: 1, name: 'Store', audience: [], createdByAccountId: 'author' }],
            coverage: { complete: false, nextCursor: 'continue-here' },
        } })).toEqual({ items: [{ label: 'Store', subject: { kind: 'app', serverId: 'home-b', projectSourceId: 'source-1' } }],
            nextCursor: 'continue-here', coverage: 'partial' });
    });

    it('uses Environment pages for both Environment identities and backup streams, never backup attempts', () => {
        const environment = resolveAutomationSubjectPickerListRead({ kind: { kind: 'environment' }, serverId: 'home-a', cursor: 'next-page' });
        const backup = resolveAutomationSubjectPickerListRead({ kind: { kind: 'backup' }, serverId: 'home-a', cursor: 'next-page' });
        expect(environment).toEqual({ kind: 'action', actionId: 'deployments.environments.list', serverId: 'home-a',
            input: { serverId: 'home-a', cursor: 'next-page' } });
        expect(backup).toEqual(environment);
    });

    it('keeps plugin qualification and Home when resolving a contributed list owner', () => {
        const first = resolveAutomationSubjectPickerListRead({ kind: { kind: 'plugin', pluginId: 'example.one', subjectKindId: 'ticket' }, serverId: 'home-a' });
        const second = resolveAutomationSubjectPickerListRead({ kind: { kind: 'plugin', pluginId: 'example.two', subjectKindId: 'ticket' }, serverId: 'home-b' });
        expect(first).toEqual({ kind: 'plugin_contribution', serverId: 'home-a', pluginId: 'example.one', subjectKindId: 'ticket' });
        expect(second).toEqual({ kind: 'plugin_contribution', serverId: 'home-b', pluginId: 'example.two', subjectKindId: 'ticket' });
        const subjectKinds = [{ pluginId: 'example.one', definition: { id: 'ticket', label: 'Ticket',
            listAction: 'tickets.list', identitySchema: { type: 'object' as const, additionalProperties: false,
                required: ['ticketId'], properties: { ticketId: { type: 'string' as const } } } } }];
        expect(projectAutomationSubjectPickerActionPage({ kind: { kind: 'plugin', pluginId: 'example.one', subjectKindId: 'ticket' },
            serverId: 'home-a', subjectKinds, result: { items: [{ identity: { ticketId: 'same-id' }, label: 'Ticket' }], nextCursor: 'page-2' } }))
            .toEqual({ items: [{ label: 'Ticket', subject: { kind: 'plugin', serverId: 'home-a', pluginId: 'example.one',
                subjectKindId: 'ticket', identity: { ticketId: 'same-id' } } }], nextCursor: 'page-2', coverage: 'partial' });
        expect(() => projectAutomationSubjectPickerActionPage({ kind: { kind: 'plugin', pluginId: 'example.two', subjectKindId: 'ticket' },
            serverId: 'home-b', subjectKinds, result: { items: [{ identity: { ticketId: 'same-id' }, label: 'Ticket' }], nextCursor: null } }))
            .toThrow(expect.objectContaining({ code: 'subject_kind_unavailable' }));
        expect(() => projectAutomationSubjectPickerActionPage({ kind: { kind: 'plugin', pluginId: 'example.one', subjectKindId: 'ticket' },
            serverId: 'home-a', subjectKinds, result: { items: [{ identity: { otherId: 'same-id' }, label: 'Ticket' }], nextCursor: null } }))
            .toThrow(expect.objectContaining({ code: 'invalid_subject_identity' }));
    });

    it('keeps database scope at the database owner instead of fabricating a Home inventory', () => {
        expect(resolveAutomationSubjectPickerListRead({ kind: { kind: 'database' }, serverId: 'home-a' }))
            .toEqual({ kind: 'database_scope_required' });
        const scope = { kind: 'environment' as const,
            environment: { serverId: 'home-a', environmentId: 'environment-a', projectSourceId: 'source-a' } };
        expect(resolveAutomationSubjectPickerListRead({ kind: { kind: 'database' }, serverId: 'home-a', databaseScope: scope }))
            .toEqual({ kind: 'database', actionId: DATABASE_TARGETS_LIST_ACTION_ID_V1, input: { scope } });
    });

    it('does not pass Home or paging keys into the profile owner’s strict profiles request', () => {
        expect(resolveAutomationSubjectPickerListRead({ kind: { kind: 'approvalProfile' }, serverId: 'home-a', cursor: 'irrelevant' }))
            .toEqual({ kind: 'action', actionId: 'actions.policy.get', serverId: 'home-a', input: { profiles: true } });
    });
});
