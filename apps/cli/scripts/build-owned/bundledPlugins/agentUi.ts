/** Pure projection rendering; filesystem, preparation and publication stay in the generator. */
import {
  readJsonArrayProperty,
  readJsonObjectProperty,
  readManifestContributionArray,
  readOptionalJsonStringProperty,
  readRequiredContributionId,
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
  GeneratedAgentUiProjectionSource,
  JsonObject,
  SessionSubagentVisibleMessageResolverSource,
} from './projectionFacts.ts';

export const GENERATED_AGENT_UI_PROJECTION_SOURCES: readonly GeneratedAgentUiProjectionSource[] = Object.freeze([
  // Remove this legacy host projection once Qwen ships a first-party plugin.ui.v1 descriptor.
  { agentId: 'qwen', coreConst: 'QWEN_CORE', uiConst: 'QWEN_UI', renderLines: renderQwenGeneratedUiProjectionLines },
]);

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

function renderDescriptorGeneratedSvgIconLines(source: DescriptorGeneratedSvgIconSource): readonly string[] {
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

function readUiDescriptorSvgIconKey(descriptor: AgentUiDescriptor): string | null {
  const assetId = readJsonObjectProperty(descriptor.assets ?? {}, 'svgIcon')
    ? readDescriptorString(readJsonObjectProperty(descriptor.assets ?? {}, 'svgIcon') ?? undefined, 'assetId')
    : null;
  return assetId ?? descriptor.display.icon?.assetId ?? null;
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

function readDescriptorGeneratedSvgIcon(
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

function readProviderOwnedEnvironmentKeys(
  pluginPackage: BundledPluginPackage,
  agentId: string,
): readonly string[] {
  const contribution = readManifestContributionArray(pluginPackage.manifest, 'agents')
    .find((entry) => readRequiredContributionId(entry, 'agents', pluginPackage.packageName) === agentId);
  if (!contribution) return [];
  const providerRequirements = readJsonObjectProperty(contribution, 'providerRequirements');
  const authIsolation = providerRequirements ? readJsonObjectProperty(providerRequirements, 'authIsolation') : undefined;
  const raw = authIsolation?.ownedEnvKeys;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string')) {
    throw new Error(`${pluginPackage.packageName}.contributes.agents.${agentId}.providerRequirements.authIsolation.ownedEnvKeys must be a string array`);
  }
  return raw;
}

function createDescriptorAgentUiProjectionSource(
  pluginPackage: BundledPluginPackage,
  descriptor: AgentUiDescriptor,
): DescriptorAgentUiProjectionSource {
  const constPrefix = toAgentConstPrefix(descriptor.agentId);
  const svgIcon = readDescriptorGeneratedSvgIcon(descriptor, constPrefix);
  return {
    agentId: descriptor.agentId,
    coreConst: `${constPrefix}_CORE`,
    uiConst: `${constPrefix}_UI`,
    descriptor,
    providerOwnedEnvironmentKeys: readProviderOwnedEnvironmentKeys(pluginPackage, descriptor.agentId),
    ...(svgIcon === undefined ? {} : { svgIcon }),
  };
}

function renderDescriptorGeneratedUiProjectionLines(source: DescriptorAgentUiProjectionSource): readonly string[] {
  const { descriptor } = source;
  const agentId = renderTsStringLiteral(descriptor.agentId);
  const svgIconXmlExpression = source.svgIcon?.constName ?? renderAgentLogoSvgXmlExpression(readUiDescriptorSvgIconKey(descriptor));
  const lines: string[] = [];
  if (source.svgIcon) {
    lines.push(...renderDescriptorGeneratedSvgIconLines(source.svgIcon));
    lines.push('');
  }
  lines.push(`const ${source.coreConst}: AgentCoreConfig = {`);
  lines.push(`    id: ${agentId},`);
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
  lines.push(`        modeGroup: ${renderTsStringLiteral(descriptor.display.permissions.modeGroup)},`);
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

function renderQwenGeneratedUiProjectionLines(): readonly string[] {
  return [
    'const QWEN_CORE: AgentCoreConfig = {',
    '    id: \'qwen\',',
    '    displayNameKey: \'agentInput.agent.qwen\',',
    '    subtitleKey: \'profiles.aiBackend.qwenSubtitleExperimental\',',
    '    permissionModeI18nPrefix: \'agentInput.codexPermissionMode\',',
    '    availability: { experimental: true },',
    '    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: \'qwen\' }),',
    '    uiConnectedService: { serviceId: null, labelKey: \'agentInput.agent.qwen\', connectRoute: null },',
    '    flavorAliases: [\'qwen\', \'qwen-code\'],',
    '    cli: buildCatalogAgentCliUiConfig(\'qwen\'),',
    '    permissions: {',
    '        modeGroup: \'codexLike\',',
    '        promptProtocol: \'codexDecision\',',
    '    },',
    '    sessionModes: {',
    '        kind: getAgentSessionModesKind(\'qwen\'),',
    '    },',
    '    model: getAgentModelConfig(\'qwen\'),',
    '    resume: buildAgentResumeUiConfig({',
    '        agentId: \'qwen\',',
    '        uiVendorResumeIdLabelKey: \'sessionInfo.qwenSessionId\',',
    '        uiVendorResumeIdCopiedKey: \'sessionInfo.qwenSessionIdCopied\',',
    '    }),',
    '    toolRendering: {',
    '        hideUnknownToolsByDefault: true,',
    '    },',
    '    tools: buildAgentToolsUiConfig({ agentId: \'qwen\' }),',
    '    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: \'qwen\' }),',
    '    ui: {',
    '        agentPickerIconName: \'code-slash-outline\',',
    '        cliGlyphScale: 1.0,',
    '        profileCompatibilityGlyphScale: 1.0,',
    '    },',
    '};',
    '',
    'const QWEN_UI: AgentUiConfig = {',
    '    id: \'qwen\',',
    '    icon: null,',
    '    svgIconXml: AGENT_LOGO_SVG_XML.qwen ?? null,',
    '    pickerIconScale: 0.9,',
    '    tintColor: null,',
    '    avatarOverlay: {',
    '        circleScale: 0.35,',
    '        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),',
    '    },',
    '    cliGlyph: \'Q\',',
    '};',
  ];
}

export function renderUiBundledPluginEntriesTs(params: Readonly<{
  packageNames: readonly string[];
  pluginPackages: readonly BundledPluginPackage[];
}>): string {
  const generatedSourcesByAgentId = new Map(
    GENERATED_AGENT_UI_PROJECTION_SOURCES.map((source) => [source.agentId, source] as const),
  );
  const descriptorSourcesByAgentId = new Map(
    params.pluginPackages
      .flatMap((entry) => (entry.agentUiDescriptor ? [createDescriptorAgentUiProjectionSource(entry, entry.agentUiDescriptor)] : []))
      .map((source) => [source.agentId, source] as const),
  );
  const uiProjectionOrder = new Set(AGENT_UI_PROJECTION_ORDER);
  for (const agentId of descriptorSourcesByAgentId.keys()) {
    if (!uiProjectionOrder.has(agentId)) {
      throw new Error(`Bundled agent UI descriptor '${agentId}' is missing from AGENT_UI_PROJECTION_ORDER`);
    }
  }
  const bundledAgentIds = new Set(
    params.pluginPackages.flatMap((entry) => (entry.agentId ? [entry.agentId] : [])),
  );
  const pluginPackageByAgentId = new Map(
    params.pluginPackages.flatMap((entry) => entry.agentId ? [[entry.agentId, entry] as const] : []),
  );
  const selectedProjectionSources = AGENT_UI_PROJECTION_ORDER.flatMap((agentId) => {
    const descriptorSource = descriptorSourcesByAgentId.get(agentId);
    const generatedSource = generatedSourcesByAgentId.get(agentId);
    if (!descriptorSource && !generatedSource) return [];
    let projectionLines = descriptorSource
      ? renderDescriptorGeneratedUiProjectionLines(descriptorSource)
      : generatedSource?.renderLines() ?? [];
    if (!descriptorSource && generatedSource) {
      const pluginPackage = pluginPackageByAgentId.get(agentId);
      const providerOwnedEnvironmentKeys = pluginPackage
        ? readProviderOwnedEnvironmentKeys(pluginPackage, agentId)
        : [];
      const insertionIndex = projectionLines.findIndex((line) => line.trimStart().startsWith('flavorAliases:'));
      if (insertionIndex < 0) throw new Error(`Generated UI projection '${agentId}' has no flavorAliases insertion anchor`);
      projectionLines = [
        ...projectionLines.slice(0, insertionIndex + 1),
        `    providerOwnedEnvironmentKeys: ${renderTsStringArrayLiteral(providerOwnedEnvironmentKeys)},`,
        ...projectionLines.slice(insertionIndex + 1),
      ];
    }
    return [{
      agentId,
      coreConst: descriptorSource?.coreConst ?? generatedSource?.coreConst,
      uiConst: descriptorSource?.uiConst ?? generatedSource?.uiConst,
      projectionLines,
    }];
  });
  const selectedProjectionSourcesByAgentId = new Map(
    selectedProjectionSources.map((source) => [source.agentId, source] as const),
  );
  const usesGeneratedSvgIcons = selectedProjectionSources.some((source) =>
    source.projectionLines.some((line) =>
      line.includes('AgentIconSvgXmlResolver') || line.includes('createGeneratedSvgIconXml('),
    ),
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
  lines.push(usesGeneratedSvgIcons
    ? 'import type { AgentIconSvgXmlResolver, AgentUiConfig } from \'./registryUi\';'
    : 'import type { AgentUiConfig } from \'./registryUi\';');
  lines.push('import { AGENT_LOGO_SVG_XML } from \'./agentLogoSvgXml\';');
  lines.push('');
  lines.push('import { buildCatalogAgentCliUiConfig } from \'@/agents/registry/buildCatalogAgentCliUiConfig\';');
  lines.push('import { buildAgentConnectedServicesUiConfig } from \'@/agents/registry/buildAgentConnectedServicesUiConfig\';');
  lines.push('import { buildAgentLocalControlUiConfig } from \'@/agents/registry/buildAgentLocalControlUiConfig\';');
  lines.push('import { buildAgentResumeUiConfig } from \'@/agents/registry/buildAgentResumeUiConfig\';');
  lines.push('import { buildAgentSessionStorageUiConfig } from \'@/agents/registry/buildAgentSessionStorageUiConfig\';');
  lines.push('import { buildAgentToolsUiConfig } from \'@/agents/registry/buildAgentToolsUiConfig\';');
  lines.push('import { getAgentModelConfig, getAgentSessionModesKind } from \'@happier-dev/agents\';');
  lines.push('');
  if (usesGeneratedSvgIcons) {
    lines.push('function normalizeGeneratedSvgXml(xml: string): string {');
    lines.push('    return xml.replace(/\\s{2,}/g, \' \').trim();');
    lines.push('}');
    lines.push('');
    lines.push('function createGeneratedSvgIconXml(viewBox: string, body: string): string {');
    lines.push('    return normalizeGeneratedSvgXml(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`);');
    lines.push('}');
    lines.push('');
  }
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
  lines.push('export const BUNDLED_CANONICAL_AGENTS_CORE: Readonly<Record<CanonicalAgentId, AgentCoreConfig>> = Object.freeze({');
  for (const agentId of AGENT_UI_PROJECTION_ORDER) {
    const valueName = selectedProjectionSourcesByAgentId.get(agentId)?.coreConst;
    if (!valueName) {
      if (!bundledAgentIds.has(agentId)) continue;
      throw new Error(`Missing UI core projection source for ${agentId}`);
    }
    lines.push(`    ${agentId}: ${valueName},`);
  }
  lines.push('} satisfies Readonly<Record<CanonicalAgentId, AgentCoreConfig>>);');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENTS_UI: Readonly<Record<CanonicalAgentId, AgentUiConfig>> = Object.freeze({');
  for (const agentId of AGENT_UI_PROJECTION_ORDER) {
    const valueName = selectedProjectionSourcesByAgentId.get(agentId)?.uiConst;
    if (!valueName) {
      if (!bundledAgentIds.has(agentId)) continue;
      throw new Error(`Missing UI projection source for ${agentId}`);
    }
    lines.push(`    ${agentId}: ${valueName},`);
  }
  lines.push('} satisfies Readonly<Record<CanonicalAgentId, AgentUiConfig>>);');
  lines.push('');
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
    lines.push(`        buildPredecessorMessageMeta: (settings) => ${source.predecessorMessageMetaWriter.importName}(settings, ${renderJsonLiteral(source.predecessorMessageMetaWriter.defaults)}),`);
    lines.push('    },');
  }
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

export function renderBundledPluginTranslationsTs(translations: JsonObject): string {
  const localeTypes = Object.entries(translations).sort(([a], [b]) => a.localeCompare(b)).map(([locale, bundle]) => {
    const keys = Object.keys(readRequiredRecord(bundle, `translations.${locale}`)).sort((a, b) => a.localeCompare(b));
    return [
      `    ${renderTsStringLiteral(locale)}: Readonly<{`,
      ...keys.map((key) => `        ${renderTsStringLiteral(key)}: string;`),
      '    }>;',
    ].join('\n');
  });
  return [
    '/**',
    ' * GENERATED FILE CONTRACT (G5-bundled-plugin-translations)',
    ' *',
    ' * This file is emitted by:',
    ' * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`',
    ' */',
    '',
    'type BundledPluginTranslations = Readonly<{',
    ...localeTypes,
    '}>;',
    '',
    `export const BUNDLED_PLUGIN_TRANSLATIONS: BundledPluginTranslations = Object.freeze(${renderJsonLiteral(translations)} as const);`,
    '',
    'type KeysOfUnion<T> = T extends T ? keyof T : never;',
    'type BundledPluginTranslationBundle = (typeof BUNDLED_PLUGIN_TRANSLATIONS)[keyof typeof BUNDLED_PLUGIN_TRANSLATIONS];',
    'export type BundledPluginTranslationKey = KeysOfUnion<BundledPluginTranslationBundle> & string;',
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
