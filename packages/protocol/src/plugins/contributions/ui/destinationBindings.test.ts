import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import * as surfaceRegistry from './surfaceRegistry.js';
import * as tokens from './tokens.js';
import {
  matchesPluginUiDestinationBindingV1,
  normalizePluginUiDestinationBindingV1,
  normalizePluginUiSettingsPageBindingV1,
  PluginUiDestinationBindingV1Schema,
  selectPluginUiRendererChainMemberV1,
  selectPluginUiDestinationBindingRendererV1,
} from './surfaceRegistry.js';
import type { PluginUiDestinationBindingV1 } from './surfaceRegistry.js';
import {
  PluginUiContributionsV2Schema,
  PluginUiDestinationBadgeV1Schema,
  PluginUiRendererV2Schema,
  PluginUiViewV2Schema,
} from './v2.js';
import type { PluginUiViewV2Input } from './v2.js';
import type { PluginUiPageHeaderActionV1Input } from './sessionHeaderActions.js';
import { PluginSurfaceTargetV1Schema } from './surfaceTargets.js';

if (false) {
  const acceptedMultiplePane: PluginUiViewV2Input = {
    id: 'accepted-multiple-pane',
    renderer: 'compare-renderer',
    container: 'rightPane',
    target: { kind: 'session' },
    instancePolicy: 'multiple',
  };
  // @ts-expect-error right-sidebar tabs have no bounded instance-key launcher.
  const rejectedMultipleRightSidebar: PluginUiViewV2Input = {
    id: 'rejected-multiple-right-sidebar',
    renderer: 'compare-renderer',
    container: 'rightSidebarTab',
    target: { kind: 'session' },
    instancePolicy: 'multiple',
  };

  const pageHeaderActions: PluginUiPageHeaderActionV1Input[] = [{
    id: 'refresh',
    title: 'Refresh',
    action: { kind: 'executeAction', action: 'refresh-activity' },
  }];
  const acceptedAppPageHeaderActions: PluginUiViewV2Input = {
    id: 'accepted-app-page-header-actions',
    renderer: 'compare-renderer',
    container: 'appPage',
    target: { kind: 'app' },
    headerActions: pageHeaderActions,
  };
  // @ts-expect-error page header actions are an appPage container capability.
  const rejectedPaneHeaderActions: PluginUiViewV2Input = {
    id: 'rejected-pane-header-actions',
    renderer: 'compare-renderer',
    container: 'rightPane',
    target: { kind: 'session' },
    headerActions: pageHeaderActions,
  };
  const acceptedEmptyPaneHeaderActions: PluginUiViewV2Input = {
    id: 'accepted-empty-pane-header-actions',
    renderer: 'compare-renderer',
    container: 'rightPane',
    target: { kind: 'session' },
    headerActions: [],
  };

  void [
    acceptedMultiplePane,
    rejectedMultipleRightSidebar,
    acceptedAppPageHeaderActions,
    rejectedPaneHeaderActions,
    acceptedEmptyPaneHeaderActions,
  ];
}

/**
 * The declaration cases above are the ONLY statement of the representable
 * authoring grammar at the TypeScript layer, and the package `tsconfig.json`
 * excludes every `.test.ts` file — so no compiler read them and every
 * `@ts-expect-error` in this file was unfalsifiable. Typecheck the file here
 * instead: a directive that stops matching a real error reports TS2578, and a
 * grammar that stops rejecting an unadmitted declaration reports it too.
 */
function typeCheckThisFile(): readonly string[] {
  const configPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url));
  const sourcePath = fileURLToPath(new URL('./destinationBindings.test.ts', import.meta.url));
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (!parsed) throw new Error(`Unable to parse ${configPath}`);

  const program = ts.createProgram({
    rootNames: [sourcePath],
    options: {
      ...parsed.options,
      noEmit: true,
      declaration: false,
      declarationMap: false,
      composite: false,
      incremental: false,
      tsBuildInfoFile: undefined,
    },
    projectReferences: parsed.projectReferences,
  });
  const sourceFile = program.getSourceFile(sourcePath);
  if (!sourceFile) throw new Error(`Missing ${sourcePath}`);

  return [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ].map((diagnostic) => {
    const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return `${(position?.line ?? 0) + 1}: TS${diagnostic.code} ${
      ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    }`;
  });
}

describe('plugin UI destination declaration grammar', () => {
  it('rejects an unadmitted declaration at the TypeScript layer too', () => {
    expect(typeCheckThisFile()).toEqual([]);
  }, 180_000);
});

describe('plugin UI destination binding normalization', () => {
  it('closes retired generic display vocabulary while retaining static destination badges', () => {
    expect(tokens).not.toHaveProperty('PluginUiThemeRoleV1Schema');
    expect(tokens).not.toHaveProperty('PluginUiBadgeVariantV1Schema');
    expect(tokens).not.toHaveProperty('PluginUiBadgeDescriptorV1Schema');
    expect(tokens).not.toHaveProperty('PluginUiSizeTokenV1Schema');
    expect(tokens.PluginUiDisplayV1Schema.safeParse({
      titleKey: 'review.title',
      themeRole: 'surface',
    }).success).toBe(false);
    expect(PluginUiDestinationBadgeV1Schema.safeParse({
      label: { key: 'review.badge.preview', fallback: 'Preview' },
      tone: 'accent',
    }).success).toBe(true);
  });

  it('accepts only a registry-normalized binding at the projection boundary', () => {
    const binding = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.review',
      destinationId: 'review-details',
      rendererId: 'shared-renderer',
      container: 'detailsTab',
      target: { kind: 'session', sessionIdPath: '/session/id' },
    });
    const schema = (surfaceRegistry as typeof surfaceRegistry & Readonly<{
      PluginUiDestinationBindingV1Schema?: Readonly<{
        safeParse(input: unknown): Readonly<{ success: boolean }>;
      }>;
    }>).PluginUiDestinationBindingV1Schema;

    expect(binding).not.toBeNull();
    expect(schema?.safeParse(binding).success).toBe(true);
    expect(schema?.safeParse({ ...binding!, container: 'appPage' }).success).toBe(false);
    expect(binding).not.toHaveProperty('collisionDomain');
    expect(binding).not.toHaveProperty('collisionKey');
    expect(binding).not.toHaveProperty('methodCeiling');
    expect(schema?.safeParse({
      ...binding!,
      collisionDomain: { container: 'detailsTab', targetKind: 'session' },
    }).success).toBe(false);
    expect(schema?.safeParse({
      ...binding!,
      collisionKey: 'detailsTab\u0000session\u0000acme.review/review-details',
    }).success).toBe(false);
    expect(schema?.safeParse({
      ...binding!,
      platforms: ['desktop'],
    }).success).toBe(true);
    expect(schema?.safeParse({ ...binding!, platforms: ['ios'] }).success).toBe(false);
    expect(schema?.safeParse({ ...binding!, methodCeiling: ['context'] }).success).toBe(false);
    expect(schema?.safeParse({ ...binding!, platforms: ['desktop', 'desktop'] }).success).toBe(false);
    expect(schema?.safeParse({ ...binding!, platforms: [] }).success).toBe(false);
  });

  it('narrows a selector-matched unknown binding to the canonical destination contract', () => {
    const candidate: unknown = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.review',
      destinationId: 'review-details',
      rendererId: 'shared-renderer',
      container: 'detailsTab',
      target: { kind: 'session', sessionIdPath: '/session/id' },
    });

    if (!matchesPluginUiDestinationBindingV1(candidate, {
      container: 'detailsTab',
      targetKind: 'session',
      pluginId: 'acme.review',
      rendererId: 'shared-renderer',
    })) {
      throw new Error('fixture binding must match its exact selector');
    }

    const binding: PluginUiDestinationBindingV1 = candidate;
    expect(binding.destination).toEqual({ pluginId: 'acme.review', localId: 'review-details' });
  });

  it('keeps a non-prefixed Session binding as Session instead of falling back to App', () => {
    const binding = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.review',
      destinationId: 'review-details',
      rendererId: 'shared-renderer',
      container: 'detailsTab',
      target: { kind: 'session', sessionIdPath: '/session/id' },
      instancePolicy: 'singleton',
    });

    expect(binding).toMatchObject({
      container: 'detailsTab',
      targetKind: 'session',
      destination: { pluginId: 'acme.review', localId: 'review-details' },
      renderer: { pluginId: 'acme.review', localId: 'shared-renderer' },
    });
    expect(surfaceRegistry.resolvePluginUiDestinationBindingSlotV1(
      'detailsTab',
      'session',
    )?.collisionDomain).toEqual({
      container: 'detailsTab',
      targetKind: 'session',
    });
  });

  it('normalizes the ordered renderer chain and selects its first eligible renderer', () => {
    const binding = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.review',
      destinationId: 'review-details',
      rendererId: 'primary-renderer',
      fallbackRendererIds: ['fallback-renderer', 'final-renderer'],
      availableRendererIds: ['primary-renderer', 'fallback-renderer', 'final-renderer'],
      container: 'detailsTab',
      target: { kind: 'session', sessionIdPath: '/session/id' },
    });

    expect(binding?.rendererChain).toEqual([
      { pluginId: 'acme.review', localId: 'primary-renderer' },
      { pluginId: 'acme.review', localId: 'fallback-renderer' },
      { pluginId: 'acme.review', localId: 'final-renderer' },
    ]);
    // Eligibility is deliberately supplied out of declaration order. The
    // registry, rather than a projection consumer, owns chain ordering.
    expect(selectPluginUiDestinationBindingRendererV1(binding!, [
      'final-renderer',
      'fallback-renderer',
    ])).toMatchObject({
      renderer: { pluginId: 'acme.review', localId: 'fallback-renderer' },
    });
    expect(selectPluginUiDestinationBindingRendererV1(binding!, ['final-renderer'])).toMatchObject({
      renderer: { pluginId: 'acme.review', localId: 'final-renderer' },
    });
    expect(selectPluginUiDestinationBindingRendererV1(binding!, [])).toBeNull();
    expect(selectPluginUiDestinationBindingRendererV1(binding!, [
      'fallback-renderer',
      'fallback-renderer',
    ])).toBeNull();
    // Targeted Surfaces reuse this selector directly: physical consumers
    // receive a daemon-selected renderer and cannot independently choose a
    // later fallback from the admitted declaration chain.
    expect(selectPluginUiRendererChainMemberV1(binding!.rendererChain, [
      'final-renderer',
      'fallback-renderer',
    ])).toEqual({ pluginId: 'acme.review', localId: 'fallback-renderer' });
    expect(normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.review',
      destinationId: 'missing-renderer',
      rendererId: 'primary-renderer',
      fallbackRendererIds: ['missing-renderer'],
      availableRendererIds: ['primary-renderer'],
      container: 'detailsTab',
      target: { kind: 'session', sessionIdPath: '/session/id' },
    })).toBeNull();
  });

  it('rejects an unsupported container/target pair instead of coercing the target', () => {
    const binding = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.review',
      destinationId: 'wrong-target',
      rendererId: 'shared-renderer',
      container: 'appPage',
      target: { kind: 'project', projectIdPath: '/project/id' },
      instancePolicy: 'singleton',
    });

    expect(binding).toBeNull();
  });

  it('admits multiple only for registry slots with bounded instance-keyed pane or details hosts', () => {
    const normalizeMultiple = (container: string, target: unknown) => (
      normalizePluginUiDestinationBindingV1({
        pluginId: 'acme.review',
        destinationId: 'compare-reviews',
        rendererId: 'compare-renderer',
        container,
        target,
        instancePolicy: 'multiple',
      })
    );
    const parseMultipleView = (container: string, target: unknown) => (
      PluginUiViewV2Schema.safeParse({
        id: 'compare-reviews',
        renderer: 'compare-renderer',
        container,
        target,
        instancePolicy: 'multiple',
      }).success
    );

    for (const { container, target } of [
      { container: 'appPage', target: { kind: 'app' } },
      { container: 'rightSidebarTab', target: { kind: 'app' } },
      { container: 'rightSidebarTab', target: { kind: 'session', sessionIdPath: '/session/id' } },
      { container: 'rightSidebarTab', target: { kind: 'project', projectIdPath: '/project/id' } },
      { container: 'browserPanel', target: { kind: 'browser', browserViewIdPath: '/browser/id' } },
      { container: 'servicesPanel', target: { kind: 'services' } },
    ]) {
      expect(parseMultipleView(container, target)).toBe(false);
      expect(normalizeMultiple(container, target)).toBeNull();
    }

    for (const { container, target } of [
      { container: 'rightPane', target: { kind: 'session', sessionIdPath: '/session/id' } },
      { container: 'rightPane', target: { kind: 'project', projectIdPath: '/project/id' } },
      { container: 'detailsTab', target: { kind: 'session', sessionIdPath: '/session/id' } },
      { container: 'detailsTab', target: { kind: 'project', projectIdPath: '/project/id' } },
      { container: 'detailsPane', target: { kind: 'session', sessionIdPath: '/session/id' } },
      { container: 'detailsPane', target: { kind: 'project', projectIdPath: '/project/id' } },
      { container: 'bottomPane', target: { kind: 'session', sessionIdPath: '/session/id' } },
      { container: 'bottomPane', target: { kind: 'project', projectIdPath: '/project/id' } },
    ]) {
      expect(parseMultipleView(container, target)).toBe(true);
      expect(normalizeMultiple(container, target)).not.toBeNull();
    }

    const singletonSidebar = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.review',
      destinationId: 'sidebar-review',
      rendererId: 'compare-renderer',
      container: 'rightSidebarTab',
      target: { kind: 'session', sessionIdPath: '/session/id' },
    });
    const settings = normalizePluginUiSettingsPageBindingV1({
      pluginId: 'acme.review',
      pageId: 'review-settings',
      rendererId: 'compare-renderer',
    });

    expect(PluginUiDestinationBindingV1Schema.safeParse({
      ...singletonSidebar!,
      instancePolicy: 'multiple',
    }).success).toBe(false);
    expect(PluginUiDestinationBindingV1Schema.safeParse({
      ...settings!,
      instancePolicy: 'multiple',
    }).success).toBe(false);
  });

  it('allows one renderer to back separate admitted bindings without merging their targets', () => {
    const session = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.review',
      destinationId: 'session-review',
      rendererId: 'shared-renderer',
      container: 'rightSidebarTab',
      target: { kind: 'session', sessionIdPath: '/session/id' },
      instancePolicy: 'singleton',
    });
    const project = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.review',
      destinationId: 'project-review',
      rendererId: 'shared-renderer',
      container: 'rightSidebarTab',
      target: { kind: 'project', projectIdPath: '/project/id' },
      instancePolicy: 'singleton',
    });

    expect(session?.renderer).toEqual(project?.renderer);
    expect(session?.targetKind).toBe('session');
    expect(project?.targetKind).toBe('project');
    expect(session?.target).toEqual({ kind: 'session', sessionIdPath: '/session/id' });
    expect(project?.target).toEqual({ kind: 'project', projectIdPath: '/project/id' });
  });

  it('normalizes a Settings page through the fixed app target instead of a Settings-local target rule', () => {
    expect(normalizePluginUiSettingsPageBindingV1({
      pluginId: 'acme.review',
      pageId: 'review-settings',
      rendererId: 'shared-renderer',
    })).toMatchObject({
      container: 'settingsPage',
      target: { kind: 'app' },
      targetKind: 'app',
      destination: { pluginId: 'acme.review', localId: 'review-settings' },
    });
  });

  it('classifies browser and services bindings without reviving a legacy placement id', () => {
    const browser = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.browser',
      destinationId: 'inspector',
      rendererId: 'browser-hosted',
      container: 'browserPanel',
      target: { kind: 'browser', browserViewIdPath: '/browser/id' },
    });
    const services = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.services',
      destinationId: 'health',
      rendererId: 'services-hosted',
      container: 'servicesPanel',
      target: { kind: 'services' },
    });

    expect(browser).toMatchObject({
      container: 'browserPanel',
      targetKind: 'browser',
      surfaceContextPlacement: 'browserSurface',
    });
    expect(services).toMatchObject({
      container: 'servicesPanel',
      targetKind: 'services',
      surfaceContextPlacement: 'servicesSurface',
    });
    expect(browser && matchesPluginUiDestinationBindingV1(browser, {
      container: 'browserPanel',
      targetKind: 'browser',
      pluginId: 'acme.browser',
      rendererId: 'browser-hosted',
    })).toBe(true);
    expect(browser && matchesPluginUiDestinationBindingV1(browser, {
      container: 'browserPanel',
      targetKind: 'browser',
      pluginId: 'acme.other',
      rendererId: 'browser-hosted',
    })).toBe(false);
    expect(browser && matchesPluginUiDestinationBindingV1(browser, {
      container: 'servicesPanel',
      targetKind: 'services',
      pluginId: 'acme.browser',
      rendererId: 'browser-hosted',
    })).toBe(false);
  });

  it('admits desktop/tablet pane bindings only at the observed tablet form factor', () => {
    const desktopPane = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.review',
      destinationId: 'session-review',
      rendererId: 'review-renderer',
      container: 'rightPane',
      target: { kind: 'session' },
    });
    const detailsPane = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.review',
      destinationId: 'session-details',
      rendererId: 'review-renderer',
      container: 'detailsPane',
      target: { kind: 'session' },
    });
    const bottomPane = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.review',
      destinationId: 'session-bottom',
      rendererId: 'review-renderer',
      container: 'bottomPane',
      target: { kind: 'session' },
    });
    const sessionSidebar = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.review',
      destinationId: 'session-sidebar',
      rendererId: 'review-renderer',
      container: 'rightSidebarTab',
      target: { kind: 'session' },
    });
    const browser = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.browser',
      destinationId: 'inspector',
      rendererId: 'browser-hosted',
      container: 'browserPanel',
      target: { kind: 'browser', browserViewIdPath: '/browser/id' },
    });
    const services = normalizePluginUiDestinationBindingV1({
      pluginId: 'acme.services',
      destinationId: 'health',
      rendererId: 'services-hosted',
      container: 'servicesPanel',
      target: { kind: 'services' },
    });
    const registryAdmission = surfaceRegistry as typeof surfaceRegistry & Readonly<{
      isPluginUiDestinationBindingPotentiallySupportedOnPlatformV1?: (
        binding: NonNullable<typeof desktopPane>,
        platform: 'android' | 'desktop' | 'ios' | 'web',
      ) => boolean;
      isPluginUiDestinationBindingAdmittedAtRuntimeV1?: (input: Readonly<{
        binding: NonNullable<typeof desktopPane>;
        platform: 'android' | 'desktop' | 'ios' | 'web';
        formFactor: 'phone' | 'tablet';
      }>) => boolean;
    }>;

    expect(desktopPane).not.toBeNull();
    expect(detailsPane).not.toBeNull();
    expect(bottomPane).not.toBeNull();
    expect(sessionSidebar).not.toBeNull();
    expect(browser).not.toBeNull();
    expect(services).not.toBeNull();
    expect(registryAdmission.isPluginUiDestinationBindingPotentiallySupportedOnPlatformV1)
      .toBeTypeOf('function');
    expect(registryAdmission.isPluginUiDestinationBindingAdmittedAtRuntimeV1)
      .toBeTypeOf('function');
    expect(registryAdmission.isPluginUiDestinationBindingPotentiallySupportedOnPlatformV1?.(desktopPane!, 'ios'))
      .toBe(true);
    for (const paneBinding of [desktopPane, detailsPane, bottomPane]) {
      if (!paneBinding) continue;
      expect(registryAdmission.isPluginUiDestinationBindingAdmittedAtRuntimeV1?.({
        binding: paneBinding,
        platform: 'web',
        formFactor: 'tablet',
      })).toBe(true);
      expect(registryAdmission.isPluginUiDestinationBindingAdmittedAtRuntimeV1?.({
        binding: paneBinding,
        platform: 'web',
        formFactor: 'phone',
      })).toBe(false);
      expect(registryAdmission.isPluginUiDestinationBindingAdmittedAtRuntimeV1?.({
        binding: paneBinding,
        platform: 'ios',
        formFactor: 'tablet',
      })).toBe(true);
      expect(registryAdmission.isPluginUiDestinationBindingAdmittedAtRuntimeV1?.({
        binding: paneBinding,
        platform: 'ios',
        formFactor: 'phone',
      })).toBe(false);
    }
    expect(registryAdmission.isPluginUiDestinationBindingAdmittedAtRuntimeV1?.({
      binding: sessionSidebar!,
      platform: 'android',
      formFactor: 'phone',
    })).toBe(true);
    expect(browser?.platforms).toEqual(expect.arrayContaining(['ios', 'android']));
    expect(services?.platforms).toEqual(expect.arrayContaining(['ios', 'android']));
  });

});

describe('V2 destination declarations', () => {
  const sessionView = {
    id: 'review-details',
    container: 'detailsTab',
    target: { kind: 'session', sessionIdPath: '/session/id' },
    renderer: 'shared-renderer',
  } as const;

  it('accepts the registry-owned container and target declaration, not a placement id', () => {
    expect(PluginUiViewV2Schema.safeParse(sessionView).success).toBe(true);
    expect(PluginUiViewV2Schema.safeParse({
      ...sessionView,
      placement: 'session.details',
    }).success).toBe(false);
  });

  it('does not retain workspace as a public plugin surface target', () => {
    expect(PluginSurfaceTargetV1Schema.safeParse({
      kind: 'workspace',
      workspaceRefIdPath: '/workspace/id',
    }).success).toBe(false);
  });

  it('rejects a declared unsupported target/container cross-product', () => {
    expect(PluginUiViewV2Schema.safeParse({
      ...sessionView,
      container: 'appPage',
      target: { kind: 'project', projectIdPath: '/project/id' },
    }).success).toBe(false);
  });

  it('rejects a renderer fallback chain that re-enters, repeats, or references an absent renderer', () => {
    const primary = {
      id: 'primary-renderer',
      kind: 'declarative',
      root: { kind: 'text', text: 'Primary' },
    } as const;
    const fallback = {
      id: 'fallback-renderer',
      kind: 'declarative',
      root: { kind: 'text', text: 'Fallback' },
    } as const;

    expect(PluginUiViewV2Schema.safeParse({
      ...sessionView,
      renderer: 'primary-renderer',
      fallbackRenderers: ['primary-renderer'],
    }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({
      ...sessionView,
      renderer: 'primary-renderer',
      fallbackRenderers: ['fallback-renderer', 'fallback-renderer'],
    }).success).toBe(false);
    // The contribution schema owns fallback-chain shape, not cross-family
    // reference classification. Manifest ingestion resolves this id through
    // the contribution catalog and reports dangling/wrong-family precisely.
    expect(PluginUiContributionsV2Schema.safeParse({
      renderers: [primary, fallback],
      views: [{
        ...sessionView,
        renderer: 'primary-renderer',
        fallbackRenderers: ['missing-renderer'],
      }],
    }).success).toBe(true);
    expect(PluginUiContributionsV2Schema.safeParse({
      renderers: [primary, fallback],
      views: [{
        ...sessionView,
        renderer: 'primary-renderer',
        fallbackRenderers: ['fallback-renderer'],
      }],
    }).success).toBe(true);
  });

  it('keeps requiredHostMethods executable-only and retires remote hosted-web URLs', () => {
    expect(PluginUiRendererV2Schema.safeParse({
      id: 'declarative',
      kind: 'declarative',
      root: { kind: 'text', text: 'Review' },
      requiredHostMethods: ['openSurface'],
    }).success).toBe(false);
    expect(PluginUiRendererV2Schema.safeParse({
      id: 'native',
      kind: 'reactNative',
      artifact: 'review-native',
      requiredHostMethods: ['openSurface'],
    }).success).toBe(true);
    expect(PluginUiRendererV2Schema.safeParse({
      id: 'hosted',
      kind: 'hostedWeb',
      source: {
        kind: 'url',
        url: 'https://example.test/plugin',
        allowedOrigins: ['https://example.test'],
      },
    }).success).toBe(false);
  });
});
