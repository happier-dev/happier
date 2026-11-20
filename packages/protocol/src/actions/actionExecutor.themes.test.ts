import { expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorContext } from './actionExecutor.js';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { createActionAutomationHttpPortV1 } from './executor/actionAutomationAdmission.js';
import { getActionSpec } from './actionSpecs.js';
import { createThemeProfileFile } from '../account/settings/themeProfileFile.js';
import { parseThemeProfileDocument } from '../account/settings/themeProfiles.js';
import { THEME_ACTION_IDS, THEME_ACTION_ID_LIST, ThemeActionInputSchemas, ThemeActionOutputSchemas, ThemeSurfacePaintDescriptorSchema } from './themeActionFamily.js';
import { actionInputValidationFailure } from './executor/actionInputValidation.js';
import { isAgentInitiatedApprovalRequiredByDefault, resolveActionApprovalRouting } from './actionApprovalPolicy.js';

it('retains direct, derived and fixed surface paint sources through the strict wire descriptor', () => {
  const descriptor = {
    address: { surface: 'composer', part: 'root' }, selector: '[data-surface="composer"]', label: 'Composer',
    paintRoles: [
      { facet: 'foreground', source: { kind: 'token', ref: 'colors.text.primary' } },
      { facet: 'background', source: { kind: 'derived', from: ['colors.surface.default', 'colors.accent.primary'] } },
      { facet: 'border', source: { kind: 'fixed' } },
    ],
  };
  expect(ThemeSurfacePaintDescriptorSchema.parse(descriptor)).toEqual(descriptor);
});

it('rejects malformed or ambiguous surface paint sources instead of advertising editable tokens', () => {
  const descriptor = { address: { surface: 'composer', part: 'root' }, selector: '[data-surface="composer"]', label: 'Composer' };
  for (const role of [
    { facet: 'background', tokenRef: 'colors.surface.default' },
    { facet: 'background', source: { kind: 'token' } },
    { facet: 'background', source: { kind: 'token', ref: 'colors.surface.default', from: [] } },
    { facet: 'background', source: { kind: 'derived', from: [17] } },
    { facet: 'background', source: { kind: 'derived', from: [] } },
    { facet: 'background', source: { kind: 'fixed', ref: 'colors.surface.default' } },
    { facet: 'background', source: { kind: 'unknown' } },
    { facet: 'background', source: null },
  ]) {
    expect(ThemeSurfacePaintDescriptorSchema.safeParse({ ...descriptor, paintRoles: [role] }).success, JSON.stringify(role)).toBe(false);
  }
});

it('asks Agent and MCP for author CSS while colour-only and trusted user/plugin effects stay Direct', () => {
  const raw = { schemaVersion: 1, id: 'theme_css_approval', name: 'CSS approval',
    createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
    base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} } };
  for (const css of [undefined, '', '[data-surface="card"] { display: none }']) {
    const parsed = parseThemeProfileDocument({ ...raw, ...(css === undefined ? {} : { css }) });
    if (!parsed.ok) throw new Error(parsed.error);
    for (const actionId of [THEME_ACTION_IDS.tryOn, THEME_ACTION_IDS.save]) {
      const input = ThemeActionInputSchemas[actionId].parse({ document: parsed.document,
        ...(actionId === THEME_ACTION_IDS.tryOn ? { mode: 'dark', origin: { kind: 'agent' } } : {}) });
      for (const surface of ['agent', 'mcp', 'ui', 'plugin'] as const) {
        const routing = resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), input,
          context: { surface, authority: 'present_user', actionCaller: { kind: 'host' } } });
        expect(routing.required, `${actionId}:${surface}:${css ?? 'colour-only'}`)
          .toBe(Boolean(css) && (surface === 'agent' || surface === 'mcp'));
      }
    }
  }
  const actionId = THEME_ACTION_IDS.apply;
  expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId),
    input: { ref: { kind: 'artifact', id: 'previously-saved-css' }, mode: 'dark' },
    context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(false);
});

it.each([
  { css: undefined, ask: false },
  { css: '', ask: false },
  { css: '[data-surface="card"] { display: none }', ask: true },
])('decides theme file import approval with CSS $css', ({ css, ask }) => {
  const actionId = THEME_ACTION_IDS.import;
  const spec = getActionSpec(actionId);
  const profile = { schemaVersion: 1, name: 'Imported theme',
    base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} }, css };
  const text = `/* Theme export */\n${JSON.stringify(createThemeProfileFile(profile))}`;
  const input = spec.inputSchema.parse({ file: { name: 'theme.json', text } });
  for (const surface of ['agent', 'mcp', 'ui', 'plugin'] as const) {
    const routing = resolveActionApprovalRouting({ actionId, spec, input,
      context: { surface, authority: 'present_user', actionCaller: surface === 'plugin'
        ? { kind: 'plugin', pluginId: 'trusted.theme-tools' } : { kind: 'host' } } });
    expect(routing.required, surface).toBe(ask && (surface === 'agent' || surface === 'mcp'));
    expect(routing.uiConfirmationRequired ?? false, surface).toBe(ask && surface === 'ui');
  }
});

it('keeps deletion and plugin authoring on the declared static Agent Ask default', () => {
  for (const actionId of THEME_ACTION_ID_LIST) {
    expect(isAgentInitiatedApprovalRequiredByDefault(actionId), actionId)
      .toBe(actionId === THEME_ACTION_IDS.delete || actionId === THEME_ACTION_IDS.uninstall
        || actionId === THEME_ACTION_IDS.sharePlugin);
  }
});

it('asks Agent and MCP for theme deletion, uninstall and sharing while trusted plugins and user presses stay Direct', () => {
  for (const actionId of [THEME_ACTION_IDS.delete, THEME_ACTION_IDS.uninstall, THEME_ACTION_IDS.sharePlugin]) {
    for (const surface of ['agent', 'mcp', 'ui', 'plugin'] as const) {
      expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId),
        context: { surface, authority: 'present_user', actionCaller: surface === 'plugin'
          ? { kind: 'plugin', pluginId: 'trusted.theme-tools' } : { kind: 'host' } } }).required,
      `${actionId}:${surface}`).toBe(surface === 'agent' || surface === 'mcp');
    }
  }
});

it('keeps Store installs Direct for Agent, MCP, user and trusted plugins', () => {
  const actionId = THEME_ACTION_IDS.install;
  for (const surface of ['agent', 'mcp', 'ui', 'plugin'] as const) {
    expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId),
      input: { listing: { sourceId: 'catalog', itemId: 'colour-only-or-css' } },
      context: { surface, authority: 'present_user', actionCaller: { kind: 'host' } } }).required, surface)
      .toBe(false);
  }
});

it('retains unknown theme presentation at strict admission and preserves document-invalid repair codes', () => {
  const parsed = parseThemeProfileDocument({ schemaVersion: 1, id: 'theme_retained', name: 'Retained theme',
    createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
    base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} }, futurePresentation: { texture: 'paper' } });
  if (!parsed.ok) throw new Error(parsed.error);
  const input = { document: parsed.document, mode: 'dark', origin: { kind: 'agent' } };
  const schema = ThemeActionInputSchemas[THEME_ACTION_IDS.tryOn];
  expect(schema.parse(input).document).toMatchObject({ raw: { futurePresentation: { texture: 'paper' } },
    compatibility: { status: 'partial' } });
  const invalid = schema.safeParse({ ...input,
    document: { ...parsed.document, raw: { ...parsed.document.raw, name: 7 } },
  });
  expect(invalid.success).toBe(false);
  if (invalid.success) throw new Error('Invalid known theme field was admitted');
  expect(actionInputValidationFailure(invalid.error)).toMatchObject({ ok: false, errorCode: 'theme_document_invalid' });
});

it('admits base-theme selection and an offline local receipt without fabricating a client identity', () => {
  expect(ThemeActionInputSchemas[THEME_ACTION_IDS.apply].safeParse({ ref: null, mode: 'light' }).success).toBe(true);
  expect(ThemeActionInputSchemas[THEME_ACTION_IDS.apply].parse({ ref: null, mode: 'dark', clientId: 'other-app' }))
    .toEqual({ ref: null, mode: 'dark', clientId: 'other-app' });
  const output = ThemeActionOutputSchemas[THEME_ACTION_IDS.apply];
  expect(output.safeParse({ applied: { mode: 'light' }, undoHandle: 'local-operation' }).success).toBe(true);
  expect(output.safeParse({ applied: { mode: 'dark', clientId: 'connected-app' }, undoHandle: 'connected-operation' }).success).toBe(true);
  expect(output.safeParse({ applied: { mode: 'dark', clientId: '' }, undoHandle: 'connected-operation' }).success).toBe(false);
});

it('admits retained theme presentation through the real Action boundary and reports malformed documents by domain code', async () => {
  const parsed = parseThemeProfileDocument({ schemaVersion: 1, id: 'theme_action', name: 'Action theme',
    createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
    base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} }, futurePresentation: { texture: 'paper' } });
  if (!parsed.ok) throw new Error(parsed.error);
  const id = THEME_ACTION_IDS.tryOn;
  const input = { document: parsed.document, mode: 'dark', origin: { kind: 'agent' } };
  const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
  const unavailable = await createActionExecutor({}).execute(id, input, context);
  expect(unavailable).toMatchObject({ ok: false, errorCode: 'client_not_connected' });
  expect(getActionSpec(id).inputSchema.parse(input)).toMatchObject({ document: {
    raw: { futurePresentation: { texture: 'paper' } }, compatibility: { status: 'partial' },
  } });
  const invalid = await createActionExecutor({}).execute(id, { ...input,
    document: { ...parsed.document, raw: { ...parsed.document.raw, name: 7 } },
  }, context);
  expect(invalid).toMatchObject({ ok: false, errorCode: 'theme_document_invalid' });
});


it('admits selected Store acquisition and face retry inputs while uninstall keeps the destructive approval default', async () => {
  const listing = { sourceId: 'catalog', itemId: 'paper' };
  for (const [suffix, input] of [
    ['store.get', { listing }], ['install', { listing, faceIds: ['dark'] }], ['uninstall', { listing }],
  ] as const) {
    const id = THEME_ACTION_ID_LIST.find(candidate => candidate === `appearance.themes.${suffix}`);
    expect(id, suffix).toBeDefined();
    if (!id) throw new Error(`Store Action missing: ${suffix}`);
    const spec = getActionSpec(id);
    expect(spec.inputSchema.safeParse(input).success, suffix).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, url: 'https://unselected.example.test/theme' }).success, suffix).toBe(false);
    expect(isAgentInitiatedApprovalRequiredByDefault(id), suffix).toBe(suffix === 'uninstall');
    const unavailable = await createActionExecutor({}).execute(id, input,
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
    expect(unavailable).toMatchObject({ ok: false, errorCode: 'client_not_connected' });
  }
});

it('retains the selected Store package version through Action admission while mutations keep latest-item keys', () => {
  const listing = { sourceId: 'open-vsx', itemId: 'publisher.paper', version: '1.2.3' };
  const read = getActionSpec(THEME_ACTION_IDS.storeGet).inputSchema;
  expect(read.parse({ listing })).toEqual({ listing });
  expect(read.parse({ listing: { sourceId: listing.sourceId, itemId: listing.itemId } }))
    .toEqual({ listing: { sourceId: listing.sourceId, itemId: listing.itemId } });
  expect(read.safeParse({ listing: { ...listing, version: '' } }).success).toBe(false);
  expect(read.safeParse({ listing: { ...listing, url: 'https://unselected.example.test/theme' } }).success).toBe(false);
  for (const actionId of [THEME_ACTION_IDS.install, THEME_ACTION_IDS.uninstall]) {
    expect(getActionSpec(actionId).inputSchema.safeParse({ listing }).success, actionId).toBe(false);
  }
});

it('publishes selected Store CSS coverage by face without changing preview documents', () => {
  const listing = { sourceId: 'catalog', itemId: 'paper' };
  const coverage = { total: 0, native: 0, webOnly: 0, affectedSurfaces: [], hides: [] };
  const output = { listing: { pointer: { ...listing, version: '1.0.0' }, summary: { ...listing, kind: 'theme', title: 'Paper' },
    metadata: { includes: [{ key: 'dark', label: 'Dark', mode: 'dark' }] },
    provenance: { ...listing, format: 'happier-catalog', sourceUrl: 'https://themes.example.test/catalog',
      ref: { kind: 'version', version: '1.0.0' }, importedAt: 0 } },
    faces: [], coverage: [{ faceId: 'dark', coverage }] };
  expect(ThemeActionOutputSchemas[THEME_ACTION_IDS.storeGet].parse(output))
    .toMatchObject({ coverage: [{ faceId: 'dark', coverage }] });
});

it.each(['acknowledged', 'acknowledgement lost after commit', 'write refused before commit'] as const)(
  'executes only committed Agent CSS approvals and returns one result to the originating Session (%s)', async acknowledgement => {
  const actionId = THEME_ACTION_IDS.tryOn;
  const sessionId = 'session-theme';
  const home = { serverIdentityId: 'home', runtimeAccountId: 'account' };
  const app = { ...home, serverId: 'app-profile', surface: 'ui', authority: 'present_user',
    actionCaller: { kind: 'host' } } satisfies ActionExecutorContext;
  const agent = { ...home, serverId: 'daemon-profile', surface: 'agent', authority: 'account_automation',
    actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
    actionRequestId: 'try-on', defaultSessionId: sessionId, defaultSessionMachineId: 'machine',
    sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: 'turn', via: 'action' },
    callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
  } satisfies ActionExecutorContext;
  const profile = { schemaVersion: 1, id: 'theme_approval', name: 'Try on',
    createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
    base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: { 'background.canvas': '#232125' } } };
  const input = (css?: string) => {
    const parsed = parseThemeProfileDocument({ ...profile, ...(css ? { css } : {}) });
    if (!parsed.ok) throw new Error(parsed.error);
    return { document: parsed.document, mode: 'dark', origin: { kind: 'agent' }, group: 'workspace' };
  };
  const css = '[data-surface="composer"] { border-radius: 23px }';
  const receipt = (previewRef: string, total: number) => ({
    previewRef, coverage: { total, native: total, webOnly: 0, affectedSurfaces: [], hides: [] },
    compatibility: { status: 'supported', unsupportedPaths: [] },
  });
  let stored: ApprovalRequestV2 | undefined;
  const painted: (string | undefined)[] = [];
  const published = new Map<string, { sessionId: string; result: unknown }>();
  // The Artifact, client and Session transports are the three process boundaries.
  const executor = createActionExecutor({
    actionAutomations: createActionAutomationHttpPortV1({ accountId: 'account',
      request: async () => ({ v: 1, rows: [] }) }),
    approvalsCreate: async ({ request }) => {
      stored = ApprovalRequestV2Schema.parse(request);
      return { artifactId: 'css-approval' };
    },
    approvalsGet: async () => stored ?? null,
    approvalsUpdate: async ({ request, expectedStatus }) => {
      if (!stored) throw new Error('Missing approval row');
      if (acknowledgement === 'write refused before commit' && request.status === 'approved') {
        return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch', writeCommitted: false };
      }
      const transition = decideApprovalRequestTransition(stored, request, { expectedStatus });
      if (!transition.ok) return transition;
      stored = ApprovalRequestV2Schema.parse(request);
      if (acknowledgement === 'acknowledgement lost after commit' && stored.status === 'approved') {
        throw Object.assign(new Error('Home response lost after commit'), { code: 'P2024' });
      }
      return { ok: true };
    },
    isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverIdentityId === home.serverIdentityId
      && origin.accountId === home.runtimeAccountId,
    themeAction: async ({ input: effect }) => {
      if (!('document' in effect)) throw new Error('Unexpected theme effect');
      const authorCss = effect.document?.profile.css;
      painted.push(authorCss);
      return authorCss ? receipt('css-preview', 1) : receipt('color-preview', 0);
    },
    sessionSendMessage: async ({ sessionId: destination, message, localId }) => {
      if (!localId) throw new Error('Missing publication identity');
      const status = published.has(localId) ? 'alreadyAccepted' : 'accepted';
      published.set(localId, { sessionId: destination, result: JSON.parse(message) });
      return { status, localId };
    },
  });
  expect(await executor.execute(actionId, input(), { ...agent, actionRequestId: 'try-on-color' }))
    .toMatchObject({ ok: true, result: receipt('color-preview', 0) });
  expect(stored).toBeUndefined();
  expect(await executor.execute(actionId, input(css), agent))
    .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'css-approval', actionId } });
  expect(stored).toMatchObject({ status: 'open', automaticChecks: { phase: 'consent', selected: [] } });
  expect(painted).toEqual([undefined]);
  const approve = () => executor.execute('approval.request.decide', { artifactId: 'css-approval', decision: 'approve' }, app);
  const approved = await approve();
  if (acknowledgement === 'write refused before commit') {
    expect(approved).toMatchObject({ ok: false, errorCode: 'version_mismatch' });
    expect(stored).toMatchObject({ status: 'open' });
    expect(painted).toEqual([undefined]);
    expect(published.size).toBe(0);
    return;
  }
  expect(approved).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
  expect(stored).toMatchObject({ status: 'executed', execution: { ok: true, result: receipt('css-preview', 1) } });
  expect(published.get('approval-result:css-approval')).toMatchObject({
    sessionId, result: { actionId, execution: { ok: true, result: receipt('css-preview', 1) } },
  });
  await expect(approve()).resolves.toEqual(approved);
  expect(painted).toEqual([undefined, css]);
  expect(published.size).toBe(1);
});
