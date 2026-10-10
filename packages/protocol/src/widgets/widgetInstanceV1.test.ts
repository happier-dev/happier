import { describe, expect, it } from 'vitest';
import { projectWidgetBindingInputV1, resolveWidgetBindingsV1, WidgetInstanceV1Schema, type WidgetInstanceV1 } from './widgetInstanceV1.js';
import { InputHintsSchema } from '../inputs/inputFields.js';
import { countWidgetInstancesV1, isSameWidgetDefinitionV1 } from './builtinWidgetDescriptorV1.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { WidgetSurfaceRefV1Schema } from './widgetInstanceV1.js';

const instance = (bindings: WidgetInstanceV1['bindings']): WidgetInstanceV1 => ({
  v: 1, id: 'copy-1', definition: { kind: 'installed', surface: { pluginId: 'happier.widget.checks', localId: 'summary' } }, bindings,
});
const fields = InputHintsSchema.parse({ fields: [
  { path: 'target.session', title: 'Session', widget: 'json', required: true },
  { path: 'connection', title: 'Connection', widget: 'json', required: true },
] }).fields;
const valid = () => ({ status: 'valid' as const });

describe('configured widget bindings', () => {
  it('refuses explicit context bindings for own-value fields in admission and draft projection', () => {
    const ownFields = [{ ...fields[0]!, contextMode: 'own' as const }];
    const options = { instance: instance({ 'target.session': { kind: 'context' as const, slot: 'session' } }),
      fields: ownFields, context: { session: [{ serverId: 'home', sessionId: 'B' }] }, viewerValues: {} };
    expect(projectWidgetBindingInputV1(options)).toEqual({});
    expect(resolveWidgetBindingsV1({ ...options, validateValue: valid })).toEqual({ status: 'invalid', fields: [
      { path: 'target.session', status: 'invalid', reasonCode: 'widget_context_binding_forbidden' },
    ] });
    expect(resolveWidgetBindingsV1({ ...options,
      instance: instance({ 'target.session': { kind: 'value', value: { serverId: 'home', sessionId: 'A' } } }), validateValue: valid,
    })).toEqual({ status: 'ready', input: { target: { session: { serverId: 'home', sessionId: 'A' } } } });
  });
  it('reads stored extras canonically while inputs and required identities remain strict', () => {
    const stored = createStoredReadSchema(WidgetInstanceV1Schema);
    const canonical = instance({ target: { kind: 'context', slot: 'session' }, viewer: { kind: 'viewer', purpose: 'checks' },
      literal: { kind: 'value', value: { arbitrary: true } } });
    const raw = { ...canonical, savedBy: 'stray', definition: { ...canonical.definition, extra: true,
      surface: { pluginId: 'happier.widget.checks', localId: 'summary', extra: true } },
      bindings: Object.fromEntries(Object.entries(canonical.bindings).map(([key, value]) => [key, { ...value, extra: true }])) };
    expect(stored.parse(raw)).toEqual(canonical);
    expect(projectWidgetBindingInputV1({ instance: raw, fields: [
      { path: 'literal', title: 'Literal', widget: 'json' },
    ], context: {}, viewerValues: {} })).toEqual({ literal: { arbitrary: true } });
    expect(WidgetInstanceV1Schema.safeParse(raw).success).toBe(false);
    expect(stored.safeParse({ ...raw, id: undefined }).success).toBe(false);
    const surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'home' } };
    const extraSurface = { ...surface, extra: true, owner: { ...surface.owner, extra: true } };
    expect(createStoredReadSchema(WidgetSurfaceRefV1Schema).parse(extraSurface)).toEqual(surface);
    expect(WidgetSurfaceRefV1Schema.safeParse(extraSurface).success).toBe(false);
    expect(createStoredReadSchema(WidgetSurfaceRefV1Schema).safeParse({ ...extraSurface, accountId: undefined }).success).toBe(false);
  });
  it('projects readable declared draft values while unresolved fields remain unadmitted', () => {
    const copy = instance({ 'target.session': { kind: 'context', slot: 'session' }, connection: { kind: 'viewer', purpose: 'checks' },
      filter: { kind: 'value', value: 'open' }, ambiguous: { kind: 'context', slot: 'machines' },
      token: { kind: 'value', value: 'private' }, unknown: { kind: 'value', value: 'undeclared' } });
    const draftFields = InputHintsSchema.parse({ fields: [...fields, { path: 'filter', title: 'Filter', widget: 'text' },
      { path: 'ambiguous', title: 'Machine', widget: 'json' }, { path: 'token', title: 'Token', widget: 'secret' }] }).fields;
    const options = { instance: copy, fields: draftFields, context: { session: [{ serverId: 'home', sessionId: 'B' }], machines: ['one', 'two'] }, viewerValues: {} };
    expect(projectWidgetBindingInputV1(options)).toEqual({ target: { session: { serverId: 'home', sessionId: 'B' } }, filter: 'open' });
    expect(resolveWidgetBindingsV1({ ...options, validateValue: valid })).toMatchObject({ status: 'invalid' });
    expect(projectWidgetBindingInputV1({ ...options, viewerValues: { connection: 'viewer-own' } })).toMatchObject({ connection: 'viewer-own' });
  });
  it('counts an explicit shared copy by its saved identity without weakening exact inline equality', () => {
    const copy = WidgetInstanceV1Schema.parse({ v: 1, id: 'copy', bindings: {}, definition: { kind: 'inline', definition: {
      v: 1, id: 'saved', name: 'Checks', sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
      provenance: { source: { kind: 'authored' } }, body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Checks' } } },
    } } });
    if (copy.definition.kind !== 'inline') throw new Error('fixture_not_inline');
    const sameTitleOtherIdentity = { ...copy, id: 'other', definition: { kind: 'inline' as const, definition: { ...copy.definition.definition, id: 'different' } } };
    const editedCopy = { kind: 'inline' as const, definition: { ...copy.definition.definition, name: 'Edited shared copy' } };
    expect(countWidgetInstancesV1([copy, sameTitleOtherIdentity], { kind: 'artifact', artifactId: 'saved' })).toBe(1);
    expect(isSameWidgetDefinitionV1(copy.definition, editedCopy)).toBe(false);
  });

  it('resolves each copy independently with nested neutral input paths and viewer-owned choices', () => {
    const followed = instance({ 'target.session': { kind: 'context', slot: 'session' }, connection: { kind: 'viewer', purpose: 'checks' } });
    const pinned = { ...instance({ 'target.session': { kind: 'value', value: { serverId: 'home', sessionId: 'B' } }, connection: { kind: 'viewer', purpose: 'checks' } }), id: 'copy-2' };
    const resolve = (copy: WidgetInstanceV1, sessionId: string, accountId: string) => resolveWidgetBindingsV1({
      instance: copy, fields, context: { session: [{ serverId: 'home', sessionId }] },
      viewerValues: { connection: { service: { pluginId: 'checks', localId: 'service' }, accountId } }, validateValue: valid,
    });
    expect(resolve(followed, 'A', 'viewer-1')).toEqual({ status: 'ready', input: { target: { session: { serverId: 'home', sessionId: 'A' } }, connection: { service: { pluginId: 'checks', localId: 'service' }, accountId: 'viewer-1' } } });
    expect(resolve(pinned, 'C', 'viewer-2')).toMatchObject({ status: 'ready', input: { target: { session: { sessionId: 'B' } }, connection: { accountId: 'viewer-2' } } });
    expect(resolve(followed, 'C', 'viewer-1')).toMatchObject({ input: { target: { session: { sessionId: 'C' } } } });
    expect(pinned.bindings['target.session']).toEqual({ kind: 'value', value: { serverId: 'home', sessionId: 'B' } });
  });

  it('requests selection for missing/ambiguous followed inputs and refuses a revoked pin without fallback', () => {
    const copy = instance({ 'target.session': { kind: 'value', value: { serverId: 'home', sessionId: 'B' } }, connection: { kind: 'context', slot: 'connections' } });
    const result = resolveWidgetBindingsV1({ instance: copy, fields, context: { connections: ['one', 'two'], session: [{ serverId: 'home', sessionId: 'A' }] }, viewerValues: {},
      validateValue: (field) => field.path === 'target.session' ? { status: 'denied', reasonCode: 'session_access_denied' } : { status: 'valid' },
    });
    expect(result).toEqual({ status: 'denied', fields: [
      { path: 'target.session', status: 'denied', reasonCode: 'session_access_denied' },
      { path: 'connection', status: 'selection_required', reasonCode: 'widget_context_ambiguous' },
    ] });
    expect(resolveWidgetBindingsV1({ instance: instance({}), fields, context: {}, viewerValues: {}, validateValue: valid })).toMatchObject({ status: 'selection_required' });
  });

  it('rejects undeclared bindings and credential literals', () => {
    const conditional = InputHintsSchema.parse({ fields: [
      { path: 'enabled', title: 'Enabled', widget: 'boolean' },
      { path: 'token', title: 'Token', widget: 'secret', required: true },
    ] }).fields;
    expect(resolveWidgetBindingsV1({ instance: instance({ enabled: { kind: 'value', value: true }, token: { kind: 'value', value: 'private' }, unknown: { kind: 'value', value: 'x' } }), fields: conditional, context: {}, viewerValues: {}, validateValue: valid })).toMatchObject({ status: 'invalid', fields: expect.arrayContaining([
      { path: 'token', status: 'invalid', reasonCode: 'widget_secret_binding_forbidden' },
      { path: 'unknown', status: 'invalid', reasonCode: 'widget_input_undeclared' },
    ]) });
    expect(WidgetInstanceV1Schema.safeParse({ ...instance({}), machineId: 'forged' }).success).toBe(false);
    expect(WidgetInstanceV1Schema.safeParse(instance({ token: { kind: 'viewer', purpose: 'checks', accountId: 'editor' } } as unknown as WidgetInstanceV1['bindings'])).success).toBe(false);
    expect(WidgetInstanceV1Schema.safeParse(instance({ connection: { kind: 'viewer', purpose: 'x'.repeat(129) } })).success).toBe(false);
  });

  it('uses conditional required rules and never admits secrets concealed by a visibility predicate', () => {
    const conditional = InputHintsSchema.parse({ fields: [
      { path: 'enabled', title: 'Enabled', widget: 'boolean' },
      { path: 'repo', title: 'Repository', widget: 'text', requiredWhen: { op: 'truthy', path: 'enabled' } },
      { path: 'token', title: 'Token', widget: 'secret', visibleWhen: { op: 'truthy', path: 'enabled' } },
    ] }).fields;
    expect(resolveWidgetBindingsV1({ instance: instance({ enabled: { kind: 'value', value: true } }), fields: conditional, context: {}, viewerValues: {}, validateValue: valid })).toMatchObject({ status: 'selection_required', fields: [{ path: 'repo', reasonCode: 'widget_input_missing' }] });
    expect(resolveWidgetBindingsV1({ instance: instance({ enabled: { kind: 'value', value: false } }), fields: conditional, context: {}, viewerValues: {}, validateValue: valid })).toMatchObject({ status: 'ready' });
    expect(resolveWidgetBindingsV1({ instance: instance({ enabled: { kind: 'value', value: false }, token: { kind: 'value', value: 'secret' } }), fields: conditional, context: {}, viewerValues: {}, validateValue: valid })).toMatchObject({ status: 'invalid' });
  });

  it('revalidates hidden bound values before exposing them in launch input', () => {
    const conditional = InputHintsSchema.parse({ fields: [
      { path: 'enabled', title: 'Enabled', widget: 'boolean' },
      { path: 'connection', title: 'Connection', widget: 'json', visibleWhen: { op: 'truthy', path: 'enabled' } },
    ] }).fields;
    const copy = instance({ enabled: { kind: 'value', value: false }, connection: { kind: 'viewer', purpose: 'checks' } });
    expect(resolveWidgetBindingsV1({ instance: copy, fields: conditional, context: {},
      viewerValues: { connection: { service: { pluginId: 'checks', localId: 'service' }, accountId: 'revoked' } },
      validateValue: field => field.path === 'connection' ? { status: 'denied', reasonCode: 'connection_access_denied' } : { status: 'valid' },
    })).toMatchObject({ status: 'denied', fields: [{ path: 'connection', reasonCode: 'connection_access_denied' }] });
  });
});
