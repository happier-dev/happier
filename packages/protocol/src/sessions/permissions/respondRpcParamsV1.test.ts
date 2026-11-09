import { describe, expect, it } from 'vitest';
import { buildSessionPermissionRespondRpcParamsV1, NativePermissionChoicesV1Schema, SessionPermissionRespondRpcParamsV1Schema } from './respondRpcParamsV1.js';
import { getActionSpec } from '../../actions/actionSpecs.js';
import { SessionPermissionRemoteRespondInputV1Schema } from './v1.js';
import { InteractionTransientAuthorRequestV1Schema } from '../../plugins/interactions/transientV1.js';
import { PluginUiRespondToSessionPermissionRequestV1Schema } from '../../plugins/ui/hostApiRequests.js';

const nativeChoice = { requirementId: 'native-requirement', choiceId: 'custom/permit', feedback: 'Proceed carefully' };
const SessionPermissionRespondInputSchema = getActionSpec('session.permission.respond').inputSchema;
const ExecutionRunPermissionRespondInputSchema = getActionSpec('execution.run.permission.respond').inputSchema;

describe('native permission answer carriers', () => {
  it('preserves a native stop payload that restores the restrictive read-only mode', () => {
    const nativeChoices = { requirementId: 'requirement', source: 'native', choices: [
      { id: 'stop', label: 'Stop', decision: 'abort', scope: 'once', response: { approved: false, decision: 'abort', mode: 'read-only' } },
    ] };
    expect(NativePermissionChoicesV1Schema.parse(nativeChoices)).toEqual(nativeChoices);
  });
  it('preserves an opaque native answer through Action to RPC without requiring a caller decision', () => {
    const action = SessionPermissionRespondInputSchema.parse({ sessionId: 'session', requestId: 'request', nativeChoice });
    expect(buildSessionPermissionRespondRpcParamsV1({ id: 'request', nativeChoice: action.nativeChoice })).toEqual({ id: 'request', nativeChoice });
    expect(SessionPermissionRespondRpcParamsV1Schema.parse({ id: 'request', nativeChoice }).nativeChoice).toEqual(nativeChoice);
  });

  it('carries native selection through execution-run and source-scoped remote Actions', () => {
    expect(ExecutionRunPermissionRespondInputSchema.parse({ runId: 'run', requestId: 'request', nativeChoice })).toEqual({ runId: 'run', requestId: 'request', nativeChoice });
    const remote = { sessionId: 'session', turnId: 'turn', requestId: 'request', sourceRef: 'source', sourceRevisionOrEpoch: 'revision', idempotencyKey: 'key', actor: { namespace: 'chat', principalId: 'person' }, nativeChoice };
    expect(SessionPermissionRemoteRespondInputV1Schema.parse(remote)).toEqual(remote);
  });

  it('accepts native answers at the mounted plugin UI boundary', () => {
    const request = { sessionId: 'session', requestId: 'request', nativeChoice };
    expect(PluginUiRespondToSessionPermissionRequestV1Schema.parse(request)).toEqual(request);
  });

  it('preserves offered native choices on authored transient approvals', () => {
    const nativeChoices = { requirementId: 'requirement', source: 'native',
      origin: { sessionId: 'parent', subagentId: 'child', subagentLabel: 'Review the API' },
      choices: [{ id: 'custom', label: 'Allow', decision: 'approved', scope: 'once', response: { approved: true } }] };
    const request = { kind: 'approval', title: 'Run command', subject: { kind: 'tool', name: 'Shell', input: { command: 'pwd' } }, nativeChoices };
    const parsed = InteractionTransientAuthorRequestV1Schema.safeParse(request);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ nativeChoices });
  });

  it('retains legacy decision aliases and rejects an answer with neither carrier', () => {
    expect(buildSessionPermissionRespondRpcParamsV1({ id: 'request', decision: 'deny' })).toEqual({ id: 'request', approved: false, decision: 'denied' });
    expect(SessionPermissionRespondInputSchema.safeParse({ requestId: 'request' }).success).toBe(false);
  });
});
