// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit, type PluginUiTestkitHostHandlers } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { useReleaseSessionHelpV1 } from './useReleaseSessionHelp.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const repository = { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' } as const;
const selection = { configuredActionId: 'release-review', sessionChoice: { kind: 'new' }, agentChoice: { kind: 'configured' }, delivery: 'compose' } as const;
const evidence = { selector: { kind: 'proposed', tagName: 'v7', targetCommitish: 'main' }, proposedNotes: 'Keep my unsaved notes' } as const;
const composed = { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } } as const;
const refusedHandoffs: readonly { outcome: JsonValue; code: string }[] = [
  { outcome: { v: 1, handoff: { kind: 'unavailable', reason: 'composerUnavailable' } }, code: 'composerUnavailable' },
  { outcome: { ok: true, result: { v: 1, handoff: { kind: 'selectionRequired', fields: ['agentChoice'] } } }, code: 'selection_required' },
  { outcome: { ok: false, errorCode: 'plugin_action_generation_retired', error: 'Refused' }, code: 'plugin_action_generation_retired' },
  { outcome: { v: 1, handoff: { kind: 'uncertain', phase: 'create', session: null } }, code: 'uncertain' },
];
const refusedChoices: JsonValue[] = [
  { v: 1, kind: 'choices', actions: [{ label: 'Not a default', selection }], defaultActionId: null },
  { v: 1, kind: 'unavailable', reason: 'catalogUnavailable' },
  { ok: false, errorCode: 'choice_refused', error: 'Unavailable' },
];
async function mount(executeAction: PluginUiTestkitHostHandlers['executeAction'], notify?: PluginUiTestkitHostHandlers['notify']) {
  let help!: ReturnType<typeof useReleaseSessionHelpV1>;
  const lifetime = new AbortController();
  function Body({ context }: { context: RenderContext }) {
    help = useReleaseSessionHelpV1({ ...context, signal: lifetime.signal });
    return <Text value="Release help fixture" />;
  }
  let fixture!: PluginUiTestkit;
  await act(async () => { fixture = await createPluginUiTestkit({ identity: { instanceId: 'release-help', mountNonce: 'release-help-mount' },
    authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
    surfaceContext: createSurfaceContextFixture({ target: { kind: 'project', projectKey: 'project', repository } }),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(), surface: defineUiSurface(context => <Body context={context} />),
    handlers: { executeAction, ...(notify ? { notify } : {}) },
  }); });
  return { help, lifetime, dispose: () => act(async () => { lifetime.abort(); await fixture.dispose(); }) };
}

describe('release session-help consumer', () => {
  it.each(refusedHandoffs)('presents an unsuccessful handoff once without replaying it ($code)', async ({ outcome, code }) => {
    const calls: string[] = [];
    const notices: Array<{ message: string; severity?: string }> = [];
    const fixture = await mount(async request => {
      const id = (request.action as { localId: string }).localId; calls.push(id);
      if (id === 'github/releases/notes-context-read') return { kind: 'value', value: {
        kind: 'releaseNotes', repository, selector: evidence.selector, contextText: 'Selected facts',
      } };
      return outcome;
    }, async notice => { notices.push(notice); });
    try {
      expect(calls).toEqual([]); expect(notices).toEqual([]);
      expect(await fixture.help({ kind: 'notes', releaseId: null }, evidence, selection)).toEqual(outcome);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.severity).toBe('warning');
      expect(notices[0]?.message).toContain(code);
      expect(calls).toEqual(['github/releases/notes-context-read', 'sessions/run-configured-v1']);
    } finally { await fixture.dispose(); }
  });

  it('keeps an uncertain transport rejection visible and never retries configured delivery', async () => {
    const failure = new PluginError({ code: 'timeout', details: { requestId: 'help-request-42' } });
    const notices: Array<{ message: string; severity?: string }> = [];
    const calls: string[] = [];
    const fixture = await mount(async request => {
      const id = (request.action as { localId: string }).localId; calls.push(id);
      if (id === 'github/releases/notes-context-read') return { kind: 'value', value: {
        kind: 'releaseNotes', repository, selector: evidence.selector, contextText: 'Selected facts',
      } };
      throw failure;
    }, async notice => { notices.push(notice); });
    try {
      await expect(fixture.help({ kind: 'notes', releaseId: null }, evidence, selection)).rejects.toMatchObject({ code: 'timeout' });
      expect(notices).toHaveLength(1);
      expect(notices[0]?.severity).toBe('warning');
      expect(notices[0]?.message).toContain('timeout');
      expect(notices[0]?.message).toContain('Request ID: help-request-42');
      expect(calls).toEqual(['github/releases/notes-context-read', 'sessions/run-configured-v1']);
    } finally { await fixture.dispose(); }
  });

  it('retains the provider failure and request ID when release evidence is unavailable', async () => {
    const outcome = { kind: 'unavailable', failure: { class: 'transient', code: 'github_rate_limited', requestId: 'github-help-17' } } satisfies JsonValue;
    const notices: string[] = [];
    const fixture = await mount(async () => outcome, async notice => { notices.push(notice.message); });
    try {
      expect(await fixture.help({ kind: 'notes', releaseId: null }, evidence, selection)).toEqual(outcome);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('Code: github_rate_limited');
      expect(notices[0]).toContain('Request ID: github-help-17');
    } finally { await fixture.dispose(); }
  });

  it('retains a refused Action request ID in its existing warning', async () => {
    const outcome = { ok: false, errorCode: 'help_refused', error: 'Refused', requestId: 'help-action-18' } satisfies JsonValue;
    const notices: string[] = [];
    const fixture = await mount(async () => outcome, async notice => { notices.push(notice.message); });
    try {
      expect(await fixture.help({ kind: 'notes', releaseId: null }, evidence, selection)).toEqual(outcome);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('Code: help_refused');
      expect(notices[0]).toContain('Request ID: help-action-18');
    } finally { await fixture.dispose(); }
  });

  it('keeps unsaved notes in canonical handoff evidence and preserves the explicit selection/result', async () => {
    const calls: string[] = [];
    const notices: string[] = [];
    const fixture = await mount(async (request): Promise<JsonValue> => {
      const id = (request.action as { localId: string }).localId;
      calls.push(id);
      if (id === 'github/releases/notes-context-read') return { ok: true, result: { kind: 'value', value: {
        kind: 'releaseNotes', repository, selector: evidence.selector, contextText: 'Selected facts',
      } } };
      expect(request.input).toMatchObject({ handoff: { task: 'draftReleaseNotes', ...selection,
        evidence: [{ ...evidence, kind: 'releaseNotes' }] } });
      return composed;
    }, async ({ message }) => { notices.push(message); });
    try {
      expect(calls).toEqual([]);
      expect(await fixture.help({ kind: 'notes', releaseId: null }, evidence, selection)).toEqual(composed);
      expect(calls).toEqual(['github/releases/notes-context-read', 'sessions/run-configured-v1']);
      expect(notices).toEqual([]);
    } finally { await fixture.dispose(); }
  });

  it('preserves delivery custody when the host cannot present feedback', async () => {
    const outcome = { v: 1, handoff: { kind: 'unavailable', reason: 'composerUnavailable' } } satisfies JsonValue;
    const calls: string[] = [];
    const fixture = await mount(async request => {
      const id = (request.action as { localId: string }).localId; calls.push(id);
      if (id === 'github/releases/notes-context-read') return { kind: 'value', value: {
        kind: 'releaseNotes', repository, selector: evidence.selector, contextText: 'Selected facts',
      } };
      return outcome;
    }, async () => { throw new PluginError({ code: 'unavailable' }); });
    try {
      expect(await fixture.help({ kind: 'notes', releaseId: null }, evidence, selection)).toEqual(outcome);
      expect(calls).toEqual(['github/releases/notes-context-read', 'sessions/run-configured-v1']);
    } finally { await fixture.dispose(); }
  });

  it.each(refusedChoices)('never substitutes the first row or dispatches after a non-choice result %#', async offered => {
    const calls: string[] = [];
    const fixture = await mount(async (request): Promise<JsonValue> => { calls.push((request.action as { localId: string }).localId); return offered; });
    try {
      const result = await fixture.help({ kind: 'draft' }, evidence);
      // No default: the offered rows come back for the person to choose; none is taken for them.
      expect(result).toEqual(offered && typeof offered === 'object' && 'defaultActionId' in offered
        ? { kind: 'choose', actions: offered.actions } : offered);
      expect(calls).toEqual(['actions/read-v1']);
    } finally { await fixture.dispose(); }
  });

  it('offers every configured action on request even when one is the default, then sends only the chosen one', async () => {
    const calls: string[] = [];
    const handoffs: unknown[] = [];
    const other = { ...selection, configuredActionId: 'changelog' };
    const offered = { v: 1, kind: 'choices', defaultActionId: 'release-review',
      actions: [{ label: 'Release review', selection }, { label: 'Changelog', selection: other }] } as const;
    const fixture = await mount(async (request): Promise<JsonValue> => {
      const id = (request.action as { localId: string }).localId; calls.push(id);
      if (id === 'actions/read-v1') return offered;
      if (id === 'github/releases/notes-context-read') return { kind: 'value', value: {
        kind: 'releaseNotes', repository, selector: evidence.selector, contextText: 'Selected facts' } };
      handoffs.push(request.input);
      return composed;
    });
    try {
      expect(await fixture.help({ kind: 'draft' }, evidence, 'choose')).toEqual({ kind: 'choose', actions: offered.actions });
      expect(calls).toEqual(['actions/read-v1']);
      expect(handoffs).toEqual([]);
      expect(await fixture.help({ kind: 'draft' }, evidence, other)).toEqual(composed);
      expect(calls).toEqual(['actions/read-v1', 'github/releases/notes-context-read', 'sessions/run-configured-v1']);
      expect(handoffs).toEqual([expect.objectContaining({ handoff: expect.objectContaining({ configuredActionId: 'changelog' }) })]);
    } finally { await fixture.dispose(); }
  });

  it('does not send a Session handoff when the renderer retires during the evidence read', async () => {
    let settle!: (value: JsonValue) => void;
    const pending = new Promise<JsonValue>(resolve => { settle = resolve; });
    const calls: string[] = [];
    const fixture = await mount(async request => { calls.push((request.action as { localId: string }).localId); return pending; });
    try {
      const result = fixture.help({ kind: 'notes', releaseId: null }, evidence, selection);
      fixture.lifetime.abort();
      settle({ kind: 'value', value: { kind: 'releaseNotes', repository, selector: evidence.selector, contextText: 'Selected facts' } });
      await result;
      expect(calls).toEqual(['github/releases/notes-context-read']);
    } finally { await fixture.dispose(); }
  });
});
