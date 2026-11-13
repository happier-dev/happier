import { describe, expect, it } from 'vitest';
import { ActionIdSchema, isSessionAccessActionId } from './actionIds.js';
import { getActionSpec, resolveActionExecutionPlacementForInput } from './actionSpecs.js';
import { PluginInvocableActionIdSchema } from './pluginActionSurface.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { SessionAccessCandidatesInspectRequestV1Schema, ResolveSessionAccessPrincipalsRequestV1Schema } from '../sessions/access/sessionAccessOperationsV1.js';
import { UsersSearchQueryV1Schema } from '../social/friends.js';
import { projectSessionPublicLinkActionResultV1, projectSessionPublicLinkCreateActionResultV1 } from '../sessions/access/sessionAccessActionsV1.js';
import { bindSessionAccessActionHttpRequestV1 } from './sessionAccessActionFamily.js';

describe('Session access Action contracts', () => {
  it('privately issues Session links on the answering client for agent callers and keeps direct people on Account placement', () => {
    const spec = getActionSpec('session.public_link.create');
    const input = { sessionId: 'shared-session' };
    expect(resolveActionExecutionPlacementForInput(spec, input, { kind: 'session' })).toBe('client');
    expect(resolveActionExecutionPlacementForInput(spec, input, { kind: 'workflowRun' })).toBe('client');
    expect(resolveActionExecutionPlacementForInput(spec, input, { kind: 'host' })).toBe('account');
    expect(resolveActionExecutionPlacementForInput(spec, input)).toBe('account');
  });
  it('routes manual crypto and layout intents to the connected client with strict non-secret operands and the shared Ask-first floor', () => {
    for (const [name, input] of [
      ['session.access.encryption.prepare', { sessionId: 's' }],
      ['session.access.encryption.reprepare', { sessionId: 's', recipientAccountId: 'recipient' }],
      ['session.access.layout.update', { sessionId: 's' }],
    ] as const) {
      const id = ActionIdSchema.parse(name);
      const spec = getActionSpec(id);
      expect(isSessionAccessActionId(id)).toBe(true);
      expect(PluginInvocableActionIdSchema.safeParse(id).success).toBe(true);
      expect(spec.executionPlacement).toBe('client');
      expect(spec.cli?.acceptsServerId).toBe(true);
      expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true });
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      expect(spec.inputSchema.safeParse({ ...input, encryptedDataKey: 'caller-owned' }).success).toBe(false);
      expect(resolveActionApprovalRouting({ actionId: id, spec, input,
        context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(true);
      expect(resolveActionApprovalRouting({ actionId: id, spec, input,
        context: { surface: 'ui', authority: 'present_user' } }).required).toBe(false);
      expect(resolveActionApprovalRouting({ actionId: id, spec, input,
        context: { surface: 'ui', authority: 'present_user' } }).uiConfirmationRequired === true).toBe(name === 'session.access.layout.update');
    }
  });
  it('exposes sharing discovery reads to agents and plugins through the existing server contracts', () => {
    const reads = [
      { id: 'session.access.candidates.inspect', input: { v: 1, sessionId: 'session-1', subjects: [{ kind: 'account', accountId: 'recipient' }] },
        path: '/v2/sessions/access-candidates/inspect', schema: SessionAccessCandidatesInspectRequestV1Schema },
      { id: 'session.access.principals.resolve', input: { v: 1, subjects: [], creationTeamId: 'team-1' },
        path: '/v1/session-access/principals/resolve', schema: ResolveSessionAccessPrincipalsRequestV1Schema },
    ];
    for (const read of reads) {
      const id = ActionIdSchema.parse(read.id);
      expect(isSessionAccessActionId(id)).toBe(true);
      expect(PluginInvocableActionIdSchema.safeParse(id).success).toBe(true);
      const spec = getActionSpec(id);
      expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true });
      expect(spec).toMatchObject({ safety: 'safe', sideEffectClass: 'read', executionPlacement: 'account', requiredAuthority: 'account_automation' });
      expect(resolveActionApprovalRouting({ actionId: id, spec, input: read.input,
        context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(false);
      if (!isSessionAccessActionId(id)) throw new Error('Missing sharing read family');
      const request = bindSessionAccessActionHttpRequestV1(id, read.input);
      expect(request).toEqual({ method: 'POST', path: read.path, body: read.input });
      expect(read.schema.parse(request.body)).toEqual(read.input);
      expect(spec.inputSchema.safeParse({ ...read.input, uncheckedAuthority: true }).success).toBe(false);
    }
  });

  it('binds ordinary recipient search to collaboration discovery without permitting management or social scope', () => {
    const id = ActionIdSchema.parse('session.access.accounts.search');
    expect(isSessionAccessActionId(id)).toBe(true);
    expect(PluginInvocableActionIdSchema.safeParse(id).success).toBe(true);
    const spec = getActionSpec(id);
    const input = { query: 'a & b', purpose: 'collaboration', cursor: 'opaque-cursor' };
    expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true });
    expect(spec).toMatchObject({ safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation' });
    if (!isSessionAccessActionId(id)) throw new Error('Missing sharing search family');
    const request = bindSessionAccessActionHttpRequestV1(id, input);
    expect(request).toEqual({ method: 'GET', path: '/v1/user/search?query=a+%26+b&cursor=opaque-cursor&purpose=collaboration', body: undefined });
    expect(UsersSearchQueryV1Schema.parse(Object.fromEntries(new URL(request.path, 'https://home.example').searchParams))).toEqual(input);
    for (const invalid of [{ query: 'a' }, { ...input, purpose: 'social' }, { ...input, scope: { kind: 'home' } }]) {
      expect(spec.inputSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('creates current Session publications only through the generalized owner, never the legacy token writer', () => {
    expect(bindSessionAccessActionHttpRequestV1('session.public_link.create', {
      sessionId: 's/id', maxUses: 3, isConsentRequired: true,
    })).toEqual({ method: 'POST', path: '/v1/public-shares', body: {
      subject: { kind: 'session', id: 's/id' }, maxUses: 3, isConsentRequired: true,
    } });
  });
  it('preserves the default publication wire shape and requires confirmation of a requested network-off policy', () => {
    const input = { sessionId: 's/id', isConsentRequired: false };
    expect(bindSessionAccessActionHttpRequestV1('session.public_link.create', { ...input, networkOff: false }))
      .toEqual(bindSessionAccessActionHttpRequestV1('session.public_link.create', input));
    expect(bindSessionAccessActionHttpRequestV1('session.public_link.create', { ...input, networkOff: true }).body)
      .toMatchObject({ networkOff: true });
    const response = { viewerOrigin: 'https://home.example', publicShare: {
      id: 'publication', updatedAt: 1, expiresAt: null, maxUses: null, useCount: 0,
      isConsentRequired: false, keyDerivation: 'fragment_v1',
    } };
    const material = { lookupId: 'A'.repeat(43), secret: 'B'.repeat(43) };
    expect(projectSessionPublicLinkCreateActionResultV1(response, material, false, true)).not.toHaveProperty('url');
    expect(() => projectSessionPublicLinkCreateActionResultV1(response, material, true)).toThrow();
    expect(() => projectSessionPublicLinkCreateActionResultV1({ ...response,
      publicShare: { ...response.publicShare, networkOff: false } }, material, true)).toThrow();
    expect(projectSessionPublicLinkCreateActionResultV1(response, material, false)).toMatchObject({
      id: 'publication', viewerOrigin: 'https://home.example', url: `https://home.example/s/${material.lookupId}#k=${material.secret}`,
    });
    expect(projectSessionPublicLinkCreateActionResultV1({ ...response,
      publicShare: { ...response.publicShare, networkOff: true } }, material, true)).toMatchObject({ networkOff: true });
  });
  it('admits logical desired-state grants and excludes host encryption material', () => {
    const id = ActionIdSchema.parse('session.access.grant.set');
    const spec = getActionSpec(id);
    const input = { sessionId: 's', subject: { kind: 'account', accountId: 'a' }, accessLevel: 'edit', canApprovePermissions: false };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, accountEnvelopeInput: {} }).success).toBe(false);
    expect(spec.serverTransport).toEqual({ method: 'POST', path: '/v2/sessions/access-grants/set' });
    expect(spec.requiredAuthority).toBe('account_automation');
    expect(spec.safety).toBe('danger');
  });
  it('keeps publication results free of bearer material', () => {
    const spec = getActionSpec(ActionIdSchema.parse('session.public_link.get'));
    const settings = {
      id: 'publication', updatedAt: 7,
      expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false,
    };
    expect(spec.outputSchema?.safeParse(settings).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ ...settings, token: 'bearer' }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ ...settings, encryptedDataKey: 'key' }).success).toBe(false);
  });
  it('carries the non-secret publication identity a trusted host needs to prove a change', () => {
    // An ambiguous create can only be settled by observing that the
    // authoritative publication is a different row or a later revision than
    // the pre-mutation snapshot. Those two facts are publication metadata,
    // not bearer material, so they belong in the one canonical result.
    const spec = getActionSpec(ActionIdSchema.parse('session.public_link.create'));
    const settings = { expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false };
    expect(spec.outputSchema?.safeParse(settings).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ ...settings, id: 'publication', updatedAt: 7 }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ ...settings, id: 'publication', updatedAt: 7, url: 'https://public.example/s/lookup#k=secret' }).success).toBe(true);
  });
  it('projects publication identity from the released owner response without its bearer', () => {
    const projected = projectSessionPublicLinkActionResultV1({
      publicShare: {
        id: 'publication', sessionId: 's', token: 'bearer',
        expiresAt: 5, maxUses: 3, useCount: 1, isConsentRequired: true,
        createdAt: 1, updatedAt: 9,
      },
    });
    expect(projected).toEqual({
      id: 'publication', updatedAt: 9,
      expiresAt: 5, maxUses: 3, useCount: 1, isConsentRequired: true,
    });
    expect(projectSessionPublicLinkActionResultV1({ publicShare: null })).toBeNull();
  });
});
