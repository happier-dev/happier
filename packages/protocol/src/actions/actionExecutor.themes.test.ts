import { expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
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

it('keeps deletion and plugin authoring on the declared static Agent Ask default', () => {
  for (const actionId of THEME_ACTION_ID_LIST) {
    expect(isAgentInitiatedApprovalRequiredByDefault(actionId), actionId)
      .toBe(actionId === THEME_ACTION_IDS.delete || actionId === THEME_ACTION_IDS.uninstall
        || actionId === THEME_ACTION_IDS.sharePlugin);
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
