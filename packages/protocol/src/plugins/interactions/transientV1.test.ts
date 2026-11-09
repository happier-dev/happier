import { describe, expect, it } from 'vitest';

import { McpServerCatalogEntryV1Schema } from '../../mcp/servers/settingsV1.js';
import { parseMcpToolWireNameV1 } from '../../mcp/servers/tools/mcpToolIdentityV1.js';
import { createTransientInteractionOwner } from './owner.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { AccountReleasePluginSourceCustodyV1Schema } from '../runtime/sourceCustody.js';
import {
  InteractionTransientAuthorRequestV1Schema,
  InteractionTransientRequestV1Schema,
  InteractionTransientResultV1Schema,
  MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1,
  normalizeInteractionTransientRequestV1,
  validateInteractionTransientSettlementV1,
} from './transientV1.js';

const stamp = {
  requestId: 'request-1',
  scope: { kind: 'session', sessionId: 'session-1' },
  requester: {
    pluginId: 'acme.widgets',
    contributionId: 'settings',
    occurrenceId: 'occurrence-1',
    invocationId: 'invocation-1',
  },
  createdAtMs: 1,
  expiresAtMs: 2,
} as const;

const appScopeStamp = {
  requestId: 'request-app-1',
  scope: { kind: 'app' },
  requester: stamp.requester,
  createdAtMs: 1,
  expiresAtMs: 2,
} as const;

describe('transient interaction contract', () => {
  it('retains production Account-release custody through confirmation and refuses its retired occurrence', async () => {
    const custody = AccountReleasePluginSourceCustodyV1Schema.parse({ kind: 'account_release',
      pluginId: 'happier.triage', version: '0.0.0', archiveDigestSha256: `sha256:${'a'.repeat(64)}` });
    const occurrenceId = createCanonicalJsonSigningInput(custody);
    const requester = { ...appScopeStamp.requester, occurrenceId, invocationId: `ui-action:${occurrenceId}` };
    let currentOccurrence = occurrenceId;
    const owner = createTransientInteractionOwner({ scope: { kind: 'app' }, deadlineMs: null,
      isOccurrenceCurrent: () => currentOccurrence === occurrenceId,
      present: async request => ({ requestId: request.requestId, kind: 'confirmation', status: 'approved' }),
    });
    const request = { kind: 'confirmation', title: 'Continue?', message: 'Continue?' } as const;
    expect(normalizeInteractionTransientRequestV1(request, { ...appScopeStamp, requester })).toMatchObject({
      ok: true, value: { requester },
    });
    expect(await owner.request(request, { requester })).toMatchObject({ status: 'approved' });
    currentOccurrence = 'replacement-occurrence';
    expect(await owner.request(request, { requester })).toMatchObject({ status: 'occurrenceRetired' });
    expect(owner.current()).toEqual([]);
  });
  it('preserves a native tool identity while keeping interaction custody host-owned', () => {
    const normalized = normalizeInteractionTransientRequestV1({ kind: 'approval', title: 'Run command?',
      subject: { kind: 'tool', toolCallId: 'exec-native-command', name: 'Bash', input: { command: 'pwd' } },
    }, stamp);
    expect(normalized).toMatchObject({ ok: true, value: {
      requestId: stamp.requestId, scope: stamp.scope,
      subject: { toolCallId: 'exec-native-command' },
    } });
  });
  it('uses one opaque process-local occurrence requester fence and rejects generation custody aliases', () => {
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...appScopeStamp,
      kind: 'confirmation',
      title: 'Continue?',
      message: 'Continue?',
    }).success).toBe(true);
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...appScopeStamp,
      requester: {
        pluginId: 'acme.widgets',
        contributionId: 'settings',
        generationId: 'generation-1',
        invocationId: 'invocation-1',
      },
      kind: 'confirmation',
      title: 'Continue?',
      message: 'Continue?',
    }).success).toBe(false);
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...appScopeStamp,
      requester: {
        ...appScopeStamp.requester,
        sourceCustody: { kind: 'managed', immutableGenerationId: 'managed-1' },
      },
      kind: 'confirmation',
      title: 'Continue?',
      message: 'Continue?',
    }).success).toBe(false);
  });

  it('accepts host-stamped app scope while rejecting the retired top-level Session stamp', () => {
    const appRequest = {
      ...appScopeStamp,
      kind: 'confirmation',
      title: 'Continue?',
      message: 'Continue with the current operation?',
    } as const;

    expect(InteractionTransientRequestV1Schema.safeParse(appRequest).success).toBe(true);
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...appRequest,
      scope: { kind: 'session', sessionId: 'session-1' },
    }).success).toBe(true);
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...appRequest,
      sessionId: 'retired-top-level-session-id',
    }).success).toBe(false);
  });

  it('keeps scope and Session persistence outside author input', () => {
    expect(normalizeInteractionTransientRequestV1({
      kind: 'confirmation',
      message: 'Continue?',
      scope: { kind: 'app' },
    }, appScopeStamp).ok).toBe(false);

    const appApproval = normalizeInteractionTransientRequestV1({
      kind: 'approval',
      title: 'Run Bash?',
      subject: { kind: 'tool', name: 'Bash', input: { command: 'pwd' } },
      allowSessionPersistence: true,
    }, appScopeStamp);
    expect(appApproval).toMatchObject({ ok: true, value: { scope: { kind: 'app' } } });
    if (appApproval.ok && appApproval.value.kind === 'approval') {
      expect(appApproval.value.allowedPersistenceScopes).toBeUndefined();
    }
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...appScopeStamp,
      kind: 'approval',
      title: 'Run Bash?',
      subject: { kind: 'tool', name: 'Bash', input: { command: 'pwd' } },
      allowedPersistenceScopes: ['session'],
    }).success).toBe(false);
  });

  it('fails closed when author input throws during strict-schema inspection', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(normalizeInteractionTransientRequestV1(proxy, stamp)).toEqual({
      ok: false,
      code: 'invalid_interaction_request',
    });
  });

  it('keeps title and choice-label bounds distinct from prompt and description bounds', () => {
    const overTitle = 't'.repeat(513);
    const maxPrompt = 'p'.repeat(4_096);
    const overLabel = 'l'.repeat(513);

    expect(InteractionTransientRequestV1Schema.safeParse({
      ...stamp,
      kind: 'confirmation',
      title: overTitle,
      message: maxPrompt,
    }).success).toBe(false);
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...stamp,
      kind: 'questions',
      questions: [{
        id: 'reason',
        prompt: maxPrompt,
        type: 'singleChoice',
        choices: [{ id: 'continue', label: overLabel }],
      }],
    }).success).toBe(false);
  });

  it('owns the retained tool-approval and structured-question semantics in the normalized request', () => {
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...stamp,
      kind: 'approval',
      title: 'Run Bash?',
      description: 'The Agent requests a shell command.',
      subject: { kind: 'tool', name: 'Bash', input: { command: 'pwd' } },
      allowedPersistenceScopes: ['session'],
    }).success).toBe(true);

    expect(InteractionTransientRequestV1Schema.safeParse({
      ...stamp,
      kind: 'questions',
      title: 'Choose a mode',
      questions: [{
        id: 'mode',
        prompt: 'Which mode should be used?',
        description: 'This choice controls the current operation.',
        type: 'singleChoice',
        required: true,
        allowCustom: true,
        choices: [{ id: 'safe', label: 'Safe', description: 'Make no destructive changes.' }],
      }],
    }).success).toBe(true);
  });

  it('preserves editable initial content for text questions', () => {
    expect(normalizeInteractionTransientRequestV1({
      kind: 'questions',
      questions: [{
        id: 'notes',
        prompt: 'Edit the notes',
        type: 'text',
        required: true,
        initialValue: 'Existing notes',
      }],
    }, stamp)).toMatchObject({
      ok: true,
      value: {
        questions: [{
          id: 'notes',
          type: 'text',
          initialValue: 'Existing notes',
        }],
      },
    });
  });

  it('preserves complete catalog-admitted MCP tool identities through author normalization and the strict reader', async () => {
    const server = McpServerCatalogEntryV1Schema.parse({
      id: 'server-long',
      name: `server_${'a'.repeat(128)}`,
      transport: 'stdio',
      stdio: { command: 'fixture-mcp', args: [] },
      env: {},
      createdAt: 1,
      updatedAt: 1,
      toolsSnapshot: {
        checkedAt: 1,
        machineId: 'machine-1',
        tools: [{ name: `tool_${'🛠'.repeat(200)}`, tokens: 1 }],
      },
    });
    const tool = server.toolsSnapshot!.tools[0]!;
    const wireName = `mcp__${server.name}__${tool.name}`;
    expect(parseMcpToolWireNameV1(wireName, new Set([server.name]))).toEqual({
      server: server.name, tool: tool.name,
    });

    const author = {
      kind: 'approval' as const,
      title: 'Run MCP tool?',
      subject: { kind: 'tool' as const, name: wireName, input: { text: 'original input' } },
    };
    const normalized = normalizeInteractionTransientRequestV1(author, stamp);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) throw new Error('The complete MCP identity was rejected.');
    const consumed = InteractionTransientRequestV1Schema.parse(JSON.parse(JSON.stringify(normalized.value)));
    expect(consumed).toMatchObject({
      kind: 'approval',
      subject: { kind: 'tool', name: wireName, input: { text: 'original input' } },
    });
    const owner = createTransientInteractionOwner({
      scope: stamp.scope,
      sessionSignal: new AbortController().signal,
      deadlineMs: null,
      isOccurrenceCurrent: () => true,
      createRequestId: () => stamp.requestId,
      present: async (request) => {
        const received = InteractionTransientRequestV1Schema.parse(JSON.parse(JSON.stringify(request)));
        expect(received).toMatchObject({ kind: 'approval', subject: author.subject });
        return { requestId: received.requestId, kind: 'approval', status: 'approved' };
      },
    });
    await expect(owner.request(author, { requester: stamp.requester })).resolves.toEqual({
      requestId: stamp.requestId, kind: 'approval', status: 'approved',
    });
    expect(owner.current()).toEqual([]);
  });

  it('uses the existing whole-request byte budget for complete tool names in author and normalized requests', () => {
    const author = {
      kind: 'approval',
      title: 'Run MCP tool?',
      subject: { kind: 'tool', name: '', input: {} },
    } as const;
    const encoder = new TextEncoder();
    const normalizedBase = { ...stamp, ...author };
    const name = 'n'.repeat(MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1 - encoder.encode(JSON.stringify(normalizedBase)).byteLength);
    const atBudget = { ...author, subject: { ...author.subject, name } };
    const normalized = normalizeInteractionTransientRequestV1(atBudget, stamp);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) throw new Error('The request at the existing byte budget was rejected.');
    expect(encoder.encode(JSON.stringify(normalized.value)).byteLength).toBe(MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1);

    const aboveNormalizedBudget = { ...atBudget, subject: { ...atBudget.subject, name: `${name}n` } };
    expect(InteractionTransientAuthorRequestV1Schema.safeParse(aboveNormalizedBudget).success).toBe(true);
    expect(normalizeInteractionTransientRequestV1(aboveNormalizedBudget, stamp)).toEqual({
      ok: false, code: 'invalid_interaction_request',
    });
    expect(InteractionTransientRequestV1Schema.safeParse({ ...stamp, ...aboveNormalizedBudget }).success).toBe(false);
    const aboveAuthorBudget = { ...author, subject: { ...author.subject, name: 'n'.repeat(MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1) } };
    expect(InteractionTransientAuthorRequestV1Schema.safeParse(aboveAuthorBudget).success).toBe(false);
    expect(normalizeInteractionTransientRequestV1(aboveAuthorBudget, stamp)).toEqual({
      ok: false, code: 'invalid_interaction_request',
    });
  });

  it('keeps approval tool names nonempty, Unicode-valid and closed while retaining short request and question identifiers', () => {
    const author = {
      kind: 'approval', title: 'Run tool?', subject: { kind: 'tool', name: 'Bash', input: {} },
    } as const;
    for (const name of ['', 'mcp__server__\ud800', 'mcp__server__\udc00']) {
      const invalid = { ...author, subject: { ...author.subject, name } };
      expect(normalizeInteractionTransientRequestV1(invalid, stamp)).toEqual({ ok: false, code: 'invalid_interaction_request' });
      expect(InteractionTransientRequestV1Schema.safeParse({ ...stamp, ...invalid }).success).toBe(false);
    }
    expect(normalizeInteractionTransientRequestV1({
      ...author, subject: { ...author.subject, unexpected: true },
    }, stamp)).toEqual({ ok: false, code: 'invalid_interaction_request' });
    const longId = 'i'.repeat(129);
    expect(normalizeInteractionTransientRequestV1(author, { ...stamp, requestId: longId })).toEqual({
      ok: false, code: 'invalid_interaction_request',
    });
    for (const invalidRequester of [
      { ...stamp.requester, occurrenceId: 'i'.repeat(513) },
      { ...stamp.requester, occurrenceId: '\ud800' },
      { ...stamp.requester, invocationId: '' },
      { ...stamp.requester, invocationId: '\ud800' },
      { ...stamp.requester, invocationId: 'i'.repeat(MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1) },
    ]) {
      expect(normalizeInteractionTransientRequestV1(author, { ...stamp, requester: invalidRequester })).toEqual({
        ok: false, code: 'invalid_interaction_request',
      });
    }
    expect(normalizeInteractionTransientRequestV1({
      kind: 'questions', questions: [{ id: longId, prompt: 'Why?', type: 'text' }],
    }, stamp)).toEqual({ ok: false, code: 'invalid_interaction_request' });
  });

  it('rejects unknown keys, duplicate question ids, and mismatched terminal kinds', () => {
    const request = InteractionTransientRequestV1Schema.parse({
      ...stamp,
      kind: 'questions',
      questions: [{ id: 'reason', prompt: 'Why?', type: 'text', required: false }],
    });
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...request,
      unexpected: true,
    }).success).toBe(false);
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...stamp,
      kind: 'questions',
      questions: [
        { id: 'same', prompt: 'One?', type: 'text', required: false },
        { id: 'same', prompt: 'Two?', type: 'text', required: false },
      ],
    }).success).toBe(false);
    expect(InteractionTransientResultV1Schema.safeParse({
      requestId: request.requestId, kind: 'questions', status: 'approved',
    }).success).toBe(false);
  });

  it('rejects malformed Unicode anywhere in normalized strict JSON input', () => {
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...stamp,
      kind: 'approval',
      title: 'Run tool?',
      subject: {
        kind: 'tool',
        name: 'Bash',
        input: { command: '\ud800' },
      },
    }).success).toBe(false);
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...stamp,
      kind: 'approval',
      title: 'Run tool?',
      subject: {
        kind: 'tool',
        name: 'Bash',
        input: { ['bad\ud800']: 'value' },
      },
    }).success).toBe(false);
  });

  it('allows one kind-compatible terminal settlement and rejects a late incompatible answer', () => {
    const request = InteractionTransientRequestV1Schema.parse({
      ...stamp,
      kind: 'confirmation',
      title: 'Continue?',
      message: 'Continue with the current operation?',
    });
    expect(validateInteractionTransientSettlementV1(request, {
      requestId: request.requestId, kind: 'confirmation', status: 'declined',
    })).toEqual({ ok: true });
    expect(validateInteractionTransientSettlementV1(request, {
      requestId: request.requestId, kind: 'questions', status: 'answered', answers: {},
    })).toEqual({ ok: false, code: 'interaction_kind_mismatch' });
  });

  it('represents an explicit no-deadline request while still rejecting a non-advancing expiry', () => {
    const { expiresAtMs: _finiteExpiry, ...noDeadlineStamp } = stamp;

    const noDeadline = normalizeInteractionTransientRequestV1({
      kind: 'confirmation',
      message: 'Continue?',
    }, noDeadlineStamp);
    expect(noDeadline.ok).toBe(true);
    expect(noDeadline.ok && noDeadline.value).not.toHaveProperty('expiresAtMs');
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...noDeadlineStamp,
      kind: 'confirmation',
      title: 'Continue?',
      message: 'Continue with the current operation?',
    }).success).toBe(true);

    for (const expiresAtMs of [stamp.createdAtMs, stamp.createdAtMs - 1]) {
      expect(InteractionTransientRequestV1Schema.safeParse({
        ...noDeadlineStamp,
        expiresAtMs,
        kind: 'confirmation',
        title: 'Continue?',
        message: 'Continue with the current operation?',
      }).success).toBe(false);
    }
  });

  it('rejects lifecycle-only statuses from a presenter, including Session-ended in app scope', () => {
    const request = InteractionTransientRequestV1Schema.parse({
      ...appScopeStamp,
      kind: 'confirmation',
      title: 'Continue?',
      message: 'Continue with the current operation?',
    });

    for (const status of [
      'requesterAborted',
      'timedOut',
      'sessionEnded',
      'occurrenceRetired',
      'hostRestarted',
      'unavailable',
    ] as const) {
      expect(validateInteractionTransientSettlementV1(request, {
        requestId: request.requestId,
        kind: 'confirmation',
        status,
      })).toEqual({ ok: false, code: 'owner_only_interaction_terminal_status' });
    }
  });

  it('validates selected choices and required answers against the stamped question request', () => {
    const request = InteractionTransientRequestV1Schema.parse({
      ...stamp,
      kind: 'questions',
      questions: [{
        id: 'mode',
        prompt: 'Which mode?',
        type: 'singleChoice',
        required: true,
        allowCustom: false,
        choices: [{ id: 'safe', label: 'Safe' }],
      }],
    });

    expect(validateInteractionTransientSettlementV1(request, {
      requestId: request.requestId,
      kind: 'questions',
      status: 'answered',
      answers: { mode: { kind: 'singleChoice', answer: { kind: 'choice', choiceId: 'safe' } } },
    })).toEqual({ ok: true });
    expect(validateInteractionTransientSettlementV1(request, {
      requestId: request.requestId,
      kind: 'questions',
      status: 'answered',
      answers: {},
    })).toEqual({ ok: false, code: 'invalid_interaction_answer' });
    expect(validateInteractionTransientSettlementV1(request, {
      requestId: request.requestId,
      kind: 'questions',
      status: 'answered',
      answers: { mode: { kind: 'singleChoice', answer: { kind: 'choice', choiceId: 'unsafe' } } },
    })).toEqual({ ok: false, code: 'invalid_interaction_answer' });
  });

  it('rejects approval persistence that the stamped request did not authorize', () => {
    const onceOnly = InteractionTransientRequestV1Schema.parse({
      ...stamp,
      kind: 'approval',
      title: 'Run Bash?',
      subject: { kind: 'tool', name: 'Bash', input: { command: 'pwd' } },
    });
    expect(validateInteractionTransientSettlementV1(onceOnly, {
      requestId: onceOnly.requestId,
      kind: 'approval',
      status: 'approved',
      persistence: 'session',
    })).toEqual({ ok: false, code: 'invalid_interaction_persistence' });

    const sessionAllowed = InteractionTransientRequestV1Schema.parse({
      ...onceOnly,
      allowedPersistenceScopes: ['session'],
    });
    expect(validateInteractionTransientSettlementV1(sessionAllowed, {
      requestId: sessionAllowed.requestId,
      kind: 'approval',
      status: 'approved',
      persistence: 'session',
    })).toEqual({ ok: true });
    expect(InteractionTransientResultV1Schema.safeParse({
      requestId: sessionAllowed.requestId,
      kind: 'approval',
      status: 'declined',
      persistence: 'session',
    }).success).toBe(false);
  });
});
