import { describe, expect, it } from 'vitest';

import {
  PluginDeclarativeNodeV2Schema,
  PluginDeclarativeTargetedSurfaceNodeV2Schema,
  PluginDeclarativeStateV2Schema,
  PluginUiContributionsV2Schema,
  PluginUiRendererV2Schema,
  PluginUiViewV2Schema,
} from './v2.js';
import { PluginUiIconTokenV1Schema } from './tokens.js';
import { PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1 } from './declarativeDocument.js';

/**
 * The declarative vocabulary is a bounded host-rendered document language
 * (plan §3.11). These cases lock the approved list/section/item, state,
 * metadata and action-panel members and the strictness that keeps the language
 * from drifting into a general data-binding surface.
 */
describe('declarative node vocabulary v2', () => {
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
          immutableGenerationId: 'forged-generation',
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

  it('rejects unknown members, unbounded metadata and non-curated icons', () => {
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

  it('uses the canonical Collection-member grammar for declarative collection lists', () => {
    const collectionList = {
      kind: 'collectionList',
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
      groupHint: 'sessions',
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
        groupHint: 'sessions',
        rankHint: -25,
      });
    }
  });

  it('rejects arbitrary icon, group, rank, and unbounded badge input', () => {
    expect(PluginUiViewV2Schema.safeParse({
      ...appPage,
      icon: 'brand-logo.svg',
    }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({
      ...appPage,
      groupHint: 'permanent-bottom-bar',
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
