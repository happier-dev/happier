import { describe, expect, it } from 'vitest';

import { derivePluginUiTargetedSurfaceMountInstanceKeyV1 } from '../../ui/targetedContributions.js';
import {
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1,
  PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
  assertPluginDeclarativeDocumentResourceContentTypesV1,
  normalizePluginDeclarativeDocumentV1,
  type PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1,
} from './declarativeDocument.js';
import { preparePluginJsonSchema } from '../../actions/jsonSchemaValidation.js';
import { PluginDeclarativeNodeV2Schema } from './v2.js';

describe('declarative document normalizer v1', () => {
  const action = { pluginId: 'com.acme.dashboard', localId: 'refresh' } as const;

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
    input: Omit<PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1, 'inputValidation'>,
  ): PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1 {
    const inputValidation = preparePluginJsonSchema(input.inputSchema);
    return Object.freeze({
      ...input,
      inputSchema: inputValidation.jsonSchema,
      inputValidation,
    });
  }

  it('strictly normalizes one complete document with qualified Actions and deterministic preorder', () => {
    const normalized = normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      generation: 'generation-4',
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
        generation: 'generation-4',
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
      generation: 'generation-4',
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
      generation: 'generation-4',
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
      generation: 'generation-4',
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
      generation: 'generation-4',
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
          generation: 'generation-4',
        },
      },
      secondaryCommands: [{
        kind: 'openSurface',
        destination: {
          identity: collectionDestination,
          qualifiedId: 'com.acme.dashboard/task-details',
          generation: 'generation-4',
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
          generation: 'generation-4',
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
      generation: 'generation-4',
      actions: [action, { pluginId: 'com.acme.other', localId: 'mutate' }],
      document: {
        version: 1,
        root: { kind: 'action', action: 'refresh', label: 'Refresh' },
        requiredHostMethods: ['writeClipboard'],
      },
    }), 'plugin_declarative_document_invalid');

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      generation: 'generation-4',
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
      generation: 'generation-4',
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
      generation: 'generation-4',
      actions: [],
      document,
      preparedTargetedSurfaces: [prepareTargetedSurface({
        targetPluginId: 'com.acme.dashboard',
        handle: {
          point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
          contributor: {
            pluginId: 'com.acme.review',
            contributionId: 'detail',
            immutableGenerationId: 'review-generation-a',
          },
          role: 'detail',
          presentation: 'content',
        },
        inputSchema: {
          type: 'object',
          properties: { reviewId: { type: 'string' } },
          required: ['reviewId'],
          additionalProperties: false,
        },
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
          immutableGenerationId: 'review-generation-a',
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

  it('uses the retained admitted launch validator rather than compiling during document normalization', () => {
    const inputSchema = preparePluginJsonSchema({
      type: 'object',
      properties: { reviewId: { type: 'string' } },
      required: ['reviewId'],
      additionalProperties: false,
    });
    let validationCalls = 0;
    const inputValidation = Object.freeze({
      jsonSchema: inputSchema.jsonSchema,
      validate(value: unknown): boolean {
        validationCalls += 1;
        return inputSchema.validate(value) && false;
      },
    });
    const handle = {
      point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
      contributor: {
        pluginId: 'com.acme.review',
        contributionId: 'detail',
        immutableGenerationId: 'review-generation-a',
      },
      role: 'detail',
      presentation: 'content',
    } as const;

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      generation: 'generation-4',
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
      // prepared inventory must instead invoke the generation-retained pair.
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
      }],
    } as unknown as Parameters<typeof normalizePluginDeclarativeDocumentV1>[0]), 'plugin_declarative_targeted_surface_input_invalid');
    expect(validationCalls).toBe(1);
  });

  it('fails closed when a targeted Surface has no mounted target inventory', () => {
    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      generation: 'generation-4',
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

  it('rejects cross-target, ambiguous-generation, and invalid-input targeted Surface candidates', () => {
    const base = {
      pluginId: 'com.acme.dashboard',
      generation: 'generation-4',
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
        immutableGenerationId: 'review-generation-a',
      },
      role: 'detail',
      presentation: 'content',
    } as const;
    const inputSchema = {
      type: 'object',
      properties: { reviewId: { type: 'string' } },
      required: ['reviewId'],
      additionalProperties: false,
    } as const;

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
            contributor: { ...handle.contributor, immutableGenerationId: 'review-generation-b' },
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
        contributor: { ...surface.contributor, immutableGenerationId: 'review-generation-a' },
        presentation: 'fill',
      },
      inputSchema: { type: 'object' },
    })];
    const base = {
      pluginId: 'com.acme.dashboard',
      generation: 'generation-4',
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
      generation: 'generation-4',
      actions: [],
      preparedTargetedSurfaces: [prepareTargetedSurface({
        targetPluginId: 'com.acme.dashboard',
        handle: {
          ...surface,
          contributor: { ...surface.contributor, immutableGenerationId: 'review-generation-a' },
          presentation: 'content',
        },
        inputSchema: { type: 'object' },
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
    const deeplyNestedRoot: Record<string, unknown> = { kind: 'text', text: 'leaf' };
    let current = deeplyNestedRoot;
    // The declared semantic-node bound is 512. This deliberately exceeds it
    // by far enough that the predecessor's recursive Zod parser overflows
    // before reaching its late post-parse node count check.
    for (let index = 0; index < 10_000; index += 1) {
      current = { kind: 'stack', children: [current] };
    }

    expectNormalizationFailure(() => normalizePluginDeclarativeDocumentV1({
      pluginId: 'com.acme.dashboard',
      generation: 'generation-4',
      actions: [],
      document: { version: 1, root: current },
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
      generation: 'generation-4',
      actions: [],
      document: oversizedDocument,
    }), 'plugin_declarative_document_bytes_exceeded');
  });
});
