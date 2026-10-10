import { describe, expect, it } from 'vitest';

import { derivePluginUiTargetedSurfaceMountInstanceKeyV1 } from '../../ui/targetedContributions.js';
import {
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_DEPTH_V1,
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_NODES_V1,
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1,
  PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
  assertPluginDeclarativeDocumentResourceContentTypesV1,
  normalizePluginDeclarativeDocumentV1,
  type PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1,
} from './declarativeDocument.js';
import {
  defineProtocolObject,
  defineProtocolString,
  preparePluginJsonSchema,
  rehydrateCanonicalProtocolComposableSchema,
} from '../../actions/jsonSchemaValidation.js';
import { PluginDeclarativeNodeV2Schema } from './v2.js';
import { PluginDeclarativeProjectedModelV1Schema, PluginDeclarativeProjectedNodeV1Schema, projectPluginDeclarativeModelComparisonV1 } from './declarativeProjectedModelV1.js';

describe('declarative document normalizer v1', () => {
  it('compares declaration content independently of runtime stamps while preserving authored payloads', () => {
    const identity = { pluginId: 'com.acme.dashboard', localId: 'refresh' };
    const reference = { identity, qualifiedId: 'com.acme.dashboard/refresh' };
    const payload = { occurrenceId: 'authored', enabled: true };
    const neutral = PluginDeclarativeProjectedModelV1Schema.parse({
      identity: { pluginId: identity.pluginId, localId: 'dashboard', qualifiedId: 'com.acme.dashboard/dashboard' },
      visible: true, requiredHostMethods: [],
      declarativeInventory: { actions: [{ ...reference, enabled: false }], destinations: [], settings: [], uiQueries: [] },
      root: { kind: 'action', action: reference, label: 'Refresh', input: payload, path: 'root', order: 0, enabled: false },
    });
    const live = PluginDeclarativeProjectedModelV1Schema.parse({
      ...neutral,
      identity: { ...neutral.identity, occurrenceId: 'live' },
      declarativeInventory: { ...neutral.declarativeInventory, actions: [{ ...reference, occurrenceId: 'live', enabled: true }] },
      root: { ...neutral.root, action: { ...reference, occurrenceId: 'live' }, enabled: true },
    });
    expect(projectPluginDeclarativeModelComparisonV1(live)).toEqual(projectPluginDeclarativeModelComparisonV1(neutral));
    expect(projectPluginDeclarativeModelComparisonV1(live)).toMatchObject({ root: { input: payload } });
    for (const root of [
      { ...live.root, label: 'Changed declaration' },
      { ...live.root, input: { ...payload, occurrenceId: 'different authored value' } },
      { ...live.root, input: { ...payload, enabled: false } },
    ]) {
      expect(projectPluginDeclarativeModelComparisonV1({ ...live, root })).not.toEqual(projectPluginDeclarativeModelComparisonV1(neutral));
    }
  });

  it('rejects projected effect availability without a runtime occurrence', () => {
    const model = {
      identity: { pluginId: 'com.acme.dashboard', localId: 'dashboard', qualifiedId: 'com.acme.dashboard/dashboard' },
      visible: true,
      requiredHostMethods: [],
      declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [] },
      root: { kind: 'action', hostAction: 'session.message.send', label: 'Send', path: 'root', order: 0, enabled: true },
    };
    expect(PluginDeclarativeProjectedModelV1Schema.safeParse(model).success).toBe(false);
    expect(PluginDeclarativeProjectedModelV1Schema.safeParse({ ...model, root: { ...model.root, enabled: false } }).success).toBe(true);
    const live = { ...model, identity: { ...model.identity, occurrenceId: 'live' } };
    expect(PluginDeclarativeProjectedModelV1Schema.safeParse(live).success).toBe(true);
    for (const root of [
      { ...model.root, kind: 'unknown-node' },
      { ...model.root, action: { identity: { pluginId: 'com.acme.dashboard', localId: 'refresh' }, qualifiedId: 'com.acme.dashboard/refresh' } },
      { kind: 'action', path: 'root', order: 0, label: 'Replace draft', enabled: true, input: null,
        effect: { kind: 'composerApply', expectedRevision: 1, operations: [{ kind: 'text.set', text: 'Draft' }] } },
    ]) expect(PluginDeclarativeProjectedModelV1Schema.safeParse({ ...live, root }).success).toBe(false);
  });

  it('preserves significant Markdown whitespace through admission, normalization and projection', () => {
    const markdown = '    indented code\n\nline with hard break  \n';
    for (const text of [markdown, { key: ' note.body ', fallback: markdown }]) {
      const expectedText = typeof text === 'string' ? text : { key: 'note.body', fallback: markdown };
      const root = { kind: 'markdown', text };
      expect(PluginDeclarativeNodeV2Schema.parse(root)).toEqual({ ...root, text: expectedText });
      const normalized = normalizePluginDeclarativeDocumentV1({
        pluginId: 'com.acme.dashboard', occurrenceId: 'occurrenceId-4', actions: [],
        document: { version: 1, root },
      });
      expect(normalized.root).toEqual({ kind: 'markdown', text: expectedText, path: 'root', order: 0 });
      expect(PluginDeclarativeProjectedNodeV1Schema.parse(normalized.root)).toEqual(normalized.root);
    }
    expect(PluginDeclarativeNodeV2Schema.parse({ kind: 'text', text: ' label ' })).toEqual({ kind: 'text', text: 'label' });
  });

  const action = { pluginId: 'com.acme.dashboard', localId: 'refresh' } as const;

  it('qualifies declared drag nodes and rejects undeclared, foreign, or schema-invalid references', () => {
    const dragSources = [{ identity: { pluginId: 'com.acme.dashboard', localId: 'card' }, referenceSchema: {
      type: 'object', properties: { cardId: { type: 'string' } }, required: ['cardId'], additionalProperties: false,
    } }] as const;
    const dropTargets = [{ pluginId: 'com.acme.dashboard', localId: 'tray' }];
    const root = { kind: 'dropTarget', targetId: 'tray', input: { lane: 'review' }, children: [
      { kind: 'dragSource', sourceId: 'card', reference: { cardId: '42' }, children: [{ kind: 'text', text: 'Review' }] },
    ] };
    const normalize = (candidate: unknown) => normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard', occurrenceId: 'occurrenceId-4', actions: [], dragSources, dropTargets,
      document: { version: 1, root: candidate },
    });
    const normalized = normalize(root);
    expect(normalized.root).toMatchObject({ target: { qualifiedId: 'com.acme.dashboard/tray', occurrenceId: 'occurrenceId-4' },
      children: [{ source: { qualifiedId: 'com.acme.dashboard/card', occurrenceId: 'occurrenceId-4' }, reference: { cardId: '42' } }] });
    expect(PluginDeclarativeProjectedNodeV1Schema.parse(normalized.root)).toEqual(normalized.root);
    expectNormalizationFailure(() => normalize({ ...root, targetId: 'missing' }), 'plugin_declarative_drag_missing');
    expectNormalizationFailure(() => normalize({ ...root, targetId: { pluginId: 'com.foreign.plugin', localId: 'tray' } }), 'plugin_declarative_drag_scope_invalid');
    expectNormalizationFailure(() => normalize({ kind: 'dragSource', sourceId: 'card', reference: { sessionId: 'forged' }, children: [] }), 'plugin_declarative_drag_reference_invalid');
    expect(PluginDeclarativeNodeV2Schema.safeParse({ ...root, actionId: 'session.message.send' }).success).toBe(false);
  });

  it('carries a page widget area by name and readable context only, for a mounted plugin page', () => {
    const root = { kind: 'widgetArea', area: 'pinned', context: { repository: 'happier' } };
    const normalize = (candidate: unknown) => normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard', occurrenceId: 'occurrenceId-4', actions: [], document: { version: 1, root: candidate },
    });
    const normalized = normalize(root);
    expect(normalized.root).toEqual({ ...root, path: 'root', order: 0 });
    expect(PluginDeclarativeProjectedNodeV1Schema.parse(normalized.root)).toEqual(normalized.root);
    // A node names an area; it cannot name a Home, Account, surface or layout.
    expect(PluginDeclarativeNodeV2Schema.safeParse({ ...root, surface: { kind: 'home' } }).success).toBe(false);
    expect(PluginDeclarativeNodeV2Schema.safeParse({ ...root, area: '' }).success).toBe(false);
  });

  it('preserves a canonical host Action request without manufacturing contribution authority', () => {
    const root = { kind: 'action', hostAction: 'session.message.send', label: 'Send', input: { text: 'Hello' } };
    const normalized = normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard', occurrenceId: 'occurrenceId-4', actions: [],
      document: { version: 1, root },
    });
    expect(normalized.root).toEqual({ ...root, path: 'root', order: 0 });
    for (const invalid of [
      { ...root, hostAction: 'unknown.host.action' },
      { ...root, action: 'refresh' },
      { ...root, caller: { kind: 'human' } },
    ]) expect(PluginDeclarativeNodeV2Schema.safeParse(invalid).success).toBe(false);
  });

  function expectNormalizationFailure(call: () => unknown, code: string): void {
    try {
      call();
    } catch (error) {
      expect(error).toMatchObject({ code });
      return;
    }
    throw new Error(`expected declarative document normalization to reject with ${code}`);
  }

  function prepareTargetedSurface(
    input: Omit<PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1, 'inputValidation' | 'inputNormalizer'>,
  ): PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1 {
    const inputValidation = preparePluginJsonSchema(input.inputSchema);
    const inputNormalizer = rehydrateCanonicalProtocolComposableSchema(inputValidation.jsonSchema);
    if (!inputNormalizer) throw new Error('Expected canonical Surface schema to rehydrate');
    return Object.freeze({
      ...input,
      inputSchema: inputValidation.jsonSchema,
      inputValidation,
      inputNormalizer,
    });
  }

  it('strictly normalizes one complete document with qualified Actions and deterministic preorder', () => {
    const normalized = normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [action],
      document: {
        version: 1,
        root: {
          kind: 'stack',
          children: [
            { kind: 'text', text: 'Current status' },
            { kind: 'action', action: 'refresh', label: 'Refresh' },
            { kind: 'item', title: 'Latest result', action: 'refresh', input: { source: 'summary' } },
          ],
        },
      },
    });

    expect(normalized.nodes.map((node) => [node.kind, node.path, node.order])).toEqual([
      ['stack', 'root', 0],
      ['text', 'root.children[0]', 1],
      ['action', 'root.children[1]', 2],
      ['item', 'root.children[2]', 3],
    ]);
    expect(normalized.nodes[2]).toMatchObject({
      kind: 'action',
      action: {
        identity: action,
        qualifiedId: 'com.acme.dashboard/refresh',
        occurrenceId: 'occurrenceId-4',
      },
    });
    expect(normalized.nodes[3]).toMatchObject({
      kind: 'item',
      action: { qualifiedId: 'com.acme.dashboard/refresh' },
      input: { source: 'summary' },
    });
  });

  it('normalizes the closed composerApply effect without accepting an author-supplied Composer target', () => {
    const normalized = normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [],
      document: {
        version: 1,
        root: {
          kind: 'action',
          label: 'Replace draft',
          effect: {
            kind: 'composerApply',
            expectedRevision: 7,
            operations: [{ kind: 'text.set', text: 'Review the incident' }],
          },
        },
      },
    });

    expect(normalized.root).toMatchObject({
      kind: 'action',
      effect: {
        kind: 'composerApply',
        expectedRevision: 7,
        operations: [{ kind: 'text.set', text: 'Review the incident' }],
      },
    });
    if (normalized.root.kind !== 'action' || !('effect' in normalized.root)) {
      throw new Error('expected the composerApply action to retain its effect');
    }
    expect(Object.isFrozen(normalized.root.effect.operations)).toBe(true);

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [],
      document: {
        version: 1,
        root: {
          kind: 'action',
          label: 'Forged target',
          effect: {
            kind: 'composerApply',
            expectedRevision: 7,
            operations: [{ kind: 'text.clear' }],
            composer: { kind: 'session', sessionId: 'session-forged' },
          },
        },
      },
    }), 'plugin_declarative_document_invalid');
  });

  it('qualifies a field through the supplied immutable Settings inventory', () => {
    const normalized = normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [],
      settings: [{
        pluginId: 'com.acme.dashboard',
        id: 'refresh-interval',
        qualifiedId: 'com.acme.dashboard/settings/daemon/dashboard/fields/refresh-interval',
        schema: { type: 'integer' },
        secret: false,
      }],
      document: {
        version: 1,
        root: {
          kind: 'field',
          label: 'Refresh interval',
          control: { kind: 'number', settingId: 'refresh-interval' },
        },
      },
    });

    expect(normalized.root).toMatchObject({
      kind: 'field',
      setting: {
        pluginId: 'com.acme.dashboard',
        id: 'refresh-interval',
        qualifiedId: 'com.acme.dashboard/settings/daemon/dashboard/fields/refresh-interval',
      },
    });
  });

  it('admits a collection list only through the supplied same-plugin Data UI-query inventory', () => {
    const collectionAction = {
      pluginId: 'com.acme.dashboard',
      localId: 'open-task',
    } as const;
    const collectionDestination = {
      pluginId: 'com.acme.dashboard',
      localId: 'task-details',
    } as const;
    const uiQuery = {
      collection: {
        pluginId: 'com.acme.dashboard',
        collectionId: 'tasks',
      },
      id: 'open-tasks',
      indexId: 'by-status',
      parameters: {
        status: { kind: 'string', maxUtf8Bytes: 32, enum: ['open'] },
      },
      prefix: [{ kind: 'parameter', parameterId: 'status' }],
      order: 'asc',
      pageSize: 20,
      projectedFields: [
        { field: 'title', kind: 'string' },
        { field: 'updated-at', kind: 'instant' },
      ],
    } as const;
    const collectionDocument = {
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [collectionAction],
      destinations: [collectionDestination],
      uiQueries: [uiQuery],
      document: {
        version: 1,
        root: {
          kind: 'collectionList',
          label: { key: 'tasks.open.label', fallback: 'Open tasks' },
          source: {
            collectionId: 'tasks',
            uiQueryId: 'open-tasks',
            parameters: { status: 'open' },
          },
          projection: {
            titleField: { field: 'title', kind: 'string' },
            detailField: { field: 'updated-at', kind: 'instant' },
          },
          primaryCommand: { kind: 'action', action: 'open-task' },
          secondaryCommands: [{ kind: 'openSurface', destination: 'task-details' }],
        },
      },
    };

    const normalized = normalizePluginDeclarativeDocumentV1(collectionDocument);

    expect(normalized.root).toMatchObject({
      kind: 'collectionList',
      label: { key: 'tasks.open.label', fallback: 'Open tasks' },
      source: {
        collectionId: 'tasks',
        uiQueryId: 'open-tasks',
        parameters: { status: 'open' },
      },
      query: uiQuery,
      projection: {
        titleField: { field: 'title', kind: 'string' },
        detailField: { field: 'updated-at', kind: 'instant' },
      },
      primaryCommand: {
        kind: 'action',
        action: {
          identity: collectionAction,
          qualifiedId: 'com.acme.dashboard/open-task',
          occurrenceId: 'occurrenceId-4',
        },
      },
      secondaryCommands: [{
        kind: 'openSurface',
        destination: {
          identity: collectionDestination,
          qualifiedId: 'com.acme.dashboard/task-details',
          occurrenceId: 'occurrenceId-4',
        },
      }],
    });

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      ...collectionDocument,
      uiQueries: [{
        ...uiQuery,
        collection: { pluginId: 'com.acme.other', collectionId: 'tasks' },
      }],
    }), 'plugin_declarative_collection_query_scope_invalid');

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      ...collectionDocument,
      document: {
        version: 1,
        root: {
          ...collectionDocument.document.root,
          source: {
            ...collectionDocument.document.root.source,
            uiQueryId: 'all-tasks',
          },
        },
      },
    }), 'plugin_declarative_collection_query_missing');

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      ...collectionDocument,
      document: {
        version: 1,
        root: {
          ...collectionDocument.document.root,
          source: {
            ...collectionDocument.document.root.source,
            indexId: 'by-status',
          },
        },
      },
    }), 'plugin_declarative_document_invalid');

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      ...collectionDocument,
      document: {
        version: 1,
        root: {
          ...collectionDocument.document.root,
          projection: {
            titleField: { field: 'private-payload', kind: 'string' },
          },
        },
      },
    }), 'plugin_declarative_collection_projection_invalid');

    const crossPluginDestination = {
      pluginId: 'com.acme.provider',
      localId: 'task-details',
    } as const;
    const crossPluginNormalized = normalizePluginDeclarativeDocumentV1({
      ...collectionDocument,
      destinations: [collectionDestination, crossPluginDestination],
      document: {
        version: 1,
        root: {
          ...collectionDocument.document.root,
          secondaryCommands: [{
            kind: 'openSurface',
            destination: crossPluginDestination,
          }],
        },
      },
    });
    expect(crossPluginNormalized.root).toMatchObject({
      kind: 'collectionList',
      secondaryCommands: [{
        kind: 'openSurface',
        destination: {
          identity: crossPluginDestination,
          qualifiedId: 'com.acme.provider/task-details',
          occurrenceId: 'occurrenceId-4',
        },
      }],
    });

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      ...collectionDocument,
      document: {
        version: 1,
        root: {
          ...collectionDocument.document.root,
          primaryCommand: {
            kind: 'action',
            action: 'open-task',
            input: { title: 'forbidden row mapping' },
          },
        },
      },
    }), 'plugin_declarative_document_invalid');
  });

  it('rejects outer authority fields and cross-plugin action references before any document is admitted', () => {
    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [action, { pluginId: 'com.acme.other', localId: 'mutate' }],
      document: {
        version: 1,
        root: { kind: 'action', action: 'refresh', label: 'Refresh' },
        requiredHostMethods: ['writeClipboard'],
      },
    }), 'plugin_declarative_document_invalid');

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [action, { pluginId: 'com.acme.other', localId: 'mutate' }],
      document: {
        version: 1,
        root: {
          kind: 'action',
          action: { pluginId: 'com.acme.other', localId: 'mutate' },
          label: 'Mutate',
        },
      },
    }), 'plugin_declarative_action_scope_invalid');
  });

  it('requires the exact declared and returned Resource content type for a dynamic document', () => {
    const assertContentTypes = assertPluginDeclarativeDocumentResourceContentTypesV1;
    const contentType = PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1;
    expect(() => assertContentTypes(contentType, contentType)).not.toThrow();
    for (const mismatched of [
      'application/json',
      'application/vnd.happier.declarative-document+json',
      'application/vnd.happier.declarative-document+json;version=2',
      `${contentType};charset=utf-8`,
      'Application/vnd.happier.declarative-document+json;version=1',
      '',
      null,
    ]) {
      expectNormalizationFailure(
        () => assertContentTypes(contentType, mismatched),
        'plugin_declarative_document_content_type_invalid',
      );
      expectNormalizationFailure(
        () => assertContentTypes(mismatched, contentType),
        'plugin_declarative_document_content_type_invalid',
      );
    }

    const mismatchedDynamicCandidate = {
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [action],
      document: {
        version: 1,
        root: { kind: 'action', action: 'refresh', label: 'Refresh' },
      },
      resourceContentTypes: {
        declaredContentType: contentType,
        returnedContentType: 'application/json',
      },
    };
    expectNormalizationFailure(
      () => normalizePluginDeclarativeDocumentV1(mismatchedDynamicCandidate),
      'plugin_declarative_document_content_type_invalid',
    );
    const validDynamicCandidate = {
      ...mismatchedDynamicCandidate,
      resourceContentTypes: { declaredContentType: contentType, returnedContentType: contentType },
    };
    expect(() => normalizePluginDeclarativeDocumentV1(validDynamicCandidate)).not.toThrow();
    const { occurrenceId: _occurrenceId, ...withoutRuntime } = validDynamicCandidate;
    expectNormalizationFailure(
      () => normalizePluginDeclarativeDocumentV1(withoutRuntime),
      'plugin_declarative_generation_invalid',
    );
  });

  it('resolves a symbolic targeted Surface only from the mounted target inventory and stamps its current handle', () => {
    const document = {
      version: 1,
      root: {
        kind: 'targetedSurface',
        surface: {
          point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
          contributor: { pluginId: 'com.acme.review', contributionId: 'detail' },
          role: 'detail',
        },
        input: { reviewId: 'review-42' },
        instanceKey: 'review-42',
        fallback: { kind: 'state', state: 'loading', title: 'Loading review' },
      },
    };
    const normalized = normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [],
      document,
      preparedTargetedSurfaces: [prepareTargetedSurface({
        targetPluginId: 'com.acme.dashboard',
        handle: {
          point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
          contributor: {
            pluginId: 'com.acme.review',
            contributionId: 'detail',
            occurrenceId: 'review-occurrence-a',
            sourceCustody: { kind: 'development', registeredRootId: 'review-root' },
          },
          role: 'detail',
          presentation: 'content',
        },
        inputSchema: defineProtocolObject({
          reviewId: defineProtocolString(),
        }, { policy: 'closed' }).jsonSchema,
      })],
    });

    expect(normalized.root).toMatchObject({
      kind: 'targetedSurface',
      path: 'root',
      order: 0,
      surface: {
        point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
        contributor: {
          pluginId: 'com.acme.review',
          contributionId: 'detail',
          occurrenceId: 'review-occurrence-a',
          sourceCustody: { kind: 'development', registeredRootId: 'review-root' },
        },
        role: 'detail',
        presentation: 'content',
      },
      input: { reviewId: 'review-42' },
      fallback: {
        kind: 'state',
        path: 'root.fallback',
        order: 1,
        state: 'loading',
      },
    });
    expect(normalized.root).toMatchObject({
      instanceKey: expect.stringMatching(/^targeted-surface:v1:[a-f0-9]{64}$/u),
    });
    if (normalized.root.kind !== 'targetedSurface') {
      throw new Error('Expected the mounted target Surface leaf.');
    }
    const model = PluginDeclarativeProjectedModelV1Schema.parse({
      identity: { pluginId: 'com.acme.dashboard', localId: 'dashboard', qualifiedId: 'com.acme.dashboard/dashboard', occurrenceId: 'occurrenceId-4' },
      visible: true, requiredHostMethods: [],
      declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [] },
      root: normalized.root,
    });
    const successor = {
      ...model,
      root: {
        ...normalized.root,
        surface: { ...normalized.root.surface, contributor: { ...normalized.root.surface.contributor, occurrenceId: 'review-occurrence-b' } },
      },
    };
    expect(projectPluginDeclarativeModelComparisonV1(successor)).not.toEqual(projectPluginDeclarativeModelComparisonV1(model));
    expect(normalized.root.instanceKey).toBe(derivePluginUiTargetedSurfaceMountInstanceKeyV1({
      targetPluginId: 'com.acme.dashboard',
      surface: normalized.root.surface,
      rawInstanceKey: 'review-42',
    }));
    expect(normalized.root.instanceKey).not.toBe('review-42');
    expect(normalized.root.input).not.toBe(document.root.input);
    expect(Object.isFrozen(normalized.root.input)).toBe(true);
    document.root.input.reviewId = 'mutated-after-normalization';
    expect(normalized.root.input).toEqual({ reviewId: 'review-42' });
    expect(normalized.nodes.map((node) => [node.kind, node.path, node.order])).toEqual([
      ['targetedSurface', 'root', 0],
      ['state', 'root.fallback', 1],
    ]);
  });

  it('uses the admitted Protocol parser to distinguish Surface unknown-key policies', () => {
    const handle = {
      point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
      contributor: {
        pluginId: 'com.acme.review',
        contributionId: 'detail',
        occurrenceId: 'review-occurrence-a',
        sourceCustody: { kind: 'development', registeredRootId: 'review-root' },
      },
      role: 'detail',
      presentation: 'content',
    } as const;
    const documentFor = (input: unknown) => ({
      version: 1,
      root: {
        kind: 'targetedSurface' as const,
        surface: {
          point: handle.point,
          contributor: {
            pluginId: handle.contributor.pluginId,
            contributionId: handle.contributor.contributionId,
          },
          role: handle.role,
        },
        input,
        instanceKey: 'review-42',
      },
    });
    const normalize = (
      policy: 'closed' | 'additive-open/drop' | 'additive-open/preserve',
      input: unknown,
    ) => {
      const inputSchema = defineProtocolObject({
        known: defineProtocolString(),
      }, { policy });
      const inputValidation = preparePluginJsonSchema(inputSchema.jsonSchema);
      const inputNormalizer = rehydrateCanonicalProtocolComposableSchema(inputSchema.jsonSchema);
      if (!inputNormalizer) throw new Error('Expected canonical Surface schema to rehydrate');
      return normalizePluginDeclarativeDocumentV1({
        pluginId: 'com.acme.dashboard',
        occurrenceId: 'occurrenceId-4',
        actions: [],
        document: documentFor(input),
        preparedTargetedSurfaces: [{
          targetPluginId: 'com.acme.dashboard',
          handle,
          inputSchema: inputValidation.jsonSchema,
          inputValidation,
          inputNormalizer,
        }],
      } as unknown as Parameters<typeof normalizePluginDeclarativeDocumentV1>[0]);
    };

    const dropped = normalize('additive-open/drop', { known: 'kept', future: 'drop-me' }).root;
    const preserved = normalize('additive-open/preserve', { known: 'kept', future: 'retain-me' }).root;
    if (dropped.kind !== 'targetedSurface' || preserved.kind !== 'targetedSurface') {
      throw new Error('Expected normalized targeted Surface leaves');
    }
    expect(dropped.input).toEqual({ known: 'kept' });
    expect(preserved.input).toEqual({ known: 'kept', future: 'retain-me' });
    expectNormalizationFailure(
      () => normalize('closed', { known: 'kept', future: 'reject-me' }),
      'plugin_declarative_targeted_surface_input_invalid',
    );
  });

  it('uses the retained admitted launch validator rather than compiling during document normalization', () => {
    const targetSchema = defineProtocolObject({
      reviewId: defineProtocolString(),
    }, { policy: 'closed' }).jsonSchema;
    const inputSchema = preparePluginJsonSchema(targetSchema);
    let validationCalls = 0;
    const inputValidation = Object.freeze({
      jsonSchema: inputSchema.jsonSchema,
      validate(value: unknown): boolean {
        validationCalls += 1;
        return inputSchema.validate(value) && false;
      },
    });
    const inputNormalizer = rehydrateCanonicalProtocolComposableSchema(targetSchema);
    if (!inputNormalizer) throw new Error('Expected canonical Surface schema to rehydrate');
    const handle = {
      point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
      contributor: {
        pluginId: 'com.acme.review',
        contributionId: 'detail',
        occurrenceId: 'review-occurrence-a',
        sourceCustody: { kind: 'development', registeredRootId: 'review-root' },
      },
      role: 'detail',
      presentation: 'content',
    } as const;

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [],
      document: {
        version: 1,
        root: {
          kind: 'targetedSurface',
          surface: {
            point: handle.point,
            contributor: {
              pluginId: handle.contributor.pluginId,
              contributionId: handle.contributor.contributionId,
            },
            role: handle.role,
          },
          input: { reviewId: 'review-42' },
          instanceKey: 'review-42',
        },
      },
      // Deliberately retain the predecessor field in this test-only untyped
      // input: its old local compiler would accept the value. The canonical
      // prepared inventory must instead invoke the occurrenceId-retained pair.
      targetedSurfaces: [{
        targetPluginId: 'com.acme.dashboard',
        handle,
        inputSchema: inputSchema.jsonSchema,
      }],
      preparedTargetedSurfaces: [{
        targetPluginId: 'com.acme.dashboard',
        handle,
        inputSchema: inputSchema.jsonSchema,
        inputValidation,
        inputNormalizer,
      }],
    } as unknown as Parameters<typeof normalizePluginDeclarativeDocumentV1>[0]), 'plugin_declarative_targeted_surface_input_invalid');
    expect(validationCalls).toBe(1);
  });

  it('fails closed when a targeted Surface has no mounted target inventory', () => {
    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [],
      document: {
        version: 1,
        root: {
          kind: 'targetedSurface',
          surface: {
            point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
            contributor: { pluginId: 'com.acme.review', contributionId: 'detail' },
            role: 'detail',
          },
          input: { reviewId: 'review-42' },
          instanceKey: 'review-42',
        },
      },
    } as unknown as Parameters<typeof normalizePluginDeclarativeDocumentV1>[0]), 'plugin_declarative_targeted_surface_inventory_missing');
  });

  it('rejects cross-target, ambiguous-occurrenceId, and invalid-input targeted Surface candidates', () => {
    const base = {
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [],
      document: {
        version: 1,
        root: {
          kind: 'targetedSurface',
          surface: {
            point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
            contributor: { pluginId: 'com.acme.review', contributionId: 'detail' },
            role: 'detail',
          },
          input: { reviewId: 'review-42' },
          instanceKey: 'review-42',
        },
      },
    };
    const handle = {
      point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
      contributor: {
        pluginId: 'com.acme.review',
        contributionId: 'detail',
        occurrenceId: 'review-occurrence-a',
        sourceCustody: { kind: 'development', registeredRootId: 'review-root' },
      },
      role: 'detail',
      presentation: 'content',
    } as const;
    const inputSchema = defineProtocolObject({
      reviewId: defineProtocolString(),
    }, { policy: 'closed' }).jsonSchema;

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      ...base,
      preparedTargetedSurfaces: [prepareTargetedSurface({ targetPluginId: 'com.acme.other', handle, inputSchema })],
    }), 'plugin_declarative_targeted_surface_scope_invalid');

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      ...base,
      preparedTargetedSurfaces: [
        prepareTargetedSurface({ targetPluginId: 'com.acme.dashboard', handle, inputSchema }),
        prepareTargetedSurface({
          targetPluginId: 'com.acme.dashboard',
          handle: {
            ...handle,
            contributor: { ...handle.contributor, occurrenceId: 'review-occurrence-b' },
          },
          inputSchema,
        }),
      ],
    }), 'plugin_declarative_targeted_surface_ambiguous');

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      ...base,
      document: {
        version: 1,
        root: { ...base.document.root, input: { reviewId: 42 } },
      },
      preparedTargetedSurfaces: [prepareTargetedSurface({ targetPluginId: 'com.acme.dashboard', handle, inputSchema })],
    }), 'plugin_declarative_targeted_surface_input_invalid');
  });

  it('admits a fill targeted Surface only as the document root', () => {
    const surface = {
      point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
      contributor: { pluginId: 'com.acme.review', contributionId: 'detail' },
      role: 'detail',
    };
    const preparedTargetedSurfaces = [prepareTargetedSurface({
      targetPluginId: 'com.acme.dashboard',
      handle: {
        ...surface,
        contributor: {
          ...surface.contributor,
          occurrenceId: 'review-occurrence-a',
          sourceCustody: { kind: 'development', registeredRootId: 'review-root' },
        },
        presentation: 'fill',
      },
      inputSchema: defineProtocolObject({}, { policy: 'additive-open/preserve' }).jsonSchema,
    })];
    const base = {
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [],
      preparedTargetedSurfaces,
    };

    expect(normalizePluginDeclarativeDocumentV1({
      ...base,
      document: {
        version: 1,
        root: { kind: 'targetedSurface', surface, input: {}, instanceKey: 'review-42' },
      },
    }).root).toMatchObject({
      kind: 'targetedSurface',
      surface: { presentation: 'fill' },
    });

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      ...base,
      document: {
        version: 1,
        root: {
          kind: 'group',
          children: [{ kind: 'targetedSurface', surface, input: {}, instanceKey: 'review-42' }],
        },
      },
    }), 'plugin_declarative_targeted_surface_fill_root_required');
  });

  it('rejects a malformed targeted Surface fallback exactly as the static manifest grammar does', () => {
    const surface = {
      point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
      contributor: { pluginId: 'com.acme.review', contributionId: 'detail' },
      role: 'detail',
    } as const;
    const base = {
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [],
      preparedTargetedSurfaces: [prepareTargetedSurface({
        targetPluginId: 'com.acme.dashboard',
        handle: {
          ...surface,
          contributor: {
            ...surface.contributor,
            occurrenceId: 'review-occurrence-a',
            sourceCustody: { kind: 'development', registeredRootId: 'review-root' },
          },
          presentation: 'content',
        },
        inputSchema: defineProtocolObject({}, { policy: 'additive-open/preserve' }).jsonSchema,
      })],
    };
    const targetedSurfaceWith = (fallback: unknown) => ({
      kind: 'targetedSurface',
      surface,
      input: {},
      instanceKey: 'review-42',
      fallback,
    });

    // The author's own degradation slot is part of the document. A live
    // candidate whose fallback is unusable is rejected whole, so the mounted
    // owner keeps its last-known-good document and reports the diagnostic —
    // the host never invents replacement plugin content of its own.
    for (const unusableFallback of [
      { kind: 'state', state: 'loading', title: 'Loading review', typo: true },
      { kind: 'text', text: 'Not a state node' },
    ]) {
      const root = {
        kind: 'stack',
        children: [
          { kind: 'text', text: 'Sibling' },
          targetedSurfaceWith(unusableFallback),
        ],
      };
      expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
        ...base,
        document: { version: 1, root },
      }), 'plugin_declarative_document_invalid');
      // The deciding contract: the manifest grammar an author is validated
      // against and the live normalizer reach the SAME verdict for the same
      // bytes, so a document cannot become admissible by arriving at runtime.
      expect(PluginDeclarativeNodeV2Schema.safeParse(root).success).toBe(false);
    }

    // A well-formed fallback is still carried through verbatim, by both.
    const wellFormedRoot = targetedSurfaceWith({ kind: 'state', state: 'loading', title: 'Loading review' });
    expect(normalizePluginDeclarativeDocumentV1({
      ...base,
      document: { version: 1, root: wellFormedRoot },
    }).root).toMatchObject({
      kind: 'targetedSurface',
      fallback: { kind: 'state', state: 'loading', title: 'Loading review' },
    });
    expect(PluginDeclarativeNodeV2Schema.safeParse(wellFormedRoot).success).toBe(true);

    // The envelope is still all-or-nothing.
    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      ...base,
      document: { version: 2, root: wellFormedRoot },
    }), 'plugin_declarative_document_invalid');
    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      ...base,
      document: {
        version: 1,
        root: wellFormedRoot,
        extra: 'not part of the envelope',
      },
    }), 'plugin_declarative_document_invalid');

    // Every other node slot stays atomic too.
    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      ...base,
      document: {
        version: 1,
        root: {
          kind: 'stack',
          children: [
            { kind: 'text', text: 'Sibling', typo: true },
            wellFormedRoot,
          ],
        },
      },
    }), 'plugin_declarative_document_invalid');
    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      ...base,
      document: {
        version: 1,
        root: { kind: 'targetedSurface', surface, input: {}, instanceKey: 42 },
      },
    }), 'plugin_declarative_document_invalid');
  });

  it('rejects oversized and deeply nested documents before recursive parsing', () => {
    // Keep this independent semantic-node proof shallow enough that the
    // document's earned depth profile is not the first boundary to reject it.
    // The root container plus 512 children exceeds the 512-node ceiling by one.
    const tooManySemanticNodes = {
      kind: 'stack',
      children: Array.from(
        { length: MAX_PLUGIN_DECLARATIVE_DOCUMENT_NODES_V1 },
        (_, index) => ({ kind: 'text', text: `leaf-${index}` }),
      ),
    };

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [],
      document: { version: 1, root: tooManySemanticNodes },
    }), 'plugin_declarative_nodes_exceeded');

    const oversizedDocument = {
      version: 1,
      root: {
        kind: 'text',
        text: 'x'.repeat(MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1),
      },
    };
    expect(new TextEncoder().encode(JSON.stringify(oversizedDocument)).byteLength)
      .toBeGreaterThan(MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1);
    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [],
      document: oversizedDocument,
    }), 'plugin_declarative_document_bytes_exceeded');

    const nestedInput = (depth: number): unknown => {
      let value: unknown = null;
      for (let currentDepth = 3; currentDepth < depth; currentDepth += 1) value = { value };
      return value;
    };
    const normalizeAtDepth = (depth: number) => normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      occurrenceId: 'occurrenceId-4',
      actions: [action],
      document: {
        version: 1,
        root: {
          kind: 'action',
          action,
          label: 'Refresh',
          input: nestedInput(depth),
        },
      },
    });
    expect(normalizeAtDepth(MAX_PLUGIN_DECLARATIVE_DOCUMENT_DEPTH_V1).root).toBeDefined();
    expectNormalizationFailure(
      () => normalizeAtDepth(MAX_PLUGIN_DECLARATIVE_DOCUMENT_DEPTH_V1 + 1),
      'plugin_declarative_document_depth_exceeded',
    );
  });
});
