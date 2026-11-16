/** Pure projection rendering; filesystem, preparation and publication stay in the generator. */
import { collectBundledAgentContributionIdentities } from './agentFacts.ts';
import { readDeclaredAgentTitle } from '../../../../../packages/agents/src/declaredAgentTitle.ts';
import {
  readProviderOwnedEnvironmentKeys,
  readPermissionModeMapping,
  renderBundledPluginPresentationTs,
  renderBundledAgentDeclarationsTs,
  renderBundledAccountProviderDeclarationsTs,
  renderBundledAccountConnectedServiceDeclarationsTs,
  renderBundledMachineProvisionerDeclarationsTs,
  renderBundledUiDeclarationImportsTs,
  renderBundledAgentDeclarationTypeTs,
} from './uiDeclarations.ts';
export {
  renderBundledAccountProviderDeclarationsTs,
  renderBundledAccountConnectedServiceDeclarationsTs,
  renderBundledMachineProvisionerDeclarationsTs,
} from './uiDeclarations.ts';
import {
  readJsonArrayProperty,
  readJsonObjectProperty,
  readManifestContributionArray,
  readOptionalJsonStringProperty,
  readRequiredRecord,
  readRequiredString,
  renderJsonLiteral,
  renderTsNullableStringLiteral,
  renderTsStringArrayLiteral,
  renderTsStringLiteral,
} from './literals.ts';
import type {
  AgentSessionBehaviorSource,
  AgentUiBehaviorDescriptorSource,
  AgentUiDescriptor,
  BundledPluginPackage,
  DescriptorAgentUiProjectionSource,
  DescriptorGeneratedSvgIconPathSource,
  DescriptorGeneratedSvgIconSource,
  JsonObject,
  SessionSubagentVisibleMessageResolverSource,
} from './projectionFacts.ts';

const AGENT_UI_PROJECTION_ORDER = Object.freeze([
  'claude',
  'codex',
  'cursor',
  'opencode',
  'antigravity',
  'gemini',
  'grok',
  'auggie',
  'qwen',
  'kimi',
  'kilo',
  'kiro',
  'devin',
  'fx',
  'droid',
  'codebuddy',
  'pi',
  'ohMyPi',
  'copilot',
  'coderabbit',
  'deepsec',
]);

export function toAgentConstPrefix(agentId: string): string {
  return agentId
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function renderAgentLogoSvgXmlExpression(svgIconKey: string | null): string {
  if (!svgIconKey) return 'null';
  if (/^[A-Za-z_$][\w$]*$/.test(svgIconKey)) {
    return `AGENT_LOGO_SVG_XML.${svgIconKey} ?? null`;
  }
  return `AGENT_LOGO_SVG_XML[${renderTsStringLiteral(svgIconKey)}] ?? null`;
}

function renderThemeColorExpression(token: string): string {
  return `theme.colors.${token}`;
}

function renderDescriptorGeneratedSvgPath(path: DescriptorGeneratedSvgIconPathSource): string {
  const attributes = [
    ...(path.fillToken === undefined ? [] : [`fill="\${${renderThemeColorExpression(path.fillToken)}}"`]),
    ...(path.fillOpacity === undefined ? [] : [`fill-opacity="${String(path.fillOpacity)}"`]),
    ...(path.fillRule === undefined ? [] : [`fill-rule="${path.fillRule}"`]),
    ...(path.clipRule === undefined ? [] : [`clip-rule="${path.clipRule}"`]),
    `d="${path.d}"`,
  ];
  return `<path ${attributes.join(' ')}/>`;
}

export function renderDescriptorGeneratedSvgIconLines(source: DescriptorGeneratedSvgIconSource): readonly string[] {
  const lines: string[] = [];
  lines.push(`const ${source.constName}: AgentIconSvgXmlResolver = (theme): string => createGeneratedSvgIconXml(`);
  lines.push(`    ${renderTsStringLiteral(source.viewBox)},`);
  lines.push('    `');
  for (const path of source.paths) {
    lines.push(`        ${renderDescriptorGeneratedSvgPath(path)}`);
  }
  lines.push('    `,');
  lines.push(');');
  return lines;
}

export function hasDescriptorFields(value: JsonObject | undefined): value is JsonObject {
  return value !== undefined && Object.keys(value).length > 0;
}

function readDescriptorString(value: JsonObject | undefined, key: string): string | null {
  const property = value?.[key];
  return typeof property === 'string' && property.trim().length > 0 ? property : null;
}

function assertSafeSvgAttributeValue(value: string, path: string): void {
  if (
    value.trim().length === 0
    || /["`<>]/u.test(value)
    || value.includes('${')
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Invalid agent UI descriptor at ${path}: expected safe SVG attribute text`);
  }
}

function readSvgRule(value: unknown, path: string): 'evenodd' | 'nonzero' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'evenodd' && value !== 'nonzero') {
    throw new Error(`Invalid agent UI descriptor at ${path}: expected evenodd or nonzero`);
  }
  return value;
}

function readOptionalFillOpacity(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid agent UI descriptor at ${path}: expected finite number between 0 and 1`);
  }
  return value;
}

function readSvgThemeToken(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(value)) {
    throw new Error(`Invalid agent UI descriptor at ${path}: expected theme token path`);
  }
  return value;
}

export function readDescriptorGeneratedSvgIcon(
  descriptor: AgentUiDescriptor,
  constPrefix: string,
): DescriptorGeneratedSvgIconSource | undefined {
  const svgIcon = readJsonObjectProperty(descriptor.assets ?? {}, 'svgIcon');
  if (!svgIcon) return undefined;

  const viewBox = readOptionalJsonStringProperty(svgIcon, 'viewBox') ?? undefined;
  const pathValues = readJsonArrayProperty(svgIcon, 'paths');
  if (viewBox === undefined && pathValues.length === 0) return undefined;
  if (viewBox === undefined || pathValues.length === 0) {
    throw new Error(
      `Invalid agent UI descriptor at assets.svgIcon for ${descriptor.agentId}: viewBox and paths must be provided together`,
    );
  }
  assertSafeSvgAttributeValue(viewBox, `${descriptor.agentId}.assets.svgIcon.viewBox`);

  return {
    constName: `${constPrefix}_SVG_ICON_XML`,
    viewBox,
    paths: pathValues.map((entry, index) => {
      const path = readRequiredRecord(entry, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}]`);
      const d = readRequiredString(path, 'd', `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}]`);
      assertSafeSvgAttributeValue(d, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].d`);
      return {
        d,
        ...(readSvgThemeToken(path.fillToken, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillToken`) === undefined
          ? {}
          : {
            fillToken: readSvgThemeToken(
              path.fillToken,
              `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillToken`,
            ),
          }),
        ...(readOptionalFillOpacity(path.fillOpacity, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillOpacity`) === undefined
          ? {}
          : {
            fillOpacity: readOptionalFillOpacity(
              path.fillOpacity,
              `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillOpacity`,
            ),
          }),
        ...(readSvgRule(path.fillRule, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillRule`) === undefined
          ? {}
          : { fillRule: readSvgRule(path.fillRule, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillRule`) }),
        ...(readSvgRule(path.clipRule, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].clipRule`) === undefined
          ? {}
          : { clipRule: readSvgRule(path.clipRule, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].clipRule`) }),
      };
    }),
  };
}

export function buildVisibleMessageDescriptor(descriptor: AgentUiDescriptor): JsonObject | undefined {
  const visibleMessages = readJsonObjectProperty(descriptor.session ?? {}, 'visibleMessages');
  return hasDescriptorFields(visibleMessages ?? undefined) ? visibleMessages ?? undefined : undefined;
}

function createDescriptorAgentUiProjectionSource(
  pluginPackage: BundledPluginPackage,
  descriptor: AgentUiDescriptor,
): DescriptorAgentUiProjectionSource {
  const constPrefix = toAgentConstPrefix(descriptor.agentId);
  const permissionModeMapping = readPermissionModeMapping(pluginPackage, descriptor.agentId);
  return {
    agentId: descriptor.agentId,
    coreConst: `${constPrefix}_CORE`,
    uiConst: `${constPrefix}_UI`,
    descriptor,
    providerOwnedEnvironmentKeys: readProviderOwnedEnvironmentKeys(pluginPackage, descriptor.agentId),
    ...(permissionModeMapping === undefined ? {} : { permissionModeMapping }),
  };
}

function renderDescriptorGeneratedUiProjectionLines(source: DescriptorAgentUiProjectionSource): readonly string[] {
  const { descriptor } = source;
  const agentId = renderTsStringLiteral(descriptor.agentId);
  const svgIconXmlExpression = renderAgentLogoSvgXmlExpression(descriptor.agentId);
  const lines: string[] = [];
  lines.push(`const ${source.coreConst}: AgentCoreConfig = {`);
  lines.push(`    id: ${agentId},`);
  lines.push(`    nativeSandbox: getSharedAgentCore(${agentId})?.nativeSandbox,`);
  lines.push(`    displayNameKey: ${renderTsStringLiteral(descriptor.display.nameKey)},`);
  lines.push(`    subtitleKey: ${renderTsStringLiteral(descriptor.display.subtitleKey)},`);
  lines.push(`    permissionModeI18nPrefix: ${renderTsStringLiteral(descriptor.display.permissionModeI18nPrefix)},`);
  lines.push(`    availability: { experimental: ${String(descriptor.display.availability.experimental)} },`);
  lines.push(`    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: ${agentId} }),`);
  lines.push(
    `    uiConnectedService: { serviceId: ${renderTsNullableStringLiteral(descriptor.display.connectedService.serviceId)}, labelKey: ${renderTsStringLiteral(descriptor.display.connectedService.labelKey)}, connectRoute: ${renderTsNullableStringLiteral(descriptor.display.connectedService.connectRoute)} },`,
  );
  lines.push(`    flavorAliases: ${renderTsStringArrayLiteral(descriptor.display.flavorAliases)},`);
  lines.push(`    providerOwnedEnvironmentKeys: ${renderTsStringArrayLiteral(source.providerOwnedEnvironmentKeys)},`);
  lines.push(`    cli: buildCatalogAgentCliUiConfig(${agentId}),`);
  lines.push('    permissions: {');
  lines.push(`        promptProtocol: ${renderTsStringLiteral(descriptor.display.permissions.promptProtocol)},`);
  lines.push('    },');
  lines.push('    sessionModes: {');
  lines.push(`        kind: getAgentSessionModesKind(${agentId}),`);
  const staticOptions = descriptor.display.sessionModes?.staticOptions;
  if (staticOptions && staticOptions.length > 0) {
    lines.push('        staticOptions: [');
    for (const option of staticOptions) {
      const fields = [
        `id: ${renderTsStringLiteral(option.id)}`,
        `nameKey: ${renderTsStringLiteral(option.nameKey)}`,
        ...(option.descriptionKey === undefined
          ? []
          : [`descriptionKey: ${renderTsStringLiteral(option.descriptionKey)}`]),
      ];
      lines.push(`            { ${fields.join(', ')} },`);
    }
    lines.push('        ],');
  }
  lines.push('    },');
  if (descriptor.display.runtimeInput) {
    lines.push('    runtimeInput: {');
    lines.push(`        inFlightSteerSupported: ${String(descriptor.display.runtimeInput.inFlightSteerSupported)},`);
    lines.push('    },');
  }
  lines.push(`    model: getAgentModelConfig(${agentId}),`);
  lines.push('    resume: buildAgentResumeUiConfig({');
  lines.push(`        agentId: ${agentId},`);
  lines.push(`        uiVendorResumeIdLabelKey: ${renderTsNullableStringLiteral(descriptor.display.resume.uiVendorResumeIdLabelKey)},`);
  lines.push(`        uiVendorResumeIdCopiedKey: ${renderTsNullableStringLiteral(descriptor.display.resume.uiVendorResumeIdCopiedKey)},`);
  lines.push('    }),');
  if (descriptor.display.localControl === true) {
    lines.push(`    localControl: buildAgentLocalControlUiConfig({ agentId: ${agentId} }),`);
  }
  lines.push('    toolRendering: {');
  lines.push(`        hideUnknownToolsByDefault: ${String(descriptor.display.toolRendering.hideUnknownToolsByDefault)},`);
  lines.push('    },');
  lines.push(`    tools: buildAgentToolsUiConfig({ agentId: ${agentId} }),`);
  lines.push(`    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: ${agentId} }),`);
  lines.push('    ui: {');
  lines.push(`        agentPickerIconName: ${renderTsStringLiteral(descriptor.display.picker.iconName)},`);
  lines.push(`        cliGlyphScale: ${String(descriptor.display.picker.cliGlyphScale)},`);
  lines.push(`        profileCompatibilityGlyphScale: ${String(descriptor.display.picker.profileCompatibilityGlyphScale)},`);
  lines.push('    },');
  lines.push('};');
  lines.push('');
  lines.push(`const ${source.uiConst}: AgentUiConfig = {`);
  lines.push(`    id: ${agentId},`);
  lines.push('    icon: null,');
  if (descriptor.identityColor) {
    lines.push(`    identityColor: readBundledAgentPresentation(${agentId})?.identityColor ?? undefined,`);
  }
  lines.push(`    svgIconXml: ${svgIconXmlExpression},`);
  if (typeof descriptor.display.picker.iconScale === 'number') {
    lines.push(`    pickerIconScale: ${String(descriptor.display.picker.iconScale)},`);
  }
  lines.push('    tintColor: null,');
  lines.push('    avatarOverlay: {');
  lines.push(`        circleScale: ${String(descriptor.display.avatarOverlay.circleScale)},`);
  lines.push(`        iconScale: ({ size }: { size: number }) => Math.round(size * ${String(descriptor.display.avatarOverlay.iconScaleRatio)}),`);
  lines.push('    },');
  lines.push(`    cliGlyph: ${renderTsStringLiteral(descriptor.display.picker.cliGlyph)},`);
  lines.push('};');
  return lines;
}

export function renderUiBundledPluginEntriesTs(params: Readonly<{
  packageNames: readonly string[];
  pluginPackages: readonly BundledPluginPackage[];
}>): string {
  const descriptorSourcesByAgentId = new Map(
    params.pluginPackages
      .flatMap((entry) => (entry.agentUiDescriptor ? [createDescriptorAgentUiProjectionSource(entry, entry.agentUiDescriptor)] : []))
      .map((source) => [source.agentId, source] as const),
  );
  const uiProjectionOrder = [...AGENT_UI_PROJECTION_ORDER];
  const orderedAgentIds = new Set(uiProjectionOrder);
  for (const agentId of descriptorSourcesByAgentId.keys()) {
    if (orderedAgentIds.has(agentId)) continue;
    uiProjectionOrder.push(agentId);
    orderedAgentIds.add(agentId);
  }
  const bundledAgentIds = new Set(
    params.pluginPackages.flatMap((entry) => (entry.agentId ? [entry.agentId] : [])),
  );
  const selectedProjectionSources = uiProjectionOrder.flatMap((agentId) => {
    if (!bundledAgentIds.has(agentId)) return [];
    const descriptorSource = descriptorSourcesByAgentId.get(agentId);
    if (!descriptorSource) return [];
    let projectionLines = renderDescriptorGeneratedUiProjectionLines(descriptorSource);
    const permissionModeMapping = descriptorSource.permissionModeMapping;
    if (permissionModeMapping !== undefined) {
      const insertionIndex = projectionLines.findIndex((line) => line.trimStart().startsWith('promptProtocol:'));
      if (insertionIndex < 0) throw new Error(`Generated UI projection '${agentId}' has no permissions insertion anchor`);
      projectionLines = [
        ...projectionLines.slice(0, insertionIndex + 1),
        `        permissionModeMapping: ${renderJsonLiteral(permissionModeMapping)},`,
        ...projectionLines.slice(insertionIndex + 1),
      ];
    }
    return [{
      agentId,
      coreConst: descriptorSource.coreConst,
      uiConst: descriptorSource.uiConst,
      projectionLines,
    }];
  });
  const selectedProjectionSourcesByAgentId = new Map(
    selectedProjectionSources.map((source) => [source.agentId, source] as const),
  );
  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is the UI-side generated bundled entry map for first-party bundled plugins.');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * UI facts here are descriptor-derived and no-execute; this file must not import plugin UI runtime exports.');
  lines.push(' */');
  lines.push('');
  lines.push('import type { AgentCoreConfig, CanonicalAgentId } from \'./registryCore\';');
  lines.push(renderBundledUiDeclarationImportsTs());
  lines.push('import type { AgentUiConfig } from \'./registryUi\';');
  lines.push('import { AGENT_LOGO_SVG_XML } from \'./agentLogoSvgXml\';');
  lines.push('');
  lines.push('import { buildCatalogAgentCliUiConfig } from \'@/agents/registry/buildCatalogAgentCliUiConfig\';');
  lines.push('import { buildAgentConnectedServicesUiConfig } from \'@/agents/registry/buildAgentConnectedServicesUiConfig\';');
  lines.push('import { buildAgentLocalControlUiConfig } from \'@/agents/registry/buildAgentLocalControlUiConfig\';');
  lines.push('import { buildAgentResumeUiConfig } from \'@/agents/registry/buildAgentResumeUiConfig\';');
  lines.push('import { buildAgentSessionStorageUiConfig } from \'@/agents/registry/buildAgentSessionStorageUiConfig\';');
  lines.push('import { buildAgentToolsUiConfig } from \'@/agents/registry/buildAgentToolsUiConfig\';');
  lines.push('import { getAgentCore as getSharedAgentCore, getAgentModelConfig, getAgentSessionModesKind } from \'@happier-dev/agents\';');
  lines.push('import { readBundledAgentPresentation } from \'@happier-dev/agents/presentation\';');
  lines.push('');
  for (const source of selectedProjectionSources) {
    lines.push(...source.projectionLines);
    lines.push('');
  }
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([');
  for (const packageName of params.packageNames) {
    lines.push(`  ${JSON.stringify(packageName)},`);
  }
  lines.push(']);');
  lines.push('');
  lines.push('/** First-party manifest presentation only; no installation or execution authority. */');
  lines.push(renderBundledPluginPresentationTs(params.pluginPackages));
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENTS_CORE: Readonly<Partial<Record<CanonicalAgentId, AgentCoreConfig>>> = Object.freeze({');
  for (const agentId of uiProjectionOrder) {
    const valueName = selectedProjectionSourcesByAgentId.get(agentId)?.coreConst;
    if (!valueName) {
      if (!bundledAgentIds.has(agentId)) continue;
      throw new Error(`Missing UI core projection source for ${agentId}`);
    }
    lines.push(`    ${renderTsStringLiteral(agentId)}: ${valueName},`);
  }
  lines.push('} satisfies Readonly<Partial<Record<CanonicalAgentId, AgentCoreConfig>>>);');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENTS_UI: Readonly<Partial<Record<CanonicalAgentId, AgentUiConfig>>> = Object.freeze({');
  for (const agentId of uiProjectionOrder) {
    const valueName = selectedProjectionSourcesByAgentId.get(agentId)?.uiConst;
    if (!valueName) {
      if (!bundledAgentIds.has(agentId)) continue;
      throw new Error(`Missing UI projection source for ${agentId}`);
    }
    lines.push(`    ${renderTsStringLiteral(agentId)}: ${valueName},`);
  }
  lines.push('} satisfies Readonly<Partial<Record<CanonicalAgentId, AgentUiConfig>>>);');
  lines.push('');
  lines.push('/** Admitted bundled declarations only; no installed version, runtime generation or activation authority. */');
  lines.push(renderBundledAgentDeclarationTypeTs());
  lines.push(renderBundledAgentDeclarationsTs(params.pluginPackages));
  lines.push('');
  lines.push('/** Provider declarations from the same admitted bundled manifests; no activation or Machine facts. */');
  lines.push(renderBundledAccountProviderDeclarationsTs(params.pluginPackages));
  lines.push('');
  lines.push(renderBundledAccountConnectedServiceDeclarationsTs(params.pluginPackages));
  lines.push('');
  lines.push('/** Declared machine kinds and billing; these facts do not grant controller availability or execution. */');
  lines.push(renderBundledMachineProvisionerDeclarationsTs(params.pluginPackages));
  lines.push('');
  return lines.join('\n');
}

/** The same admitted declarations and UI descriptors, without app or executable imports. */
export function renderBundledAgentPresentationTs(pluginPackages: readonly BundledPluginPackage[]): string {
  const identities = collectBundledAgentContributionIdentities(pluginPackages);
  const lines = [
    '/** GENERATED by apps/cli/scripts/build-owned/generateBundledPluginEntries.ts. */',
    "import type { BundledAgentPresentation } from '../presentation.js';",
    '',
    'export const BUNDLED_AGENT_PRESENTATION: Readonly<Record<string, BundledAgentPresentation>> = Object.freeze({',
  ];
  for (const entry of pluginPackages) {
    if (!entry.agentId) continue;
    const identity = identities[entry.agentId];
    const agent = entry.manifest.contributes.agents?.find((definition) => definition.id === identity?.localId);
    if (!agent) throw new Error(`Missing admitted Agent declaration for ${entry.packageName}`);
    const identityColor = entry.agentUiDescriptor?.identityColor;
    const name = readDeclaredAgentTitle(agent.title);
    if (!name) throw new Error(`Missing declared Agent title for ${entry.packageName}`);
    lines.push(`  ${renderTsStringLiteral(entry.agentId)}: Object.freeze({ name: ${renderTsStringLiteral(name)}, identityColor: ${identityColor ? `Object.freeze(${JSON.stringify(identityColor)})` : 'null'} }),`);
  }
  lines.push('});', '');
  return lines.join('\n');
}

export function renderBundledUiBehaviorOverridesTs(sources: readonly AgentUiBehaviorDescriptorSource[]): string {
  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is the UI-side generated bundled entry map for first-party bundled');
  lines.push(' * Agent UI descriptors and predecessor-scoped message metadata writers.');
  lines.push(' *');
  lines.push(' * It is split out from `generatedBundledPluginEntries.ts` to avoid import cycles');
  lines.push(' * between agent UI behavior graphs, message compatibility, and registry maps.');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('import type { CanonicalAgentId } from \'./registryCore\';');
  const predecessorMessageMetaWriterSources = sources.flatMap((source) => (
    source.predecessorMessageMetaWriter ? [source.predecessorMessageMetaWriter] : []
  ));
  for (const source of predecessorMessageMetaWriterSources) {
    lines.push(`import { ${source.importName} } from ${renderTsStringLiteral(source.importPath)};`);
  }
  lines.push('');
  lines.push('export type BundledAgentUiBehaviorDescriptor = Readonly<{');
  lines.push('    agentId: CanonicalAgentId;');
  lines.push('    descriptor: Readonly<Record<string, unknown>>;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS: Readonly<');
  lines.push('    Partial<Record<CanonicalAgentId, BundledAgentUiBehaviorDescriptor>>');
  lines.push('> = Object.freeze({');
  for (const source of sources) {
    lines.push(`    ${source.agentId}: Object.freeze({`);
    lines.push(`        agentId: ${renderTsStringLiteral(source.agentId)} as CanonicalAgentId,`);
    lines.push(`        descriptor: Object.freeze(${renderJsonLiteral(source.descriptor)} as const),`);
    lines.push('    }),');
  }
  lines.push('});');
  lines.push('');
  // Defaults are the plugin's whole settings default projection; the protocol
  // writer reads only its own keys. Bind them to a constant so later plugin
  // settings never trip excess-property checks, retaining literal field types.
  for (const source of sources) {
    if (!source.predecessorMessageMetaWriter) continue;
    lines.push(`const ${toAgentConstPrefix(source.agentId)}_PREDECESSOR_MESSAGE_META_DEFAULTS = ${renderJsonLiteral(source.predecessorMessageMetaWriter.defaults)} as const;`);
    lines.push('');
  }
  lines.push('export type BundledAgentPredecessorMessageMetaWriter = Readonly<{');
  lines.push('    buildPredecessorMessageMeta(settings: Readonly<Record<string, unknown>>):');
  lines.push('        Readonly<Record<string, string | number | boolean | null | readonly string[]>>;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENT_PREDECESSOR_MESSAGE_META_WRITERS: Readonly<');
  lines.push('    Partial<Record<CanonicalAgentId, BundledAgentPredecessorMessageMetaWriter>>');
  lines.push('> = Object.freeze({');
  for (const source of sources) {
    if (!source.predecessorMessageMetaWriter) continue;
    lines.push(`    ${source.agentId}: {`);
    lines.push(`        buildPredecessorMessageMeta: (settings) => ${source.predecessorMessageMetaWriter.importName}(settings, ${toAgentConstPrefix(source.agentId)}_PREDECESSOR_MESSAGE_META_DEFAULTS),`);
    lines.push('    },');
  }
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

function collectBundledPluginTranslationKeys(translations: JsonObject): string[] {
  return [...new Set(Object.values(translations).flatMap((bundle) =>
    Object.keys(readRequiredRecord(bundle, 'bundled plugin translation bundle')),
  ))].sort();
}

export function renderBundledPluginTranslationKeysTs(translations: JsonObject): string {
  return [
    '/** GENERATED by apps/cli/scripts/build-owned/generateBundledPluginEntries.ts. */',
    "import type { BundledPluginTranslationKey } from './bundledPluginTranslations.generated';",
    `export const BUNDLED_PLUGIN_TRANSLATION_KEYS: readonly BundledPluginTranslationKey[] = Object.freeze(${renderJsonLiteral(collectBundledPluginTranslationKeys(translations))});`,
    '',
  ].join('\n');
}

export function renderBundledPluginTranslationsTs(translations: JsonObject, locale?: string): string {
  if (locale !== undefined) {
    const bundle = translations[locale] ?? {};
    return [
      '/** GENERATED by apps/cli/scripts/build-owned/generateBundledPluginEntries.ts. */',
      "import type { BundledPluginTranslationKey } from '../bundledPluginTranslations.generated';",
      'export const BUNDLED_PLUGIN_TRANSLATIONS: Readonly<Partial<Record<BundledPluginTranslationKey, string>>> =',
      `    Object.freeze(${renderJsonLiteral(bundle)});`,
      '',
    ].join('\n');
  }
  const locales = Object.keys(translations).sort();
  const keys = collectBundledPluginTranslationKeys(translations);
  return [
    '/**',
    ' * GENERATED FILE CONTRACT (G5-bundled-plugin-translations)',
    ' *',
    ' * This file is emitted by:',
    ' * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`',
    ' */',
    '',
    `type BundledPluginTranslationLocale = ${locales.map(renderTsStringLiteral).join(' | ') || 'never'};`,
    'export const BUNDLED_PLUGIN_TRANSLATIONS: Readonly<Record<',
    '    BundledPluginTranslationLocale, Readonly<Partial<Record<BundledPluginTranslationKey, string>>>',
    `>> = Object.freeze(${renderJsonLiteral(translations)});`,
    '',
    'export type BundledPluginTranslationKey =',
    ...(keys.length === 0 ? ['    never;'] : keys.map((key, index) =>
      `    ${index === 0 ? '' : '| '}${renderTsStringLiteral(key)}${index === keys.length - 1 ? ';' : ''}`,
    )),
    '',
  ].join('\n');
}

export function renderBundledSessionAgentBehaviorsTs(sources: readonly AgentSessionBehaviorSource[]): string {
  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is the UI-side generated bundled entry map for first-party bundled');
  lines.push(' * agent session provider behaviors.');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('import type { CanonicalAgentId } from \'./registryCore\';');
  lines.push('import type { SessionProviderBehavior } from \'@/sync/domains/session/providers/sessionProviderBehaviorTypes\';');
  lines.push('');
  lines.push('export type BundledSessionAgentBehaviorDescriptor = Readonly<{');
  lines.push('    agentId: CanonicalAgentId;');
  lines.push('    descriptor: Readonly<Record<string, unknown>>;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENT_SESSION_BEHAVIOR_DESCRIPTORS: Readonly<');
  lines.push('    Partial<Record<CanonicalAgentId, BundledSessionAgentBehaviorDescriptor>>');
  lines.push('> = Object.freeze({');
  for (const source of sources) {
    lines.push(`    ${source.agentId}: Object.freeze({`);
    lines.push(`        agentId: ${renderTsStringLiteral(source.agentId)} as CanonicalAgentId,`);
    lines.push(`        descriptor: Object.freeze(${renderJsonLiteral(source.descriptor)} as const),`);
    lines.push('    }),');
  }
  lines.push('});');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENT_SESSION_BEHAVIORS: Readonly<');
  lines.push('    Partial<Record<CanonicalAgentId, SessionProviderBehavior>>');
  lines.push('> = Object.freeze({});');
  lines.push('');
  return lines.join('\n');
}

export function renderBundledVisibleMessageResolversTs(
  sources: readonly SessionSubagentVisibleMessageResolverSource[],
): string {
  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is the UI-side generated bundled entry list for first-party bundled');
  lines.push(' * session subagent visible-message resolvers.');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('import type { SessionSubagentVisibleMessagesResolver } from \'@/sync/domains/session/subagents/visibleMessages/types\';');
  lines.push('');
  lines.push('export type BundledSessionSubagentVisibleMessageDescriptor = Readonly<{');
  lines.push('    agentId: string;');
  lines.push('    descriptor: Readonly<Record<string, unknown>>;');
  lines.push('}>;');
  lines.push('');
  lines.push('export type BundledSessionSubagentVisibleMessageRegistryEntry = Readonly<{');
  lines.push('    agentId: string;');
  lines.push('    resolveVisibleMessages: SessionSubagentVisibleMessagesResolver;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_DESCRIPTORS: readonly BundledSessionSubagentVisibleMessageDescriptor[] = Object.freeze([');
  for (const source of sources) {
    lines.push('    Object.freeze({');
    lines.push(`        agentId: ${renderTsStringLiteral(source.agentId)},`);
    lines.push(`        descriptor: Object.freeze(${renderJsonLiteral(source.descriptor)} as const),`);
    lines.push('    }),');
  }
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_REGISTRY: readonly BundledSessionSubagentVisibleMessageRegistryEntry[] = Object.freeze([');
  lines.push(']);');
  lines.push('');
  return lines.join('\n');
}
