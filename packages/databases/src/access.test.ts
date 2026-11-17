import { describe, expect, it } from 'vitest';
import { decideDatabaseAccessV1, summarizeDatabaseAccessV1 } from './access';
import * as access from './access';

const editor = { mayWrite: true, editingOff: false };
const reader = { mayWrite: false, editingOff: false };
const off = { mayWrite: false, editingOff: true };

describe('decideDatabaseAccessV1', () => {
    it.each([
        // person × level × operation → decision
        ['person', editor, 'none', 'read', { ok: true, access: 'write' }],
        ['person', editor, 'read', 'write', { ok: true, access: 'write' }],
        ['person', reader, 'read', 'read', { ok: true, access: 'read' }],
        ['person', reader, 'read', 'write', { ok: false, refusal: 'database_not_an_editor' }],
        ['person', off, 'read', 'write', { ok: false, refusal: 'database_editing_off' }],
        ['agent', editor, 'none', 'read', { ok: false, refusal: 'database_agent_access_none' }],
        ['agent', editor, 'none', 'write', { ok: false, refusal: 'database_agent_access_none' }],
        ['agent', editor, 'read', 'read', { ok: true, access: 'read' }],
        ['agent', editor, 'read', 'write', { ok: false, refusal: 'database_agent_access_read_only' }],
        ['agent', reader, 'read', 'write', { ok: false, refusal: 'database_not_an_editor' }],
        ['agent', off, 'read', 'write', { ok: false, refusal: 'database_editing_off' }],
        // D13 write levels (U3): admit agent writes up to the person's class; Ask/no-approval is the applier's input.
        ['agent', editor, 'readWriteAsk', 'write', { ok: true, access: 'write' }],
        ['agent', editor, 'readWriteNoApproval', 'write', { ok: true, access: 'write' }],
        ['agent', editor, 'readWriteAsk', 'read', { ok: true, access: 'write' }],
        ['agent', reader, 'readWriteNoApproval', 'read', { ok: true, access: 'read' }],
        ['agent', reader, 'readWriteAsk', 'write', { ok: false, refusal: 'database_not_an_editor' }],
        ['agent', off, 'readWriteNoApproval', 'write', { ok: false, refusal: 'database_editing_off' }],
    ] as const)('%s %o at %s %s', (requester, person, agentAccess, operation, expected) => {
        expect(decideDatabaseAccessV1({ requester, person, agentAccess, operation })).toEqual(expected);
    });

    it('folds the same decision for display', () => {
        expect(summarizeDatabaseAccessV1({ requester: 'person', person: off, agentAccess: 'read' }))
            .toEqual({ canRead: true, canWrite: false, reason: 'database_editing_off' });
        expect(summarizeDatabaseAccessV1({ requester: 'agent', person: editor, agentAccess: 'none' }))
            .toEqual({ canRead: false, canWrite: false, reason: 'database_agent_access_none' });
        expect(summarizeDatabaseAccessV1({ requester: 'person', person: editor, agentAccess: 'none' }))
            .toEqual({ canRead: true, canWrite: true });
    });
});


describe('resolveDatabaseRequesterKindV1', () => {
    it('distinguishes automation authority from a present person with the same non-agent caller fact', () => {
        expect(access.resolveDatabaseRequesterKindV1({ agentCaller: false, authority: 'present_user' })).toBe('person');
        expect(access.resolveDatabaseRequesterKindV1({ agentCaller: false, authority: 'account_automation' })).toBe('agent');
        expect(access.resolveDatabaseRequesterKindV1({ agentCaller: true, authority: 'present_user' })).toBe('agent');
    });

    it('does not classify an older host with missing admitted facts as a person', () => {
        expect(access.resolveDatabaseRequesterKindV1({})).toBeUndefined();
        expect(access.resolveDatabaseRequesterKindV1({ agentCaller: false })).toBeUndefined();
        expect(access.resolveDatabaseRequesterKindV1({ authority: 'present_user' })).toBeUndefined();
    });
});
