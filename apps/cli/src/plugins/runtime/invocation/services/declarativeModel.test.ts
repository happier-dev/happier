import { describe, expect, it } from 'vitest';

import type {
    NormalizedPluginCollectionUiQueryDescriptorV1,
    PluginSettingsContributionV2,
} from '@happier-dev/protocol';
import {
    preparePluginJsonSchema,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import {
    defineProtocolObject,
    defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';

import {
    createStablePluginDeclarativeModel,
    createStablePluginStructuredMessageModel,
} from './declarativeModel';
import type { HostStructuredMessageDescriptorV1 } from './structuredMessageDescriptor';
import { createStablePluginSettingsModel } from './settings';
import { listDeclarativeNodesInPreorder } from './declarativeModel.testkit';

const settingsContribution: PluginSettingsContributionV2 = {
    id: 'appearance',
    version: 1,
    title: 'Appearance',
    target: { kind: 'plugin' },
    scope: 'daemon',
    fields: [
        { id: 'enabled', title: 'Enabled', schema: { type: 'boolean' }, default: false },
        {
            id: 'mode',
            title: 'Mode',
            schema: { type: 'string', enum: ['compact', 'full'] },
            default: 'compact',
        },
    ],
    presentation: { sections: [], subagentSections: [] },
};

function expectPluginError(operation: () => unknown, code: string): void {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(PluginError);
        expect((error as PluginError).code).toBe(code);
        return;
    }
    throw new Error(`Expected PluginError '${code}'`);
}

describe('stable declarative plugin model', () => {
    it('normalizes fields and inert qualified actions in deterministic preorder', () => {
        const settings = createStablePluginSettingsModel({
            pluginId: 'com.acme.forms',
            contribution: settingsContribution,
        });

        const model = createStablePluginDeclarativeModel({
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            renderer: {
                id: 'preferences',
                kind: 'declarative',
                root: {
                    kind: 'stack',
                    children: [
                        { kind: 'field', label: 'Enabled', control: { kind: 'toggle', settingId: 'enabled' } },
                        {
                            kind: 'field',
                            label: 'Mode',
                            control: {
                                kind: 'select',
                                settingId: 'mode',
                                options: [
                                    { value: 'compact', label: 'Compact' },
                                    { value: 'full', label: 'Full' },
                                ],
                            },
                        },
                        { kind: 'action', action: 'save', label: 'Save', input: { source: 'form' } },
                        {
                            kind: 'action',
                            action: 'reset',
                            label: 'Reset',
                        },
                    ],
                },
            },
            settings: [settings],
            actions: [
                { pluginId: 'com.acme.forms', localId: 'save' },
                { pluginId: 'com.acme.forms', localId: 'reset' },
            ],
            availability: {
                visible: true,
                enabledActions: {
                    'com.acme.forms/save': true,
                    'com.acme.forms/reset': false,
                },
            },
        });

        expect(model.identity).toEqual({
            pluginId: 'com.acme.forms',
            localId: 'preferences',
            qualifiedId: 'com.acme.forms/preferences',
            generation: 'generation-7',
        });
        expect(model.visible).toBe(true);
        const nodes = listDeclarativeNodesInPreorder(model.root);
        expect(nodes.map((node) => [node.kind, node.path, node.order])).toEqual([
            ['stack', 'root', 0],
            ['field', 'root.children[0]', 1],
            ['field', 'root.children[1]', 2],
            ['action', 'root.children[2]', 3],
            ['action', 'root.children[3]', 4],
        ]);
        expect(nodes[1]).toMatchObject({
            kind: 'field',
            setting: {
                id: 'enabled',
                qualifiedId: 'com.acme.forms/settings/daemon/appearance/fields/enabled',
                descriptor: { schema: { type: 'boolean' } },
            },
        });
        expect(nodes[3]).toMatchObject({
            kind: 'action',
            action: {
                identity: { pluginId: 'com.acme.forms', localId: 'save' },
                qualifiedId: 'com.acme.forms/save',
            },
            enabled: true,
            input: { source: 'form' },
        });
        expect(nodes[4]).toMatchObject({
            kind: 'action',
            action: { qualifiedId: 'com.acme.forms/reset' },
            enabled: false,
        });
    expect(Object.isFrozen(model)).toBe(true);
  });

    // The model is a wire payload. `root` is the only representation any reader
    // walks, so carrying a second flat copy of the same node objects made every
    // container's subtree appear once per ancestor level — an O(nodes x depth)
    // multiplier on a response that already exceeded 200 KB.
    it('carries the document once, as root, with no duplicate flat node list', () => {
        const model = createStablePluginDeclarativeModel({
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            renderer: {
                id: 'nested',
                kind: 'declarative',
                root: {
                    kind: 'stack',
                    children: [{
                        kind: 'list',
                        label: 'Repositories',
                        children: [{
                            kind: 'section',
                            title: 'Active',
                            children: [{ kind: 'item', title: 'deeply-nested-marker' }],
                        }],
                    }],
                },
            },
            settings: [],
            actions: [],
        } as unknown as Parameters<typeof createStablePluginDeclarativeModel>[0]);

        // The tree is intact and still enumerable in preorder from root alone.
        expect(listDeclarativeNodesInPreorder(model.root).map((node) => node.kind))
            .toEqual(['stack', 'list', 'section', 'item']);

        // Nothing reads a flat copy, so the payload must not carry one.
        expect(Object.hasOwn(model, 'nodes')).toBe(false);

        // The discriminating fact: the deepest node appears exactly once on the
        // wire. With a parallel `nodes` array it appeared four times — once in
        // root's subtree and once inside each ancestor's own entry.
        const serialized = JSON.stringify(model);
        expect(serialized.split('deeply-nested-marker').length - 1).toBe(1);
    });

  it('projects a target-local Surface only from the exact host-stamped inventory', () => {
    const inputNormalizer = defineProtocolObject({
      reviewId: defineProtocolString(),
    }, { policy: 'closed' });
    const inputValidation = preparePluginJsonSchema(inputNormalizer.jsonSchema);
    const model = createStablePluginDeclarativeModel({
      pluginId: 'com.acme.dashboard',
      generation: 'generation-dashboard-a',
      renderer: {
        id: 'dashboard',
        kind: 'declarative',
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
      },
      settings: [],
      actions: [],
      preparedTargetedSurfaces: [{
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
        inputSchema: inputValidation.jsonSchema,
        inputValidation,
        inputNormalizer,
      }],
      availability: { visible: true, enabledActions: {} },
    });

    expect(model.root).toMatchObject({
      kind: 'targetedSurface',
      surface: {
        contributor: {
          pluginId: 'com.acme.review',
          contributionId: 'detail',
          immutableGenerationId: 'review-generation-a',
        },
        presentation: 'content',
      },
      input: { reviewId: 'review-42' },
      instanceKey: expect.stringMatching(/^targeted-surface:v1:[a-f0-9]{64}$/u),
      fallback: { kind: 'state', state: 'loading' },
    });
    expect(listDeclarativeNodesInPreorder(model.root).map((node) => node.kind)).toEqual(['targetedSurface', 'state']);
  });

  it('projects the full admitted Action and Settings inventory independently of the static root', () => {
    const settings = createStablePluginSettingsModel({
      pluginId: 'com.acme.forms',
      contribution: settingsContribution,
    });
    const model = createStablePluginDeclarativeModel({
      pluginId: 'com.acme.forms',
      generation: 'generation-8',
      renderer: {
        id: 'text-only',
        kind: 'declarative',
        root: { kind: 'text', text: 'Static first paint' },
      },
      settings: [settings],
      actions: [
        { pluginId: 'com.acme.forms', localId: 'refresh' },
        { pluginId: 'com.acme.other', localId: 'outside' },
      ],
      availability: {
        visible: true,
        enabledActions: {
          'com.acme.forms/refresh': true,
          'com.acme.other/outside': true,
        },
      },
    });

    expect(model.declarativeInventory).toMatchObject({
      actions: [{
        identity: { pluginId: 'com.acme.forms', localId: 'refresh' },
        qualifiedId: 'com.acme.forms/refresh',
        generation: 'generation-8',
        enabled: true,
      }],
      settings: [
        {
          pluginId: 'com.acme.forms',
          id: 'enabled',
          qualifiedId: 'com.acme.forms/settings/daemon/appearance/fields/enabled',
          secret: false,
          schema: { type: 'boolean' },
        },
        {
          pluginId: 'com.acme.forms',
          id: 'mode',
          qualifiedId: 'com.acme.forms/settings/daemon/appearance/fields/mode',
          secret: false,
          schema: { type: 'string', enum: ['compact', 'full'] },
        },
      ],
    });
  });

  it('projects a declarative collection list from the supplied Data-normalized UI-query inventory', () => {
    const uiQuery = {
      collection: { pluginId: 'com.acme.forms', collectionId: 'tasks' },
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
    } satisfies NormalizedPluginCollectionUiQueryDescriptorV1;
    const model = createStablePluginDeclarativeModel({
      pluginId: 'com.acme.forms',
      generation: 'generation-8',
      renderer: {
        id: 'tasks',
        kind: 'declarative',
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
        },
      },
      settings: [],
      actions: [],
      uiQueries: [uiQuery],
      availability: { visible: true, enabledActions: {} },
    });

    expect(model.declarativeInventory.uiQueries).toEqual([uiQuery]);
    expect(model.root).toMatchObject({
      kind: 'collectionList',
      label: { key: 'tasks.open.label', fallback: 'Open tasks' },
      source: { collectionId: 'tasks', uiQueryId: 'open-tasks', parameters: { status: 'open' } },
      query: uiQuery,
      projection: {
        titleField: { field: 'title', kind: 'string' },
        detailField: { field: 'updated-at', kind: 'instant' },
      },
    });
  });

  it('projects fixed collection row commands with their Action presentation and destination inventory', () => {
    const uiQuery = {
      collection: { pluginId: 'com.acme.forms', collectionId: 'tasks' },
      id: 'open-tasks',
      indexId: 'by-status',
      parameters: {
        status: { kind: 'string', maxUtf8Bytes: 32, enum: ['open'] },
      },
      prefix: [{ kind: 'parameter', parameterId: 'status' }],
      order: 'asc',
      pageSize: 20,
      projectedFields: [{ field: 'title', kind: 'string' }],
    } satisfies NormalizedPluginCollectionUiQueryDescriptorV1;
    const inspect = { pluginId: 'com.acme.forms', localId: 'inspect-task' } as const;
    const details = { pluginId: 'com.acme.forms', localId: 'task-details' } as const;

    const model = createStablePluginDeclarativeModel({
      pluginId: 'com.acme.forms',
      generation: 'generation-collection-commands',
      renderer: {
        id: 'tasks',
        kind: 'declarative',
        root: {
          kind: 'collectionList',
          source: {
            collectionId: 'tasks',
            uiQueryId: 'open-tasks',
            parameters: { status: 'open' },
          },
          projection: { titleField: { field: 'title', kind: 'string' } },
          primaryCommand: { kind: 'action', action: 'inspect-task' },
          secondaryCommands: [{ kind: 'openSurface', destination: 'task-details' }],
        },
      },
      settings: [],
      actions: [inspect],
      actionPresentations: [{ identity: inspect, title: 'Inspect task', icon: 'eye' }],
      destinations: [details],
      uiQueries: [uiQuery],
      availability: {
        visible: true,
        enabledActions: { 'com.acme.forms/inspect-task': true },
      },
    });

    expect(model.declarativeInventory).toMatchObject({
      actions: [{
        identity: inspect,
        qualifiedId: 'com.acme.forms/inspect-task',
        title: 'Inspect task',
        icon: 'eye',
      }],
      destinations: [{
        identity: details,
        qualifiedId: 'com.acme.forms/task-details',
        generation: 'generation-collection-commands',
      }],
    });
    expect(model.root).toMatchObject({
      kind: 'collectionList',
      primaryCommand: {
        kind: 'action',
        action: {
          identity: inspect,
          qualifiedId: 'com.acme.forms/inspect-task',
          generation: 'generation-collection-commands',
        },
      },
      secondaryCommands: [{
        kind: 'openSurface',
        destination: {
          identity: details,
          qualifiedId: 'com.acme.forms/task-details',
          generation: 'generation-collection-commands',
        },
      }],
    });
  });

    it('fails closed for invalid select values and missing actions', () => {
        const settings = createStablePluginSettingsModel({
            pluginId: 'com.acme.forms',
            contribution: settingsContribution,
        });
        const base = {
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            actions: [{ pluginId: 'com.acme.forms', localId: 'save' }],
            availability: { visible: true, enabledActions: {} },
        } as const;

        expectPluginError(() => createStablePluginDeclarativeModel({
            ...base,
            settings: [settings],
            renderer: {
                id: 'bad-option',
                kind: 'declarative',
                root: {
                    kind: 'field',
                    label: 'Mode',
                    control: { kind: 'select', settingId: 'mode', options: [{ value: 'other', label: 'Other' }] },
                },
            },
        }), 'plugin_declarative_option_invalid');

        expectPluginError(() => createStablePluginDeclarativeModel({
            ...base,
            settings: [settings],
            renderer: {
                id: 'missing-action',
                kind: 'declarative',
                root: { kind: 'action', action: 'missing', label: 'Missing' },
            },
        }), 'plugin_declarative_action_missing');
    });

    it('rejects a foreign Action even when that Action appears in the admitted inventory', () => {
        expectPluginError(() => createStablePluginDeclarativeModel({
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            settings: [],
            actions: [
                { pluginId: 'com.acme.forms', localId: 'save' },
                { pluginId: 'com.acme.other', localId: 'mutate' },
            ],
            renderer: {
                id: 'foreign-action',
                kind: 'declarative',
                root: {
                    kind: 'action',
                    action: { pluginId: 'com.acme.other', localId: 'mutate' },
                    label: 'Mutate',
                },
            },
        }), 'plugin_declarative_action_scope_invalid');
    });

    it('rejects semantically duplicate structured select options', () => {
        const nullPrototypeValue = {
            columns: 2.5,
            nested: [{ score: -0 }],
            valueOf: null,
        };
        Object.setPrototypeOf(nullPrototypeValue, null);
        const settings = createStablePluginSettingsModel({
            pluginId: 'com.acme.forms',
            contribution: {
                id: 'structured',
                version: 1,
                title: 'Structured',
                target: { kind: 'plugin' },
                scope: 'daemon',
                fields: [{
                    id: 'layout',
                    title: 'Layout',
                    schema: {
                        type: 'object',
                        enum: [nullPrototypeValue],
                    },
                }],
                presentation: { sections: [], subagentSections: [] },
            },
        });

        expectPluginError(() => createStablePluginDeclarativeModel({
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            settings: [settings],
            actions: [],
            renderer: {
                id: 'duplicate-options',
                kind: 'declarative',
                root: {
                    kind: 'field',
                    label: 'Layout',
                    control: {
                        kind: 'select',
                        settingId: 'layout',
                        options: [
                            { value: nullPrototypeValue, label: 'First' },
                            {
                                value: { valueOf: null, nested: [{ score: 0 }], columns: 2.5 },
                                label: 'Duplicate',
                            },
                        ],
                    },
                },
            },
        }), 'plugin_declarative_option_duplicate');

        let valueOfReads = 0;
        const accessorValue: Record<string, unknown> = { columns: 2.5, nested: [{ score: 0 }] };
        Object.defineProperty(accessorValue, 'valueOf', {
            enumerable: true,
            get() {
                valueOfReads += 1;
                return null;
            },
        });
        expectPluginError(() => createStablePluginDeclarativeModel({
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            settings: [settings],
            actions: [],
            renderer: {
                id: 'accessor-option',
                kind: 'declarative',
                root: {
                    kind: 'field',
                    label: 'Layout',
                    control: {
                        kind: 'select',
                        settingId: 'layout',
                        options: [{ value: accessorValue, label: 'Unsafe' }],
                    },
                },
            },
        }), 'plugin_declarative_invalid_plain_data');
        expect(valueOfReads).toBe(0);
    });

    it('rejects noncanonical array properties while preserving valid unbounded JSON keys', () => {
        const actionInput: unknown[] = [];
        Object.defineProperty(actionInput, '01', {
            value: 'hidden',
            enumerable: true,
        });
        const base = {
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            settings: [],
            actions: [{ pluginId: 'com.acme.forms', localId: 'save' }],
        } as const;

        expectPluginError(() => createStablePluginDeclarativeModel({
            ...base,
            renderer: {
                id: 'array-property',
                kind: 'declarative',
                root: { kind: 'action', action: 'save', label: 'Save', input: actionInput },
            },
        }), 'plugin_declarative_invalid_plain_data');

        const model = createStablePluginDeclarativeModel({
            ...base,
            renderer: {
                id: 'oversized-key',
                kind: 'declarative',
                root: {
                    kind: 'action',
                    action: 'save',
                    label: 'Save',
                    input: { ['k'.repeat((256 * 1024) + 1)]: null },
                },
            },
        });

        expect(model.root).toMatchObject({
            kind: 'action',
            input: { ['k'.repeat((256 * 1024) + 1)]: null },
        });
    });

    it('maps malformed availability to a coded model error', () => {
        expectPluginError(() => createStablePluginDeclarativeModel({
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            settings: [],
            actions: [],
            renderer: {
                id: 'malformed-availability',
                kind: 'declarative',
                root: { kind: 'text', text: 'Safe' },
            },
            availability: null as unknown as { visible: boolean; enabledActions: Readonly<Record<string, boolean>> },
        }), 'plugin_declarative_availability_invalid');
    });

    // The renderer owns its semantic-node ceiling and its earned whole-document
    // plain-data depth profile (48, counting every object/array container).
    // Strict JSON itself has no generic quota; the declarative preflight owns
    // this document's own bounds and both static and dynamic paths share them.
    it('enforces the declarative node and earned depth ceilings', () => {
        const nest = (depth: number): { kind: 'stack'; children: readonly unknown[] } | { kind: 'text'; text: string } => (
            depth === 0
                ? { kind: 'text', text: 'leaf' }
                : { kind: 'stack', children: [nest(depth - 1)] }
        );
        const flat = (count: number) => ({
            kind: 'stack' as const,
            children: Array.from({ length: count }, (_unused, index) => ({
                kind: 'text' as const,
                text: `line-${index}`,
            })),
        });
        const build = (root: unknown) => createStablePluginDeclarativeModel({
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            settings: [],
            actions: [],
            renderer: { id: 'bounded', kind: 'declarative', root: root as never },
        });

        // Each semantic level costs one object plus one children array, and
        // the deepest node's own scalars land at plain-data depth 2N+3, so
        // the earned depth-48 boundary admits a 22-level chain and rejects 23.
        expect(build(nest(22)).root).toBeDefined();
        expectPluginError(() => build(nest(23)), 'plugin_declarative_document_depth_exceeded');

        // The root stack counts, so 511 children is exactly 512 nodes.
        expect(build(flat(511)).root).toBeDefined();
        expectPluginError(() => build(flat(512)), 'plugin_declarative_nodes_exceeded');
    });

    it('normalizes the list vocabulary and binds item actions through the one action owner', () => {
        const model = createStablePluginDeclarativeModel({
            pluginId: 'com.acme.repos',
            generation: 'generation-7',
            settings: [],
            actions: [
                { pluginId: 'com.acme.repos', localId: 'open' },
                { pluginId: 'com.acme.repos', localId: 'archive' },
            ],
            availability: {
                visible: true,
                enabledActions: { 'com.acme.repos/open': true, 'com.acme.repos/archive': false },
            },
            renderer: {
                id: 'repositories',
                kind: 'declarative',
                // `metadata` and `actionPanel` are siblings of the list, not rows
                // inside it: the grammar binds `list` to sections/items/states so
                // a toolbar can never be announced as a list row.
                root: {
                    kind: 'stack',
                    children: [
                        {
                            kind: 'list',
                            label: 'Repositories',
                            children: [
                                {
                                    kind: 'section',
                                    title: 'Active',
                                    footer: 'Refreshed on reload',
                                    children: [
                                        {
                                            kind: 'item',
                                            title: 'happier',
                                            subtitle: 'Main repository',
                                            detail: '42',
                                            icon: 'file',
                                            tone: 'success',
                                            action: 'open',
                                            input: { id: 'happier' },
                                        },
                                        { kind: 'item', title: 'archived', action: 'archive' },
                                        { kind: 'item', title: 'read only' },
                                    ],
                                },
                                { kind: 'state', state: 'empty', title: 'No archived repositories', icon: 'info' },
                            ],
                        },
                        { kind: 'metadata', title: 'Details', entries: [{ label: 'Branch', value: 'dev', tone: 'muted' }] },
                        {
                            kind: 'actionPanel',
                            title: 'Repository actions',
                            children: [{ kind: 'action', action: 'archive', label: 'Archive', variant: 'destructive' }],
                        },
                    ],
                } as never,
            },
        });

        const nodes = listDeclarativeNodesInPreorder(model.root);
        expect(nodes.map((node) => [node.kind, node.path, node.order])).toEqual([
            ['stack', 'root', 0],
            ['list', 'root.children[0]', 1],
            ['section', 'root.children[0].children[0]', 2],
            ['item', 'root.children[0].children[0].children[0]', 3],
            ['item', 'root.children[0].children[0].children[1]', 4],
            ['item', 'root.children[0].children[0].children[2]', 5],
            ['state', 'root.children[0].children[1]', 6],
            ['metadata', 'root.children[1]', 7],
            ['actionPanel', 'root.children[2]', 8],
            ['action', 'root.children[2].children[0]', 9],
        ]);
        // An item action is qualified and policy-gated by the SAME owner as an
        // `action` node — an item must never become a second dispatch path.
        expect(nodes[3]).toMatchObject({
            kind: 'item',
            title: 'happier',
            icon: 'file',
            tone: 'success',
            action: { qualifiedId: 'com.acme.repos/open', generation: 'generation-7' },
            input: { id: 'happier' },
            enabled: true,
        });
        expect(nodes[4]).toMatchObject({ kind: 'item', enabled: false });
        expect(nodes[5]).not.toHaveProperty('action');
        expect(nodes[5]).not.toHaveProperty('enabled');
        expect(nodes[6]).toMatchObject({ kind: 'state', state: 'empty', icon: 'info' });
        expect(nodes[7]).toMatchObject({
            kind: 'metadata',
            entries: [{ label: 'Branch', value: 'dev', tone: 'muted' }],
        });
        expect(nodes[9]).toMatchObject({ kind: 'action', enabled: false });
    });

    it('refuses a semantic container holding children it cannot render', () => {
        const build = (root: unknown) => createStablePluginDeclarativeModel({
            pluginId: 'com.acme.repos',
            generation: 'generation-7',
            settings: [],
            actions: [{ pluginId: 'com.acme.repos', localId: 'open' }],
            renderer: { id: 'grammar', kind: 'declarative', root: root as never },
        });

        // The evaluated model refuses through the SAME typed code as any other
        // invalid renderer — it never drops the misplaced child and renders the
        // rest.
        expectPluginError(() => build({
            kind: 'actionPanel',
            children: [{ kind: 'text', text: 'Not an action' }],
        }), 'plugin_declarative_document_invalid');
        expectPluginError(() => build({
            kind: 'list',
            children: [{ kind: 'metadata', entries: [{ label: 'Branch', value: 'dev' }] }],
        }), 'plugin_declarative_document_invalid');
        expectPluginError(() => build({
            kind: 'section',
            children: [{ kind: 'section', children: [] }],
        }), 'plugin_declarative_document_invalid');
    });

    it('fails closed for an unbound item action and an input without one', () => {
        const base = {
            pluginId: 'com.acme.repos',
            generation: 'generation-7',
            settings: [],
            actions: [{ pluginId: 'com.acme.repos', localId: 'open' }],
            availability: { visible: true, enabledActions: {} },
        } as const;

        expectPluginError(() => createStablePluginDeclarativeModel({
            ...base,
            renderer: {
                id: 'unbound',
                kind: 'declarative',
                root: { kind: 'item', title: 'Row', action: 'missing' } as never,
            },
        }), 'plugin_declarative_action_missing');

        // A launch input with no action to launch is an authoring mistake, not a
        // silently ignored field.
        expectPluginError(() => createStablePluginDeclarativeModel({
            ...base,
            renderer: {
                id: 'inputless',
                kind: 'declarative',
                root: { kind: 'item', title: 'Row', input: { id: 'x' } } as never,
            },
        }), 'plugin_declarative_item_action_missing');
    });

    it('projects a realistic list under the node budget and rejects an over-budget one', () => {
        const rows = (count: number) => ({
            kind: 'list' as const,
            children: [{
                kind: 'section' as const,
                title: 'Rows',
                children: Array.from({ length: count }, (_unused, index) => ({
                    kind: 'item' as const,
                    title: `row-${index}`,
                })),
            }],
        });
        const build = (root: unknown) => createStablePluginDeclarativeModel({
            pluginId: 'com.acme.repos',
            generation: 'generation-7',
            settings: [],
            actions: [],
            renderer: { id: 'rows', kind: 'declarative', root: root as never },
        });

        // Bounds disposition (plan §EU-9): MAX_DECLARATIVE_NODES stays 512. A
        // declarative tree is an authored manifest document, so 200 rows is a
        // generous realistic ceiling and still leaves ~300 nodes of headroom.
        expect(listDeclarativeNodesInPreorder(build(rows(200)).root)).toHaveLength(202);
        // Over-cap rejects through the existing typed code — it never truncates.
        expectPluginError(() => build(rows(511)), 'plugin_declarative_nodes_exceeded');
    });

    it('maps a malformed identity inventory to its coded domain error', () => {
        expectPluginError(() => createStablePluginDeclarativeModel({
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            settings: [],
            actions: null as unknown as [],
            renderer: {
                id: 'malformed-actions',
                kind: 'declarative',
                root: { kind: 'text', text: 'Safe' },
            },
        }), 'plugin_action_identity_invalid');
    });
});

describe('stable structured-message plugin model', () => {
    const descriptor: HostStructuredMessageDescriptorV1 = {
        id: 'build-result',
        title: 'Build result',
        kind: 'acme.build-result.v1',
        payloadSchema: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['passed', 'failed'] } },
            required: ['status'],
            additionalProperties: false,
        },
        renderer: 'result-card',
        actions: ['retry', { pluginId: 'com.acme.shared', localId: 'open-log' }],
        fallback: { kind: 'summary', template: 'Build: {{status}}' },
        availability: { when: { fact: 'session.exists', operator: 'equals', value: true } },
    };

    it('normalizes bounded values, actions, resources, fallback, and generation identity without executing them', () => {
        const model = createStablePluginStructuredMessageModel({
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            descriptor,
            value: {
                kind: 'acme.build-result.v1',
                payload: { status: 'passed' },
                resources: ['report', { pluginId: 'com.acme.shared', localId: 'log' }],
            },
            actions: [
                { pluginId: 'com.acme.build', localId: 'retry' },
                { pluginId: 'com.acme.shared', localId: 'open-log' },
            ],
            resources: [
                { pluginId: 'com.acme.build', localId: 'report' },
                { pluginId: 'com.acme.shared', localId: 'log' },
            ],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
            availability: {
                visible: true,
                enabledActions: {
                    'com.acme.build/retry': false,
                    'com.acme.shared/open-log': true,
                },
            },
        });

        expect(model.identity).toEqual({
            pluginId: 'com.acme.build',
            localId: 'build-result',
            qualifiedId: 'com.acme.build/build-result',
            generation: 'generation-8',
        });
        expect(model.renderer.qualifiedId).toBe('com.acme.build/result-card');
        expect(model.actions.map((action) => [action.qualifiedId, action.enabled])).toEqual([
            ['com.acme.build/retry', false],
            ['com.acme.shared/open-log', true],
        ]);
        expect(model.resources.map((resource) => resource.qualifiedId)).toEqual([
            'com.acme.build/report',
            'com.acme.shared/log',
        ]);
        expect(model.payload).toEqual({ status: 'passed' });
        expect(Object.getPrototypeOf(model.payload)).toBeNull();
        expect(model.fallback).toEqual({ kind: 'summary', template: 'Build: {{status}}' });
        expect(model.visible).toBe(true);
    });

    it('validates values and references, fails conditional visibility closed, and rejects accessors without reading them', () => {
        const base = {
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            descriptor,
            actions: [
                { pluginId: 'com.acme.build', localId: 'retry' },
                { pluginId: 'com.acme.shared', localId: 'open-log' },
            ],
            resources: [{ pluginId: 'com.acme.build', localId: 'report' }],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
        } as const;

        const unavailable = createStablePluginStructuredMessageModel({
            ...base,
            value: { kind: 'acme.build-result.v1', payload: { status: 'passed' }, resources: [] },
        });
        expect(unavailable.visible).toBe(false);
        expect(unavailable.actions.every((action) => action.enabled === false)).toBe(true);

        expectPluginError(() => createStablePluginStructuredMessageModel({
            ...base,
            value: { kind: 'acme.build-result.v1', payload: { status: 'unknown' }, resources: [] },
        }), 'plugin_structured_message_payload_invalid');

        expectPluginError(() => createStablePluginStructuredMessageModel({
            ...base,
            value: { kind: 'acme.build-result.v1', payload: { status: 'passed' }, resources: ['missing'] },
        }), 'plugin_structured_message_resource_missing');

        let getterReads = 0;
        const payload = Object.create(null) as { status: string };
        Object.defineProperty(payload, 'status', {
            enumerable: true,
            get() {
                getterReads += 1;
                return 'passed';
            },
        });
        expectPluginError(() => createStablePluginStructuredMessageModel({
            ...base,
            value: { kind: 'acme.build-result.v1', payload, resources: [] },
        }), 'plugin_structured_message_invalid_plain_data');
        expect(getterReads).toBe(0);
    });

    it('applies nested const and oneOf ambiguity with safe JSON equality', () => {
        const nullPrototypePayload = {
            rows: [{ score: 1.5 }],
            valueOf: null,
        };
        Object.setPrototypeOf(nullPrototypePayload, null);
        const base = {
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            actions: [],
            resources: [],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
        } as const;
        const exact = createStablePluginStructuredMessageModel({
            ...base,
            descriptor: {
                ...descriptor,
                actions: [],
                payloadSchema: { const: nullPrototypePayload },
            },
            value: {
                kind: 'acme.build-result.v1',
                payload: { valueOf: null, rows: [{ score: 1.5 }] },
                resources: [],
            },
        });
        expect(exact.payload).toEqual({ valueOf: null, rows: [{ score: 1.5 }] });

        expectPluginError(() => createStablePluginStructuredMessageModel({
            ...base,
            descriptor: {
                ...descriptor,
                actions: [],
                payloadSchema: {
                    oneOf: [
                        { const: nullPrototypePayload },
                        { enum: [{ valueOf: null, rows: [{ score: 1.5 }] }] },
                    ],
                },
            },
            value: {
                kind: 'acme.build-result.v1',
                payload: nullPrototypePayload,
                resources: [],
            },
        }), 'plugin_structured_message_payload_invalid');

    });

    it('accepts the exact serialized payload limit and classifies limit-plus-one overflow', () => {
        const exactPayload = 'x'.repeat((1024 * 1024) - 2);
        const exact = createStablePluginStructuredMessageModel({
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            descriptor: {
                ...descriptor,
                payloadSchema: { type: 'string' },
                actions: [],
            },
            value: {
                kind: 'acme.build-result.v1',
                payload: exactPayload,
                resources: [],
            },
            actions: [],
            resources: [],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
        });
        expect(exact.payload).toBe(exactPayload);

        expectPluginError(() => createStablePluginStructuredMessageModel({
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            descriptor: {
                ...descriptor,
                payloadSchema: { type: 'string' },
                actions: [],
            },
            value: {
                kind: 'acme.build-result.v1',
                payload: 'x'.repeat((1024 * 1024) + 1),
                resources: [],
            },
            actions: [],
            resources: [],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
        }), 'plugin_structured_message_payload_bounded');
    });

    it('rejects malformed resource identities with a coded boundary error', () => {
        expectPluginError(() => createStablePluginStructuredMessageModel({
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            descriptor: { ...descriptor, actions: [] },
            value: {
                kind: 'acme.build-result.v1',
                payload: { status: 'passed' },
                resources: ['INVALID'],
            },
            actions: [],
            resources: [],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
        }), 'plugin_structured_message_resource_identity_invalid');
    });

    it('rejects extra structured-value envelope fields', () => {
        const valueWithExtraField = {
            kind: 'acme.build-result.v1',
            payload: { status: 'passed' },
            resources: [],
            executable: 'never',
        };
        expectPluginError(() => createStablePluginStructuredMessageModel({
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            descriptor: { ...descriptor, actions: [] },
            value: valueWithExtraField,
            actions: [],
            resources: [],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
        }), 'plugin_structured_message_value_invalid');
    });

    it('maps a malformed structured-value envelope to a coded model error', () => {
        expectPluginError(() => createStablePluginStructuredMessageModel({
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            descriptor: { ...descriptor, actions: [] },
            value: null as unknown as { kind: string; payload: null },
            actions: [],
            resources: [],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
        }), 'plugin_structured_message_value_invalid');
    });
});
