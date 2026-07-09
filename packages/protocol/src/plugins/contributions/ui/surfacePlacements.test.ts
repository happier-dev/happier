import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from '../v2.js';
import {
  PluginSurfacePlacementDescriptorV1Schema,
  PluginSurfacePlacementKindV1Schema,
} from './surfacePlacements.js';

const display = {
  titleKey: 'title',
  descriptionKey: 'description',
  iconToken: 'browser',
  tone: 'info',
} as const;

describe('plugin surface placement descriptors', () => {
  it('accepts the generic plugin placement vocabulary without routing through session-only descriptors', () => {
    expect(PluginSurfacePlacementKindV1Schema.options).toEqual([
      'session.details',
      'session.preview',
      'session.tool',
      'session.side',
      'session.rightSidebarTab',
      'workspace.details',
      'workspace.main',
      'project.details',
      'project.main',
      'project.rightSidebarTab',
      'app.settingsPage',
      'app.sidePanel',
      'app.bottomPanel',
      'app.rightSidebarTab',
      'browser.panel',
      'services.panel',
    ]);

    const parsed = PluginContributesV2Schema.parse({
      surfacePlacements: [{
        id: 'workspace-preview',
        placement: 'workspace.details',
        target: {
          kind: 'workspace',
          workspaceRefIdPath: '/workspace/refId',
          machineIdPath: '/machine/id',
          rootPathPath: '/workspace/rootPath',
        },
        renderer: {
          kind: 'hostedWeb',
          contributionId: 'preview-web',
          fallback: { kind: 'descriptor', descriptorId: 'workspace-preview-fallback' },
        },
        display,
        order: 10,
      }, {
        id: 'settings-panel',
        placement: 'app.settingsPage',
        target: { kind: 'app' },
        renderer: { kind: 'host', rendererId: 'settingsDescriptorPanel' },
        display,
      }, {
        id: 'browser-inspector',
        placement: 'browser.panel',
        target: {
          kind: 'browser',
          browserViewIdPath: '/browser/viewId',
          sessionIdPath: '/session/id',
          profileIdPath: '/browser/profileId',
        },
        renderer: { kind: 'host', rendererId: 'descriptorPanel' },
        hostActions: [{
          actionId: 'browser.automation.snapshot',
          placement: 'browser.panel',
          policyOwner: 'BRW-14',
          effect: 'readOnly',
          scope: {
            kind: 'browserView',
            browserViewIdPath: '/browser/viewId',
            sessionIdPath: '/session/id',
            profileIdPath: '/browser/profileId',
          },
          requiredFeatureIds: ['browser.shell'],
          requiredPermissionIds: [],
        }],
        display,
      }],
    });

    expect(parsed.surfacePlacements?.map((placement) => placement.placement)).toEqual([
      'workspace.details',
      'app.settingsPage',
      'browser.panel',
    ]);
    expect(parsed.surfacePlacements?.[0]?.renderer.kind).toBe('hostedWeb');
  });

  it('accepts right-sidebar tab and services panel placements with host-owned projection metadata', () => {
    const parsed = PluginContributesV2Schema.parse({
      surfacePlacements: [{
        id: 'session-review-tab',
        placement: 'session.rightSidebarTab',
        target: { kind: 'session', sessionIdPath: '/session/id' },
        renderer: { kind: 'hostedWeb', contributionId: 'review-web' },
        display: {
          titleKey: 'plugins.acme.review.title',
          developerFallback: 'Review',
          iconToken: 'preview',
        },
        rightSidebar: {
          tabId: 'review',
          scope: 'session',
          section: 'plugin',
          order: 25,
          mobile: { enabled: true, surface: 'pluginTab' },
          lifecycle: {
            retention: 'unmountOnDisable',
            unmountOnGenerationChange: true,
          },
          disabledPolicy: 'disable',
          collisionPolicy: 'reject',
        },
        order: 25,
      }, {
        id: 'project-review-tab',
        placement: 'project.rightSidebarTab',
        target: { kind: 'project', projectIdPath: '/project/id' },
        renderer: { kind: 'host', rendererId: 'projectReviewHost' },
        display,
        rightSidebar: {
          tabId: 'review',
          scope: 'project',
          section: 'plugin',
          order: 35,
          mobile: { enabled: false },
        },
      }, {
        id: 'service-inspector',
        placement: 'services.panel',
        target: {
          kind: 'services',
          machineIdPath: '/machine/id',
          serverIdPath: '/server/id',
          sessionIdPath: '/session/id',
        },
        renderer: { kind: 'host', rendererId: 'serviceInspector' },
        display,
        order: 5,
      }],
    });

    expect(parsed.surfacePlacements?.map((placement) => placement.placement)).toEqual([
      'session.rightSidebarTab',
      'project.rightSidebarTab',
      'services.panel',
    ]);
    expect(parsed.surfacePlacements?.[0]).toMatchObject({
      rightSidebar: {
        tabId: 'review',
        scope: 'session',
        mobile: { enabled: true, surface: 'pluginTab' },
        lifecycle: {
          retention: 'unmountOnDisable',
          unmountOnGenerationChange: true,
        },
        disabledPolicy: 'disable',
        collisionPolicy: 'reject',
      },
    });
  });

  it('accepts short executable renderer refs', () => {
    const parsedReactNative = PluginSurfacePlacementDescriptorV1Schema.parse({
      id: 'native-preview',
      placement: 'browser.panel',
      target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
      renderer: { kind: 'reactNative', contributionId: 'native-preview' },
      display,
    });
    expect(parsedReactNative.renderer.kind).toBe('reactNative');

    const parsedEmbeddedWeb = PluginSurfacePlacementDescriptorV1Schema.parse({
      id: 'embedded-preview',
      placement: 'browser.panel',
      target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
      renderer: { kind: 'embeddedWeb', contributionId: 'embedded-preview' },
      display,
    });
    expect(parsedEmbeddedWeb.renderer.kind).toBe('embeddedWeb');

  });

  it('rejects right-sidebar placements without matching tab metadata or target scope', () => {
    const missingMetadata = PluginSurfacePlacementDescriptorV1Schema.safeParse({
      id: 'missing-tab-metadata',
      placement: 'session.rightSidebarTab',
      target: { kind: 'session' },
      renderer: { kind: 'host', rendererId: 'review' },
      display,
    });
    expect(missingMetadata.success).toBe(false);
    if (!missingMetadata.success) {
      expect(missingMetadata.error.issues.map((issue) => issue.path.join('.'))).toContain('rightSidebar');
    }

    const mismatchedScope = PluginSurfacePlacementDescriptorV1Schema.safeParse({
      id: 'mismatched-tab-scope',
      placement: 'project.rightSidebarTab',
      target: { kind: 'session' },
      renderer: { kind: 'host', rendererId: 'review' },
      display,
      rightSidebar: {
        tabId: 'review',
        scope: 'session',
      },
    });
    expect(mismatchedScope.success).toBe(false);
    if (!mismatchedScope.success) {
      expect(mismatchedScope.error.issues.map((issue) => issue.path.join('.'))).toEqual(expect.arrayContaining([
        'rightSidebar.scope',
        'target',
      ]));
    }

    const servicesWithoutServicesTarget = PluginSurfacePlacementDescriptorV1Schema.safeParse({
      id: 'wrong-services-target',
      placement: 'services.panel',
      target: { kind: 'app' },
      renderer: { kind: 'host', rendererId: 'serviceInspector' },
      display,
    });
    expect(servicesWithoutServicesTarget.success).toBe(false);
    if (!servicesWithoutServicesTarget.success) {
      expect(servicesWithoutServicesTarget.error.issues.map((issue) => issue.path.join('.'))).toContain('target');
    }
  });

  it('rejects unknown placements, raw executable renderer fields, and browser-panel actions without scope attribution', () => {
    const result = PluginSurfacePlacementDescriptorV1Schema.safeParse({
      id: 'unsafe-browser-panel',
      placement: 'browser.panel',
      target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
      renderer: { kind: 'host', rendererId: 'descriptorPanel' },
      browserCommand: { kind: 'navigate' },
      hostActions: [{
        actionId: 'browser.automation.click',
        placement: 'browser.panel',
        policyOwner: 'BRW-14',
        effect: 'mutating',
        scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
      }],
      display,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issuePaths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(issuePaths).toContain('browserCommand');
    }

    const missingScopeResult = PluginSurfacePlacementDescriptorV1Schema.safeParse({
      id: 'missing-browser-scope',
      placement: 'browser.panel',
      target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
      renderer: { kind: 'host', rendererId: 'descriptorPanel' },
      hostActions: [{
        actionId: 'browser.raw.navigate',
        placement: 'browser.panel',
        policyOwner: 'BRW-14',
        effect: 'mutating',
      }],
      display,
    });
    expect(missingScopeResult.success).toBe(false);
    if (!missingScopeResult.success) {
      expect(missingScopeResult.error.issues.map((issue) => issue.path.join('.'))).toContain('hostActions.0.scope');
    }

    const rawRendererResult = PluginSurfacePlacementDescriptorV1Schema.safeParse({
      id: 'raw-renderer',
      placement: 'browser.panel',
      target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
      renderer: {
        kind: 'hostedWeb',
        contributionId: 'preview-web',
        url: 'https://plugin.example.test/panel',
      },
      display,
    });
    expect(rawRendererResult.success).toBe(false);
    if (!rawRendererResult.success) {
      expect(rawRendererResult.error.issues.map((issue) => issue.path.join('.'))).toContain('renderer');
    }

    expect(PluginSurfacePlacementDescriptorV1Schema.safeParse({
      id: 'bad-placement',
      placement: 'terminal.main',
      target: { kind: 'app' },
      renderer: { kind: 'host', rendererId: 'terminalPanel' },
      display,
    }).success).toBe(false);
  });

  it('requires browser-panel host actions to reference canonical runtime ActionSpec ids with matching policy metadata', () => {
    expect(PluginSurfacePlacementDescriptorV1Schema.parse({
      id: 'browser-automation-panel',
      placement: 'browser.panel',
      target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
      renderer: { kind: 'host', rendererId: 'descriptorPanel' },
      hostActions: [{
        actionId: 'browser.automation.snapshot',
        placement: 'browser.panel',
        policyOwner: 'BRW-14',
        effect: 'readOnly',
        scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
      }, {
        actionId: 'localServices.preview.status',
        placement: 'browser.panel',
        policyOwner: 'LSV',
        effect: 'readOnly',
        scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
      }, {
        actionId: 'peerMediation.observability.snapshot',
        placement: 'browser.panel',
        policyOwner: 'PMS',
        effect: 'diagnostic',
        scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
      }, {
        actionId: 'devices.simulator.stream.snapshot',
        placement: 'browser.panel',
        policyOwner: 'SIM-4',
        effect: 'readOnly',
        scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
      }],
      display,
    }).hostActions.map((action) => action.actionId)).toEqual([
      'browser.automation.snapshot',
      'localServices.preview.status',
      'peerMediation.observability.snapshot',
      'devices.simulator.stream.snapshot',
    ]);

    const result = PluginSurfacePlacementDescriptorV1Schema.safeParse({
      id: 'unsafe-action-refs',
      placement: 'browser.panel',
      target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
      renderer: { kind: 'host', rendererId: 'descriptorPanel' },
      hostActions: [{
        actionId: 'browser.raw.navigate',
        placement: 'browser.panel',
        policyOwner: 'BRW-14',
        effect: 'mutating',
        scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
      }, {
        actionId: 'daemon.browser.recording.start',
        placement: 'browser.panel',
        policyOwner: 'BRW-15',
        effect: 'recording',
        scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
      }, {
        actionId: 'browser.automation.click',
        placement: 'browser.panel',
        policyOwner: 'BRW-2',
        effect: 'mutating',
        scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
      }, {
        actionId: 'browser.automation.click',
        placement: 'browser.panel',
        policyOwner: 'BRW-14',
        effect: 'readOnly',
        scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
      }],
      display,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(expect.arrayContaining([
        'hostActions.0.actionId',
        'hostActions.1.actionId',
        'hostActions.2.policyOwner',
        'hostActions.3.effect',
      ]));
    }
  });

  it('rejects browser-panel host actions that claim weaker effects than canonical runtime ActionSpecs', () => {
    const downgradedHostActions = [{
      actionId: 'localServices.actions.stopManaged',
      placement: 'browser.panel',
      policyOwner: 'LSV',
      effect: 'mutating',
      scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
    }, {
      actionId: 'localServices.actions.restartManaged',
      placement: 'browser.panel',
      policyOwner: 'LSV',
      effect: 'mutating',
      scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
    }, {
      actionId: 'devices.simulator.input.tap',
      placement: 'browser.panel',
      policyOwner: 'SIM-4',
      effect: 'mutating',
      scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
    }, {
      actionId: 'localServices.publicPreview.create',
      placement: 'browser.panel',
      policyOwner: 'LSV',
      effect: 'externalNavigation',
      scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
    }, {
      actionId: 'localServices.publicPreview.revoke',
      placement: 'browser.panel',
      policyOwner: 'LSV',
      effect: 'externalNavigation',
      scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
    }, {
      actionId: 'localServices.publicPreview.copyUrl',
      placement: 'browser.panel',
      policyOwner: 'LSV',
      effect: 'externalNavigation',
      scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
    }] as const;

    for (const [index, hostAction] of downgradedHostActions.entries()) {
      const result = PluginSurfacePlacementDescriptorV1Schema.safeParse({
        id: `downgraded-host-action-${index}`,
        placement: 'browser.panel',
        target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
        renderer: { kind: 'host', rendererId: 'descriptorPanel' },
        hostActions: [hostAction],
        display,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('hostActions.0.effect');
      }
    }
  });
});
