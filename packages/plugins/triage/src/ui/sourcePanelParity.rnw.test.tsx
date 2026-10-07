// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { defineUiSurface, usePluginHostApi } from '@happier-dev/plugin-ui';
import { TriageEvidenceDisclosureProvider, type TriageSourcePanelCommandV1, triageSourcePanelActionIdV1, type TriageSourcePanelOperationV1 } from '@happier-dev/triage-sources/ui';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { isApprovalRequiredByActionsSettings, normalizeActionsSettingsV1, pluginActionRequiresPresentUserIntent } from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { renderSurface as renderSentry } from '../../../sentry/src/ui/renderSurface.js';
import { renderSurface as renderPosthog } from '../../../posthog/src/ui/renderSurface.js';
import { SENTRY_ACTION_IDS } from '../../../sentry/src/sentryContracts.js';
import { POSTHOG_ACTION_IDS } from '../../../posthog/src/posthogContracts.js';
import { encodeSentryInstanceConfiguration } from '../../../sentry/src/instances/sentryInstanceConfiguration.js';
import { encodePosthogConfiguration } from '../../../posthog/src/source/instance.js';
import { useTriageTierBEvidenceInsertion } from '../composer/tierBEvidenceInsertion.js';
import { createTriageMountedUiActionHandler, createTriageMountedSourceInsertActionHandler, createTriageMountedSourceRevealActionHandler } from '../actions/mountedUi.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { bindTriageMountedUiActions } from './mountedActions.js';
import { useTriageSourcePanelActionsV1 } from './useSourcePanelActions.js';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const page of mounted.splice(0)) await page.dispose(); });
const FIRST = 'a'.repeat(32);
const SECOND = 'b'.repeat(32);
const ISSUE = '00000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const TEAM = '00000000-0000-4000-8000-0000000000d1';
function inputFor(source: 'sentry' | 'posthog') {
  const posthog = encodePosthogConfiguration({ v: 1, organizationUuid: ORG,
    environments: [{ teamPathId: 42, teamUuid: TEAM, displayName: 'Production' }],
    scanWindowPolicy: { kind: 'exact', from: '2026-07-01T00:00:00.000Z', to: '2026-08-15T00:00:00.000Z' },
    detailWindowPolicy: { kind: 'exact', from: '2026-07-01T00:00:00.000Z', to: '2026-08-15T00:00:00.000Z' } });
  if (!posthog.ok) throw new Error('Invalid configuration fixture');
  const address = { pluginId: `happier.${source}`, localId: source === 'sentry' ? 'sentry-issues' : 'posthog-error-tracking' };
  const parsed = TriageDetailSurfaceInputV1Schema.safeParse({ v: 1,
    instance: { v: 1, instance: { source: address, sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
      binding: { purpose: source === 'sentry' ? 'sentry-account-use' : 'posthog-api', account: { service: { pluginId: address.pluginId, localId: source === 'sentry' ? 'sentry-account' : 'posthog-api' }, accountId: 'account' } },
      localInstanceKey: source === 'sentry' ? 'https://us.sentry.io\u001f42' : `posthog-org:https://eu.posthog.com:${ORG}`,
      configuration: { v: 1, token: source === 'sentry' ? encodeSentryInstanceConfiguration({ v: 1, organizationId: '42', projectScope: { kind: 'allAccessible' }, environmentScope: { kind: 'all' } }) : posthog.token } },
    observation: { entryRef: { source: address, kindId: 'error-issue', collisionScope: source === 'sentry' ? 'https://us.sentry.io\u001f42' : `posthog:https://eu.posthog.com:${TEAM}`, entryId: source === 'sentry' ? '1234' : ISSUE },
      observedAtMs: 1, locator: { v: 1, displayPath: 'Production' }, snapshot: { v: 1, title: 'Error', scopeLabel: 'Production', state: { presentation: 'active', nativeLabel: 'Active' }, facts: [] }, viewer: { involvement: [] } }, linkedSessions: [] });
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.data;
}
const projection = (id: string): JsonValue => ({ kind: 'event', projection: {
  eventId: id, dateCreatedMs: 1, title: id === FIRST ? 'First occurrence' : 'Second occurrence', message: '', location: null, culprit: null, platform: 'javascript',
  sections: [], tags: [], user: { id: 'person', name: 'Person', username: null, email: 'person@example.test', ipAddress: null },
  redactions: [], sensitivePaths: [], projectionTruncated: false, omitted: { sections: 0, frames: 0, breadcrumbs: 0, tags: 0, redactions: 0, sensitivePaths: 0 },
} });

async function mountSource(source: 'sentry' | 'posthog', mode: 'default' | 'ask' | 'waiver' = 'waiver', accept = true, deferComposerRead = false) {
  const scope = createTriageEphemeralSharedScopeFixture();
  const first = source === 'posthog' ? 'aaaaaaaa-0000-4000-8000-000000000001' : FIRST;
  const second = source === 'posthog' ? 'bbbbbbbb-0000-4000-8000-000000000002' : SECOND;
  const input = inputFor(source);
  const transactions: unknown[] = [];
  const dialogs: string[] = [];
  let providerReads = 0;
  let finishComposerRead: (() => void) | undefined;
  let notifyComposerRead!: () => void;
  const composerReadStarted = new Promise<void>((resolve) => { notifyComposerRead = resolve; });
  let commands: readonly TriageSourcePanelCommandV1[] = [];
  let page!: PluginUiTestkit;
  const invoke = async (operation: TriageSourcePanelOperationV1, surface: 'agent' | 'ui' = 'agent', signal = new AbortController().signal) => {
    const localId = triageSourcePanelActionIdV1(operation);
    const action = PLUGIN_MANIFEST.contributes.actions.find((candidate) => candidate.id === localId);
    if (!action) throw new Error('Action declaration missing');
    const id = `happier.triage/${localId}` as const;
    const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [id]: [surface] } });
    const settings = mode === 'default' ? normalizeActionsSettingsV1({ v: 1 }) : mode === 'waiver' || action.confirmation === undefined ? waived
      : normalizeActionsSettingsV1({ ...waived, actions: { [id]: { approvalRequiredSurfaces: [surface] } } });
    const defaultRequired = pluginActionRequiresPresentUserIntent(action, surface);
    if (isApprovalRequiredByActionsSettings(id, settings, { surface }, undefined, defaultRequired)) {
      dialogs.push(localId);
      if (!accept) return { status: 'rejected' as const };
    }
    const context = { plugin: { id: 'happier.triage', version: '0.0.0' }, contribution: { id: localId, qualifiedId: id }, invocationSurface: surface,
      signal, ui: page.context.hostApi, ephemeralSharedScope: scope };
    if (operation.kind === 'insertSelectedEvidence') return await createTriageMountedSourceInsertActionHandler()({ mountId: 'page', operation }, context);
    if (operation.kind === 'revealSourceUser' && operation.revealed) return await createTriageMountedSourceRevealActionHandler()({ mountId: 'page', operation }, context);
    return await createTriageMountedUiActionHandler()({ mountId: 'page', operation }, context);
  };
  function Surface({ context }: Readonly<{ context: RenderContext }>) {
    const hostApi = usePluginHostApi();
    const panel = useTriageSourcePanelActionsV1(scope, 'page', 'issue', true, hostApi);
    commands = panel.commands;
    const insertion = useTriageTierBEvidenceInsertion({ kind: 'session', sessionId: 'draft-session' });
    React.useLayoutEffect(() => bindTriageMountedUiActions(scope, 'page', async () => ({ status: 'unavailable' })), []);
    return <TriageEvidenceDisclosureProvider disclosure={{ ...insertion, panelActions: panel.actions }}>
      {(source === 'sentry' ? renderSentry : renderPosthog)({ ...context, launchInput: input as unknown as JsonValue })}
    </TriageEvidenceDisclosureProvider>;
  }
  await act(async () => {
    page = await createPluginUiTestkit({ identity: { instanceId: `parity-${source}`, mountNonce: 'parity' }, authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: defineUiSurface((context) => <Surface context={context} />),
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {
        executeAction: async ({ action, input: request }) => {
          const localId = typeof action === 'string' ? action : action.localId;
          if (localId.startsWith('ui/')) return await invoke((request as { operation: TriageSourcePanelOperationV1 }).operation, 'ui');
          providerReads += 1;
          if (localId === SENTRY_ACTION_IDS.readIssue) {
            const requested = (request as { projection: string }).projection;
            if (requested === 'tags') return { kind: 'tags', tags: [], omittedTagCount: 0, projectionTruncated: false };
            if (requested === 'activity') return { kind: 'activity', activity: { status: 'available', items: [], malformedItemCount: 0, omittedItemCount: 0, projectionTruncated: false } };
            return { kind: 'overview', statePresentation: 'active', nativeStateLabel: 'Active', eventCount: '2' };
          }
          if (localId === SENTRY_ACTION_IDS.listIssueEvents) return { kind: 'events', rows: [{ eventId: FIRST, headline: 'First occurrence' }, { eventId: SECOND, headline: 'Second occurrence' }], omittedRowCount: 0, projectionTruncated: false };
          if (localId === SENTRY_ACTION_IDS.readEvent) return projection((request as { selector: { eventId?: string } }).selector.eventId ?? FIRST);
          if (localId === POSTHOG_ACTION_IDS.nativeOverview) return { kind: 'unreadable-by-design' };
          if (localId === POSTHOG_ACTION_IDS.issueActivity) return { kind: 'activity', records: [], omittedRowCount: 0 };
          if (localId === POSTHOG_ACTION_IDS.issueEvents) return { kind: 'sampled', events: [first, second].map((uuid, providerOffset) => ({ uuid, providerOffset, exceptions: [{ type: providerOffset === 0 ? 'First occurrence' : 'Second occurrence', frames: [] }] })), omittedRowCount: 0,
            frozenRequest: { v: 1, issueId: ISSUE, from: '2026-07-01T00:00:00.000Z', to: '2026-08-15T00:00:00.000Z', filterTestAccounts: false, onlyAppFrames: false, include: ['exception', 'stacktrace', 'navigation', 'correlation'], limit: 3, offset: 0 } };
          throw new Error(`Unexpected source action ${localId}`);
        },
        readComposer: async ({ ref }) => {
          if (deferComposerRead) {
            notifyComposerRead();
            await new Promise<void>((resolve) => { finishComposerRead = resolve; });
          }
          return { status: 'ready', snapshot: { revision: 9, ref, text: 'Investigate ', selection: { start: 12, end: 12 }, references: [], attachments: [], layout: 'wrap',
            capabilities: { text: true, references: true, attachments: true, submit: true }, state: { focused: false, editable: true, submittable: true, submitting: false, running: false } } };
        },
        applyComposer: ({ transaction }) => { transactions.push(transaction); return { status: 'applied', revision: 10 }; },
      } });
  });
  mounted.push(page);
  await act(async () => { await page.press(await page.getByRole('tab', { name: 'Occurrences' })); });
  return { page, invoke, transactions, dialogs, first, second, composerReadStarted, finishComposerRead: () => finishComposerRead?.(), providerReads: () => providerReads, commands: () => commands };
}

describe('source panel agent/UI parity', () => {
  it.each(['sentry', 'posthog'] as const)('selects the second %s occurrence and inserts the same reference as UI', async (source) => {
    const mounted = await mountSource(source);
    await act(async () => { expect(await mounted.invoke({ kind: 'selectSourceOccurrence', occurrenceId: mounted.second })).toEqual({ status: 'applied' }); });
    if (source === 'posthog') await act(async () => { await mounted.page.press(await mounted.page.getByRole('tab', { name: 'Stack trace' })); });
    const readsBeforeInsert = mounted.providerReads();
    await act(async () => { expect(await mounted.invoke({ kind: 'insertSelectedEvidence', occurrenceId: mounted.second })).toEqual({ status: 'applied' }); });
    expect(mounted.transactions).toHaveLength(1);
    expect(mounted.providerReads()).toBe(readsBeforeInsert);
    expect(mounted.transactions[0]).toMatchObject({ expectedRevision: 9, operations: [
      { kind: 'text.insert', text: `${source === 'sentry' ? 'Sentry' : 'PostHog'} occurrence ${mounted.second}` },
      { kind: 'reference.insert', reference: { label: `${source === 'sentry' ? 'Sentry' : 'PostHog'} occurrence ${mounted.second}` } },
    ] });
    expect(mounted.commands().some((command) => command.operation.kind === 'insertSelectedEvidence')).toBe(true);
    if (source === 'posthog') await act(async () => { await mounted.page.press(await mounted.page.getByRole('tab', { name: 'Occurrences' })); });
    await act(async () => { await mounted.page.press(await mounted.page.getByRole(source === 'sentry' ? 'button' : 'option', { name: 'First occurrence' })); });
    await act(async () => { await mounted.page.press(await mounted.page.getByRole(source === 'sentry' ? 'button' : 'option', { name: 'Second occurrence' })); });
    if (source === 'posthog') await act(async () => { await mounted.page.press(await mounted.page.getByRole('tab', { name: 'Stack trace' })); });
    await act(async () => { await mounted.page.press(await mounted.page.getByRole('button', { name: 'Add selected occurrence to message' })); });
    expect(mounted.transactions).toHaveLength(2);
    expect(mounted.transactions[1]).toEqual(mounted.transactions[0]);
    await act(async () => { expect(await mounted.invoke({ kind: 'insertSelectedEvidence', occurrenceId: mounted.first })).toEqual({ status: 'unavailable' }); });
    await act(async () => { await mounted.page.dispose(); });
    expect(await mounted.invoke({ kind: 'selectSourceOccurrence', occurrenceId: mounted.second })).toEqual({ status: 'unavailable' });
  });
  it.each(['default', 'ask', 'waiver'] as const)('uses the shared %s approval policy before inserting evidence', async (mode) => {
    const mounted = await mountSource('posthog', mode, false);
    await act(async () => { await mounted.page.press(await mounted.page.getByRole('tab', { name: 'Stack trace' })); });
    await act(async () => { await mounted.invoke({ kind: 'insertSelectedEvidence', occurrenceId: mounted.first }); });
    expect(mounted.transactions).toHaveLength(mode === 'waiver' ? 1 : 0);
    expect(mounted.dialogs.length).toBe(mode === 'waiver' ? 0 : 1);
  });
  it.each(['default', 'ask', 'waiver'] as const)('uses shared %s approval for Sentry user reveal but never gates concealment', async (mode) => {
    const mounted = await mountSource('sentry', mode, false);
    await act(async () => { await mounted.invoke({ kind: 'selectSourceOccurrence', occurrenceId: mounted.first }); });
    await act(async () => { await mounted.invoke({ kind: 'revealSourceUser', occurrenceId: mounted.first, revealed: true }); });
    if (mode === 'waiver') expect(await mounted.page.queryByText('person@example.test')).toBeDefined();
    else expect(await mounted.page.queryByText('person@example.test')).toBeUndefined();
    expect(mounted.dialogs).toHaveLength(mode === 'waiver' ? 0 : 1);
    await act(async () => { expect(await mounted.invoke({ kind: 'revealSourceUser', occurrenceId: mounted.first, revealed: false })).toEqual({ status: 'applied' }); });
    expect(await mounted.page.queryByText('person@example.test')).toBeUndefined();
    expect(mounted.dialogs).toHaveLength(mode === 'waiver' ? 0 : 1);
  });
  it('shares Sentry ordering with the visible control and retires inactive panel commands', async () => {
    const mounted = await mountSource('sentry');
    await act(async () => { expect(await mounted.invoke({ kind: 'setSourceOrdering', order: 'spread' })).toEqual({ status: 'applied' }); });
    await act(async () => { await mounted.page.press(await mounted.page.getByRole('button', { name: 'Show Sentry’s own order' })); });
    await expect(mounted.page.getByRole('button', { name: 'Show a spread of events' })).resolves.toBeDefined();
    await act(async () => { await mounted.page.press(await mounted.page.getByRole('tab', { name: 'Overview' })); });
    expect(mounted.commands().some((command) => command.operation.kind === 'selectSourceOccurrence')).toBe(false);
    expect(await mounted.invoke({ kind: 'setSourceOrdering', order: 'spread' })).toEqual({ status: 'unavailable' });
    expect(await mounted.invoke({ kind: 'insertSelectedEvidence', occurrenceId: mounted.first })).toEqual({ status: 'unavailable' });
  });
  it('does not write the draft when the admitted source Action is cancelled during its Composer read', async () => {
    const mounted = await mountSource('sentry', 'waiver', true, true);
    await act(async () => { await mounted.invoke({ kind: 'selectSourceOccurrence', occurrenceId: mounted.second }); });
    const controller = new AbortController();
    const insertion = mounted.invoke({ kind: 'insertSelectedEvidence', occurrenceId: mounted.second }, 'agent', controller.signal);
    await mounted.composerReadStarted;
    controller.abort();
    mounted.finishComposerRead();
    expect(await insertion).toEqual({ status: 'unavailable' });
    expect(mounted.transactions).toHaveLength(0);
  });
});
