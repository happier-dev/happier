import { describe, expect, it } from 'vitest';
import { AgentSessionProviderCheckpointMaxJsonBytesV1 } from '../../runtime/agentSessionV1.js';
import { SessionInputResultGetInputV1Schema, SessionInputResultGetResultV1Schema, SessionInputRefusalDispositionV1Schema } from './sessionInputResultV1.js';
import { SessionMessageReplyReadResultV1Schema } from './sessionMessageReplyV1.js';
import { SessionInputAdmissionRejectionCodeV1Schema } from './sessionInputAdmissionRejectionV1.js';

describe('exact Session input result import boundary', () => {
    it('keeps the canonical input refusal readable through the strict result contract', () => {
        const code = SessionInputAdmissionRejectionCodeV1Schema.parse('session_input_target_unavailable');
        expect(SessionInputResultGetResultV1Schema.parse({ ok: false, code })).toEqual({ ok: false, code });
        const disposition = { localId: 'input', result: { status: 'rejected', code } };
        expect(SessionInputRefusalDispositionV1Schema.parse(disposition)).toEqual(disposition);
        expect(SessionInputRefusalDispositionV1Schema.safeParse({ ...disposition, unknown: true }).success).toBe(false);
        expect(SessionInputResultGetResultV1Schema.safeParse({ ok: false, code: 'unregistered_refusal' }).success).toBe(false);
    });

    it('admits exact original reply custody as a distinct read projection', () => {
        const input = { sessionId: 'session', localId: 'input', projection: 'reply' };
        const reply = SessionMessageReplyReadResultV1Schema.parse({ v: 1, status: 'available',
            progress: { v: 1, mode: 'wait', disposition: 'inline', outcome: { kind: 'pass' } } });
        expect(SessionInputResultGetInputV1Schema.parse(input)).toEqual(input);
        expect(SessionInputResultGetResultV1Schema.parse({ ok: true, sessionId: 'session', localId: 'input',
            projection: 'reply', reply })).toMatchObject({ projection: 'reply', reply });
        expect(SessionInputResultGetResultV1Schema.safeParse({ ok: true, sessionId: 'session', localId: 'input',
            projection: 'reply', result: { kind: 'pending' } }).success).toBe(false);
    });
    it('loads the native runtime before the result projection without an admission cycle', () => {
        expect(AgentSessionProviderCheckpointMaxJsonBytesV1).toBeGreaterThan(0);
        expect(SessionInputResultGetResultV1Schema.parse({ ok: true, sessionId: 'session', localId: 'input',
            turnStatus: 'waiting', result: { kind: 'pending' } })).toMatchObject({ turnStatus: 'waiting' });
    });
});
