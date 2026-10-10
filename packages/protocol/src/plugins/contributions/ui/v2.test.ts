import { artifactHtmlBundleFromBodyV1 } from '../../../artifacts/artifactHtmlV1.js';
import type { core } from 'zod';
import { ActionJsonSchemaProjectionError, zodSchemaToJsonSchemaObject } from '../../../actions/actionInputJsonSchema.js';
import { createPluginManifestJsonSchemaV2 } from '../../manifest/jsonSchema.js';
import { PluginManifestV2Schema } from '../../manifest/v2.js';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  PluginDeclarativeNodeV2Schema,
  PluginDeclarativeTargetedSurfaceNodeV2Schema,
  PluginDeclarativeStateV2Schema,
  PluginUiContributionsV2Schema,
  PluginUiRendererV2Schema,
  PluginUiViewV2Schema,
} from './v2.js';
import { PluginUiIconTokenV1Schema } from './tokens.js';
import {
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_DEPTH_V1,
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1,
  PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
} from './declarativeDocument.js';
import { QualifiedConnectedAccountRefSchema } from '../../../connect/qualifiedConnectedAccountPersistence.js';

/**
 * The declarative vocabulary is a bounded host-rendered document language
 * (plan §3.11). These cases lock the approved list/section/item, state,
 * metadata and action-panel members and the strictness that keeps the language
 * from drifting into a general data-binding surface.
 */
describe('declarative node vocabulary v2', () => {
  it('admits useful widget sizes only on widget declarations through parser and author schema', () => {
    const widget = { id: 'sized', container: 'widget', renderer: 'native', target: { kind: 'app' },
      sizeDeclaration: { sizes: ['medium', 'tall'], defaultSize: 'tall' } };
    expect(PluginUiViewV2Schema.safeParse(widget).success).toBe(true);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, sizeDeclaration: undefined }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, container: 'appPage' }).success).toBe(false);
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(PluginUiViewV2Schema.toJSONSchema({ io: 'input', target: 'draft-2020-12', unrepresentable: 'any' }));
    expect(validate(widget)).toBe(true);
    expect(validate({ ...widget, sizeDeclaration: undefined })).toBe(false);
  });
  it('declares qualified Resource dependencies only on widget Views', () => {
    const resources = [{ pluginId: 'com.acme.fixture', localId: 'live-status' }];
    const widget = { sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' }, id: 'status', container: 'widget', renderer: 'native', target: { kind: 'app' }, resources };
    expect(PluginUiViewV2Schema.parse(widget)).toMatchObject({ resources });
    expect(PluginUiViewV2Schema.safeParse({ ...widget, resources: ['live-status'] }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, container: 'appPage' }).success).toBe(false);
  });

  it('emits App widget input value-admission requirements in its public authoring schema', () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validate = ajv.compile(PluginUiViewV2Schema.toJSONSchema({ io: 'input', target: 'draft-2020-12', unrepresentable: 'any' }));
    const widget = { sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' }, id: 'app-inputs', container: 'widget', renderer: 'native', target: { kind: 'app' } };
    const inputs = { fields: [{ path: 'name', title: 'Name', widget: 'text' }] };
    expect(validate(widget)).toBe(true);
    expect(validate({ ...widget, inputs })).toBe(false);
    expect(validate({ ...widget, inputs, inputSchema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false } })).toBe(true);
  });
  it('admits widget viewer purposes only for exact declared Connected Account inputs', () => {
    const inputs = { fields: [{ path: 'account', title: 'Account', widget: 'select', connectedAccountOptions: true }] };
    const inputSchema = { type: 'object', properties: { account: QualifiedConnectedAccountRefSchema.jsonSchema }, additionalProperties: false };
    const widget = { sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' }, id: 'viewer', container: 'widget', renderer: 'native', target: { kind: 'app' }, inputs, inputSchema,
      resources: [{ pluginId: 'com.acme.fixture', localId: 'metrics' }],
      connectedAccountPurposeBindings: [{ path: 'account', purpose: 'metrics', consumer: { pluginId: 'com.acme.fixture', localId: 'metrics' } }] };
    expect(PluginUiViewV2Schema.safeParse(widget).success).toBe(true);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, inputSchema: { type: 'object', properties: { account: { type: 'string' } } } }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, connectedAccountPurposeBindings: [{ ...widget.connectedAccountPurposeBindings[0], path: 'unknown' }] }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, connectedAccountPurposeBindings: [{ path: 'account', purpose: 'metrics' }] }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, resources: [] }).success).toBe(false);
  });
  it('admits universal widget inputs and refuses removed physical placement declarations', () => {
    const widget = { sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' }, id: 'glance', container: 'widget', renderer: 'native', target: { kind: 'session' } };
    const inputs = { fields: [{ path: 'session', title: 'Session', widget: 'json', required: true }] };
    expect(PluginUiViewV2Schema.safeParse({ ...widget, inputs }).success).toBe(false);
    const inputSchema = { type: 'object', properties: { session: { type: 'object' } }, required: ['session'], additionalProperties: false };
    expect(PluginUiViewV2Schema.parse({ ...widget, inputs, inputSchema, sessionInputPath: 'session' })).toMatchObject({ inputs, inputSchema });
    expect(PluginUiViewV2Schema.parse({ ...widget, target: { kind: 'app' }, inputs, inputSchema })).toMatchObject({ inputs });
    expect(PluginUiViewV2Schema.safeParse({ ...widget, inputs, inputSchema, sessionInputPath: 'undeclared' }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, placements: ['board', 'companion'] }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, placements: ['home'] }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, placements: ['companion'], authority: 'forged' }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, container: 'detailsTab', placements: ['companion'] }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, target: { kind: 'app' }, placements: ['home'] }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, container: 'detailsTab', inputs }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, inputs: { ...inputs, authority: 'forged' } }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, target: { kind: 'app' }, placements: ['board'] }).success).toBe(false);
    expect(PluginUiViewV2Schema.parse({ ...widget, inputs, inputSchema, sessionInputPath: 'session' })).not.toHaveProperty('placements');
  });

  it('admits canonical HTML bundles without granting authority fields', () => {
    const renderer = { id: 'inline', kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<p>Hello</p>') };
    expect(PluginUiRendererV2Schema.safeParse(renderer).success).toBe(true);
    expect(PluginUiRendererV2Schema.safeParse({ ...renderer, source: { ...renderer.source, url: 'https://example.com' } }).success).toBe(false);
    expect(PluginUiRendererV2Schema.safeParse({ ...renderer, sessionId: 'forged' }).success).toBe(false);
  });
  it('admits a declared hosted-HTML capability request without a second host-method declaration', () => {
    const renderer = {
      id: 'inline',
      kind: 'hostedHtml',
      source: artifactHtmlBundleFromBodyV1('<p>Hello</p>'),
      requiredHostMethods: ['context', 'watchContext'],
      requestedCapabilities: {
        resources: [{ pluginId: 'com.acme.health', localId: 'status' }],
        actions: [{ pluginId: 'com.acme.health', localId: 'restart' }],
        networkOrigins: ['https://api.example.com'],
      },
    };
    expect(PluginUiRendererV2Schema.safeParse(renderer).success).toBe(true);
    // `requiredHostMethods` stays the one declared host-method vocabulary for
    // every renderer kind; a capability request must not become a second one.
    expect(PluginUiRendererV2Schema.safeParse({
      ...renderer,
      requestedCapabilities: { ...renderer.requestedCapabilities, hostMethods: ['context'] },
    }).success).toBe(false);
    expect(PluginUiRendererV2Schema.safeParse({
      ...renderer,
      requestedCapabilities: { networkOrigins: ['http://api.example.com'] },
    }).success).toBe(false);
    // The capability grammar belongs to hosted HTML's self-contained document,
    // not to Artifact-backed or host-rendered renderer arms.
    expect(PluginUiRendererV2Schema.safeParse({
      id: 'web',
      kind: 'hostedWeb',
      source: { kind: 'artifact', artifact: 'web' },
      requestedCapabilities: { networkOrigins: ['https://api.example.com'] },
    }).success).toBe(false);
  });
  it('admits only a symbolic targeted Surface reference without a fabricated runtime handle', () => {
    const targetedSurface = {
      kind: 'targetedSurface',
      surface: {
        point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
        contributor: { pluginId: 'com.acme.review', contributionId: 'detail' },
        role: 'detail',
      },
      input: { reviewId: 'review-42' },
      instanceKey: 'review-42',
    };

    expect(PluginDeclarativeTargetedSurfaceNodeV2Schema.safeParse(targetedSurface).success).toBe(true);
    expect(PluginDeclarativeNodeV2Schema.safeParse(targetedSurface).success).toBe(true);
    expect(PluginDeclarativeTargetedSurfaceNodeV2Schema.safeParse({
      ...targetedSurface,
      surface: {
        ...targetedSurface.surface,
        point: { id: 'details', protocol: { id: 'review-detail', version: 1 } },
      },
    }).success).toBe(false);
    expect(PluginDeclarativeTargetedSurfaceNodeV2Schema.safeParse({
      ...targetedSurface,
      surface: {
        ...targetedSurface.surface,
        contributor: {
          ...targetedSurface.surface.contributor,
          immutableGenerationId: 'forged-occurrenceId',
        },
      },
    }).success).toBe(false);
    expect(PluginDeclarativeTargetedSurfaceNodeV2Schema.safeParse({
      ...targetedSurface,
      renderer: 'forged-renderer',
    }).success).toBe(false);
  });

  it('accepts the approved list/section/item vocabulary', () => {
    const parsed = PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'list',
      label: 'Repositories',
      children: [
        {
          kind: 'section',
          title: 'Active',
          footer: 'Updated hourly',
          children: [
            {
              kind: 'item',
              title: 'happier',
              subtitle: { key: 'item.subtitle', fallback: 'Main repository' },
              detail: '42',
              icon: 'file',
              tone: 'success',
              action: 'open-repository',
              input: { id: 'happier' },
            },
            { kind: 'item', title: 'inert row' },
          ],
        },
        { kind: 'state', state: 'empty', title: 'No archived repositories', icon: 'info' },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts state, metadata and action-panel members', () => {
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'state',
      state: 'loading',
      title: 'Loading repositories',
      description: 'This can take a moment.',
    }).success).toBe(true);

    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'metadata',
      title: 'Details',
      entries: [
        { label: 'Branch', value: 'dev' },
        { label: 'Status', value: 'Degraded', tone: 'warning' },
      ],
    }).success).toBe(true);

    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'actionPanel',
      title: 'Repository actions',
      children: [
        { kind: 'action', action: 'sync', label: 'Sync' },
        { kind: 'action', action: 'delete', label: 'Delete', variant: 'destructive' },
      ],
    }).success).toBe(true);
  });

  it('admits only Actions exposed by the canonical Plugin surface', () => {
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'action', hostAction: 'session.spawn_new', label: 'New session',
    }).success).toBe(true);
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'action', hostAction: 'session.permission_mode.set', label: 'Change mode',
    }).success).toBe(false);
  });

  it('rejects unknown members, unbounded metadata and non-curated icons', () => {
    // The SDK's public type projection must not admit values the canonical
    // parser rejects, including an invented node kind or a legacy tone.
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'unbounded',
    }).success).toBe(false);
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'text', text: 'Not canonical', tone: 'neutral',
    }).success).toBe(false);

    // Unknown fields stay rejected: this is a bounded document language.
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'item', title: 'Row', href: 'https://example.com',
    }).success).toBe(false);

    // No arbitrary asset path — only the curated icon-token vocabulary.
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'item', title: 'Row', icon: './assets/logo.png',
    }).success).toBe(false);
    expect(PluginUiIconTokenV1Schema.safeParse('file').success).toBe(true);
    expect([...PluginUiIconTokenV1Schema.options]).toEqual([
      'action',
      'browser',
      'copy',
      'file',
      'globe',
      'info',
      'preview',
      'refresh',
      'settings',
      'terminal',
      'warning',
      'add',
      'back',
      'check',
      'close',
      'error',
      'external',
      'forward',
      'more',
      'search',
      'change-open',
      'change-complete',
      'issue',
      'bug',
      'pin',
      'conversations',
      'waveform',
      'desktop',
      'pause',
      'failure',
      'unavailable',
      'denied',
      'review',
      'attention',
      'escalating',
      'merge-ready',
      'mention',
      'assigned',
      'new',
      'waiting',
      'list',
      'board',
    ]);

    // Metadata is bounded, and an empty metadata block is a modeling mistake.
    expect(PluginDeclarativeNodeV2Schema.safeParse({ kind: 'metadata', entries: [] }).success).toBe(false);
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'metadata',
      entries: Array.from({ length: 33 }, (_unused, index) => ({ label: `k${index}`, value: `v${index}` })),
    }).success).toBe(false);

    // The state vocabulary is closed.
    expect(PluginDeclarativeStateV2Schema.safeParse('degraded').success).toBe(false);
    expect([...PluginDeclarativeStateV2Schema.options].sort()).toEqual(['empty', 'error', 'loading']);
  });

  it('binds each semantic container to the children it can actually render', () => {
    // `actionPanel` is a toolbar of actions. A paragraph, a form field or a
    // nested panel inside one is not a layout nuance the renderer smooths over —
    // the host renders it into a row-flex toolbar where it has no meaning.
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'actionPanel',
      children: [{ kind: 'text', text: 'Not an action' }],
    }).success).toBe(false);
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'actionPanel',
      children: [{ kind: 'actionPanel', children: [] }],
    }).success).toBe(false);

    // `list` carries the accessible list role, so its children are the rows and
    // row groups a list is made of: sections, items and collection states.
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'list',
      children: [{ kind: 'text', text: 'Not a row' }],
    }).success).toBe(false);
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'list',
      children: [{ kind: 'metadata', entries: [{ label: 'Branch', value: 'dev' }] }],
    }).success).toBe(false);
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'list',
      children: [{ kind: 'list', children: [] }],
    }).success).toBe(false);

    // `section` is one titled row group: rows and states, never another section
    // and never free-form content.
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'section',
      children: [{ kind: 'section', children: [] }],
    }).success).toBe(false);
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'section',
      children: [{ kind: 'markdown', text: 'Not a row' }],
    }).success).toBe(false);

    // The approved compositions still parse, including a section-free list.
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'list',
      children: [
        { kind: 'item', title: 'Row' },
        { kind: 'state', state: 'loading', title: 'Loading' },
      ],
    }).success).toBe(true);
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'section',
      children: [{ kind: 'item', title: 'Row' }, { kind: 'state', state: 'empty', title: 'None' }],
    }).success).toBe(true);

    // Free-form containers stay free-form: the constraint is on the semantic
    // containers, not on `stack`/`group`.
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'stack',
      children: [
        { kind: 'list', children: [{ kind: 'item', title: 'Row' }] },
        { kind: 'metadata', entries: [{ label: 'Branch', value: 'dev' }] },
        { kind: 'actionPanel', children: [{ kind: 'action', action: 'sync', label: 'Sync' }] },
      ],
    }).success).toBe(true);
  });

  it('carries the new vocabulary through the declarative renderer contribution', () => {
    const parsed = PluginUiRendererV2Schema.safeParse({
      id: 'panel',
      kind: 'declarative',
      root: {
        kind: 'list',
        children: [{ kind: 'item', title: 'Row', action: { pluginId: 'acme.repos', localId: 'open' } }],
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects a bounded declarative root before recursive parser descent', () => {
    let root: Record<string, unknown> = { kind: 'text', text: 'leaf' };
    for (let index = 0; index < 10_000; index += 1) {
      root = { kind: 'stack', children: [root] };
    }

    expect(() => PluginUiRendererV2Schema.safeParse({
      id: 'deep-panel',
      kind: 'declarative',
      root,
    })).not.toThrow();
    expect(PluginUiRendererV2Schema.safeParse({
      id: 'deep-panel',
      kind: 'declarative',
      root,
    }).success).toBe(false);

    expect(PluginUiRendererV2Schema.safeParse({
      id: 'wide-panel',
      kind: 'declarative',
      root: {
        kind: 'text',
        text: 'x'.repeat(MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1),
      },
    }).success).toBe(false);

    const nestedInput = (depth: number): unknown => {
      let value: unknown = null;
      for (let currentDepth = 3; currentDepth < depth; currentDepth += 1) value = { value };
      return value;
    };
    const rendererAtDepth = (depth: number) => ({
      id: 'depth-panel',
      kind: 'declarative' as const,
      root: {
        kind: 'action' as const,
        action: { pluginId: 'acme.repos', localId: 'open' },
        label: 'Open',
        input: nestedInput(depth),
      },
    });
    expect(PluginUiRendererV2Schema.safeParse(rendererAtDepth(
      MAX_PLUGIN_DECLARATIVE_DOCUMENT_DEPTH_V1,
    )).success).toBe(true);
    expect(PluginUiRendererV2Schema.safeParse(rendererAtDepth(
      MAX_PLUGIN_DECLARATIVE_DOCUMENT_DEPTH_V1 + 1,
    )).success).toBe(false);
  });

  it('uses the canonical Collection-member grammar for declarative collection lists', () => {
    const collectionList = {
      kind: 'collectionList',
      label: { key: 'tasks.open.label', fallback: 'Open tasks' },
      source: {
        collectionId: 'tasks',
        uiQueryId: 'openByProject',
        parameters: { projectId: 'project-1' },
      },
      projection: {
        titleField: { field: 'title', kind: 'string' },
        detailField: { field: 'dueAt', kind: 'instant' },
      },
    } as const;

    expect(PluginDeclarativeNodeV2Schema.safeParse(collectionList).success).toBe(true);

    for (const invalidMemberName of [
      '',
      'project_id',
      'project/id',
      'projeçtId',
      'ProjectId',
      '1projectId',
      '-projectId',
      'projectId-',
      'project--id',
    ]) {
      expect(PluginDeclarativeNodeV2Schema.safeParse({
        ...collectionList,
        source: { ...collectionList.source, uiQueryId: invalidMemberName },
      }).success).toBe(false);
      expect(PluginDeclarativeNodeV2Schema.safeParse({
        ...collectionList,
        source: {
          ...collectionList.source,
          parameters: { [invalidMemberName]: 'project-1' },
        },
      }).success).toBe(false);
      expect(PluginDeclarativeNodeV2Schema.safeParse({
        ...collectionList,
        projection: {
          ...collectionList.projection,
          titleField: { field: invalidMemberName, kind: 'string' },
        },
      }).success).toBe(false);
    }
  });

  it('admits only fixed-reference collection row commands', () => {
    const parsed = PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'collectionList',
      source: {
        collectionId: 'tasks',
        uiQueryId: 'open-tasks',
      },
      projection: {
        titleField: { field: 'title', kind: 'string' },
      },
      primaryCommand: { kind: 'action', action: 'open-task' },
      secondaryCommands: [
        { kind: 'openSurface', destination: 'task-details' },
      ],
    });

    expect(parsed.success).toBe(true);

    // A row command carries only its already-admitted target. Projected row
    // fields, mappings and authority facts never enter its declaration.
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'collectionList',
      source: {
        collectionId: 'tasks',
        uiQueryId: 'open-tasks',
      },
      projection: {
        titleField: { field: 'title', kind: 'string' },
      },
      primaryCommand: {
        kind: 'action',
        action: 'open-task',
        input: { row: 'title' },
      },
    }).success).toBe(false);
    expect(PluginDeclarativeNodeV2Schema.safeParse({
      kind: 'collectionList',
      source: {
        collectionId: 'tasks',
        uiQueryId: 'open-tasks',
      },
      projection: {
        titleField: { field: 'title', kind: 'string' },
      },
      secondaryCommands: [{
        kind: 'openSurface',
        destination: 'task-details',
        account: 'author-supplied',
      }],
    }).success).toBe(false);
  });

  it('admits only a local Resource identity for a dynamic declarative document source', () => {
    expect(PluginUiRendererV2Schema.safeParse({
      id: 'live-panel',
      kind: 'declarative',
      root: { kind: 'text', text: 'Static first paint' },
      documentSource: { kind: 'resource', resourceId: 'live-document' },
    }).success).toBe(true);

    // Content type remains the Resource declaration's fact. Repeating it here
    // would create a second authority that could drift from the admitted source.
    expect(PluginUiRendererV2Schema.safeParse({
      id: 'live-panel',
      kind: 'declarative',
      root: { kind: 'text', text: 'Static first paint' },
      documentSource: {
        kind: 'resource',
        resourceId: 'live-document',
        contentType: PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
      },
    }).success).toBe(false);
  });
});

describe('UI contributions in the full public Manifest projection', () => {
  it('keeps the View union inline and bounded-label references unchanged in both dialects', () => {
    const projections = [createPluginManifestJsonSchemaV2()];
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      projections.push(PluginManifestV2Schema.toJSONSchema({ io: 'input', target, unrepresentable: 'any' }));
      expect(() => zodSchemaToJsonSchemaObject(PluginManifestV2Schema, { target }))
        .toThrow(ActionJsonSchemaProjectionError);
    }
    for (const schema of projections) {
      const definitions = (schema.$defs ?? schema.definitions) as Record<string, core.JSONSchema.JSONSchema>;
      const object = (node: unknown): core.JSONSchema.JSONSchema => {
        if (!node || typeof node !== 'object') throw new Error('Expected a projected schema object');
        return node as core.JSONSchema.JSONSchema;
      };
      const resolve = (node: unknown) => {
        const value = object(node);
        const reference = value.$ref ?? (value.allOf?.length === 1 ? value.allOf[0]?.$ref : undefined);
        return reference ? object(definitions[reference.slice(reference.lastIndexOf('/') + 1)]) : value;
      };
      const family = Object.values(definitions).find((node) => node.properties?.views && node.properties?.settingsGroups);
      const views = resolve(family?.properties?.views);
      expect(views.items).toEqual({ anyOf: expect.arrayContaining([{ $ref: expect.any(String) }]) });
      if (schema.$schema === 'http://json-schema.org/draft-07/schema#') {
        const view = Object.values(definitions).find((node) => {
          const container = node.properties?.container;
          return typeof container === 'object' && container.const === 'appPage' && node.properties?.badge;
        });
        const badge = resolve(view?.properties?.badge);
        expect(badge.properties?.label).toEqual({ allOf: [{ $ref: expect.any(String) }] });
        const groups = resolve(family?.properties?.settingsGroups);
        const group = resolve(groups.items);
        expect(resolve(group.properties?.title)).toEqual({ allOf: [{ $ref: expect.any(String) }] });
      }
    }
  });
});

describe('app-page header action declarations', () => {
  const appPage = {
    id: 'activity',
    container: 'appPage' as const,
    target: { kind: 'app' as const },
    renderer: 'activity-renderer',
  };

  it('admits only static execute/open semantic commands on an app page', () => {
    expect(PluginUiViewV2Schema.safeParse({
      ...appPage,
      headerActions: [{
        id: 'refresh',
        title: 'Refresh',
        icon: 'settings',
        order: 10,
        command: { kind: 'executeAction', action: 'refresh-activity' },
      }, {
        id: 'open-settings',
        title: 'Open settings',
        command: { kind: 'openSurface', destination: 'settings' },
      }],
    }).success).toBe(true);
  });

  it('rejects header actions outside appPage and dynamic status-like fields', () => {
    expect(PluginUiViewV2Schema.safeParse({
      ...appPage,
      container: 'rightPane',
      target: { kind: 'session' },
      headerActions: [{
        id: 'refresh',
        title: 'Refresh',
        command: { kind: 'executeAction', action: 'refresh-activity' },
      }],
    }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({
      ...appPage,
      headerActions: [{
        id: 'refresh',
        title: 'Refresh',
        command: { kind: 'executeAction', action: 'refresh-activity' },
        availability: { when: { kind: 'literal', value: true } },
      }],
    }).success).toBe(false);
  });
});

describe('destination presentation hints', () => {
  const appPage = {
    id: 'review-dashboard',
    container: 'appPage' as const,
    target: { kind: 'app' as const },
    renderer: 'review-renderer',
  };

  it('admits only bounded semantic presentation defaults for a destination', () => {
    const parsed = PluginUiViewV2Schema.safeParse({
      ...appPage,
      icon: 'settings',
      badge: {
        label: { key: 'review.badge.preview', fallback: 'Preview' },
        tone: 'accent',
      },
      placement: { kind: 'column', column: 'sessions' },
      rankHint: -25,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        icon: 'settings',
        badge: {
          label: { key: 'review.badge.preview', fallback: 'Preview' },
          tone: 'accent',
        },
        placement: { kind: 'column', column: 'sessions' },
        rankHint: -25,
      });
    }
  });

  it('rejects arbitrary icon, unknown placement, rank, and unbounded badge input', () => {
    expect(PluginUiViewV2Schema.safeParse({
      ...appPage,
      icon: 'brand-logo.svg',
    }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({
      ...appPage,
      obsoletePlacement: 'sessions',
    }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({
      ...appPage,
      rankHint: -10_001,
    }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({
      ...appPage,
      badge: { label: 'x'.repeat(81) },
    }).success).toBe(false);
  });

  it('admits a page column and restricts placement and column to app destinations', () => {
    expect(PluginUiViewV2Schema.safeParse({
      ...appPage,
      placement: { kind: 'rail' },
      column: { renderer: 'views-column' },
    }).success).toBe(true);
    expect(PluginUiViewV2Schema.safeParse({
      ...appPage,
      placement: { kind: 'column', column: 'workflows' },
    }).success).toBe(true);
    expect(PluginUiViewV2Schema.safeParse({
      ...appPage,
      placement: { kind: 'column', column: 'Invalid Column' },
    }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({
      ...appPage,
      container: 'rightSidebarTab',
      column: { renderer: 'views-column' },
    }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({
      ...appPage,
      container: 'rightSidebarTab',
      target: { kind: 'session' },
      placement: { kind: 'rail' },
    }).success).toBe(false);
  });

  it('rejects a ninth renderer in the same shared renderer-chain ceiling', () => {
    expect(PluginUiViewV2Schema.safeParse({
      ...appPage,
      fallbackRenderers: Array.from({ length: 8 }, (_unused, index) => `fallback-${index}`),
    }).success).toBe(false);
  });
});

describe('UI Settings page declarations', () => {
  const renderer = {
    id: 'settings-panel',
    kind: 'declarative' as const,
    root: { kind: 'text' as const, text: 'Settings panel' },
  };

  it('admits bounded local Settings groups and pages without author routes', () => {
    const parsed = PluginUiContributionsV2Schema.safeParse({
      renderers: [renderer],
      settingsGroups: [{
        id: 'review',
        title: { key: 'settings.review.title', fallback: 'Review' },
        icon: 'settings',
        defaultRank: 20,
      }],
      settingsPages: [{
        id: 'review-settings',
        group: { kind: 'plugin', localId: 'review' },
        title: { key: 'settings.review.page.title', fallback: 'Review settings' },
        subtitle: 'Configure review defaults',
        keywords: ['review', 'pull requests'],
        icon: 'settings',
        defaultRank: 10,
        renderer: 'settings-panel',
      }],
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects routes, inaccessible host groups, foreign group identities, and unbounded metadata', () => {
    const base = {
      renderers: [renderer],
      settingsPages: [{
        id: 'review-settings',
        group: { kind: 'host', id: 'general' },
        title: 'Review settings',
        renderer: 'settings-panel',
      }],
    };

    expect(PluginUiContributionsV2Schema.safeParse({
      ...base,
      settingsPages: [{ ...base.settingsPages[0], route: '/settings/review' }],
    }).success).toBe(false);
    expect(PluginUiContributionsV2Schema.safeParse({
      ...base,
      settingsPages: [{ ...base.settingsPages[0], group: { kind: 'host', id: 'profileAndAccount' } }],
    }).success).toBe(false);
    expect(PluginUiContributionsV2Schema.safeParse({
      ...base,
      settingsPages: [{ ...base.settingsPages[0], group: { kind: 'plugin', pluginId: 'other.plugin', localId: 'review' } }],
    }).success).toBe(false);
    expect(PluginUiContributionsV2Schema.safeParse({
      ...base,
      settingsPages: [{
        ...base.settingsPages[0],
        keywords: Array.from({ length: 17 }, (_unused, index) => `keyword-${index}`),
      }],
    }).success).toBe(false);
  });
});
