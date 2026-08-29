import { pathToFileURL } from 'node:url';

function requireArgument(value, label) {
  if (!value) throw new Error(`Missing ${label} argument`);
  return value;
}

const [
  targetEntry,
  contributorEntry,
  targetSdkEntry,
  contributorSdkEntry,
] = process.argv.slice(2).map((value, index) => requireArgument(value, `argument ${index + 1}`));

const [
  target,
  contributor,
  targetSdk,
  contributorSdk,
] = await Promise.all([
  import(pathToFileURL(targetEntry).href),
  import(pathToFileURL(contributorEntry).href),
  import(pathToFileURL(targetSdkEntry).href),
  import(pathToFileURL(contributorSdkEntry).href),
]);

if (targetSdk.definePlugin === contributorSdk.definePlugin) {
  throw new Error('Target and contributor resolved the same Plugin SDK module object');
}
if (target.targetProtocol === contributor.contributorProtocol) {
  throw new Error('Target and contributor resolved the same protocol object');
}
if (target.targetProtocol.id !== contributor.contributorProtocol.id
  || target.targetProtocol.version !== contributor.contributorProtocol.version) {
  throw new Error('Physical package copies did not agree on protocol wire identity');
}

const targetDiagnosticSchema = target.targetDiagnosticSchema;
const contributorDiagnosticSchema = contributor.contributorDiagnosticSchema;
if (!targetDiagnosticSchema || !contributorDiagnosticSchema) {
  throw new Error('Expected each physical package to construct its public diagnostic wrapper');
}
if (targetDiagnosticSchema === contributorDiagnosticSchema
  || targetDiagnosticSchema.jsonSchema === contributorDiagnosticSchema.jsonSchema) {
  throw new Error('Physical package copies shared a diagnostic wrapper or leaf projection identity');
}
const diagnosticUtf8ByteLimit = 1024;

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function readDiagnosticUtf8ByteMaximum(schema, label) {
  const properties = schema?.properties;
  const diagnostic = properties?.diagnostic;
  if (schema?.type !== 'object'
    || !Array.isArray(schema?.required)
    || !schema.required.includes('diagnostic')
    || diagnostic?.type !== 'string'
    || diagnostic?.minLength !== 1
    || Object.hasOwn(diagnostic, 'maxLength')
    || diagnostic?.['x-happier-max-utf8-bytes'] !== diagnosticUtf8ByteLimit) {
    throw new Error(`${label} did not publish the required UTF-8 diagnostic string projection`);
  }
  return diagnostic['x-happier-max-utf8-bytes'];
}
const targetDiagnosticUtf8ByteMaximum = readDiagnosticUtf8ByteMaximum(
  targetDiagnosticSchema.jsonSchema,
  'Target diagnostic wrapper',
);
const contributorDiagnosticUtf8ByteMaximum = readDiagnosticUtf8ByteMaximum(
  contributorDiagnosticSchema.jsonSchema,
  'Contributor diagnostic wrapper',
);
const diagnosticAtUtf8Boundary = 'é'.repeat(512);
const diagnosticOverUtf8Boundary = 'é'.repeat(513);
const diagnosticAsciiOverUtf8Boundary = 'a'.repeat(1025);
if (targetDiagnosticUtf8ByteMaximum !== diagnosticUtf8ByteLimit
  || contributorDiagnosticUtf8ByteMaximum !== diagnosticUtf8ByteLimit
  || utf8ByteLength(diagnosticAtUtf8Boundary) !== diagnosticUtf8ByteLimit
  || utf8ByteLength(diagnosticOverUtf8Boundary) !== 1026
  || utf8ByteLength(diagnosticAsciiOverUtf8Boundary) !== 1025) {
  throw new Error('Diagnostic UTF-8 byte boundaries changed');
}
const contributorSerializedDiagnostic = contributor.serializeContributorDiagnostic(
  diagnosticAtUtf8Boundary,
);
const targetAcceptedContributorDiagnostic = target.parseTargetDiagnostic(
  contributorSerializedDiagnostic,
);
if (!targetAcceptedContributorDiagnostic.success
  || targetAcceptedContributorDiagnostic.data.diagnostic !== diagnosticAtUtf8Boundary) {
  throw new Error('Target diagnostic wrapper did not accept the contributor serialized boundary value');
}
const targetSerializedDiagnostic = target.serializeTargetDiagnostic(diagnosticAtUtf8Boundary);
const contributorAcceptedTargetDiagnostic = contributor.parseContributorDiagnostic(
  targetSerializedDiagnostic,
);
if (!contributorAcceptedTargetDiagnostic.success
  || contributorAcceptedTargetDiagnostic.data.diagnostic !== diagnosticAtUtf8Boundary) {
  throw new Error('Contributor diagnostic wrapper did not accept the target serialized boundary value');
}
for (const [label, diagnostic] of [
  ['1,026-byte', diagnosticOverUtf8Boundary],
  ['1,025-byte', diagnosticAsciiOverUtf8Boundary],
]) {
  const serializedDiagnostic = JSON.stringify({ diagnostic });
  const targetRejectedOverLimitDiagnostic = target.parseTargetDiagnostic(serializedDiagnostic);
  const contributorRejectedOverLimitDiagnostic = contributor.parseContributorDiagnostic(
    serializedDiagnostic,
  );
  if (targetRejectedOverLimitDiagnostic.success || contributorRejectedOverLimitDiagnostic.success) {
    throw new Error(`A physical package accepted the ${label} diagnostic value`);
  }
}

const targetPoint = target.targetPlugin.contributionPoints.sources;
const targetPointDeclaration = target.manifest.contributes?.pluginContributionPoints?.[0];
const contribution = contributor.manifest.contributes?.targetedPluginContributions?.[0];
if (!targetPointDeclaration || !contribution) {
  throw new Error('Expected one target point and one contributor wire declaration');
}
if (Object.keys(targetPoint).sort().join(',') !== 'id,protocol,targetPluginId'
  || Object.getOwnPropertySymbols(targetPoint).length !== 0) {
  throw new Error('Target point did not expose one ordinary structural reference');
}
if (contribution.operations.inspect !== 'non-protocol-local-action') {
  throw new Error('The contributor lost its arbitrary local Action id');
}

const targetProtocolDeclaration = targetPointDeclaration.protocols.find((candidate) => (
  candidate.id === contribution.protocol.id && candidate.version === contribution.protocol.version
));
if (!targetProtocolDeclaration) {
  throw new Error('Target wire declaration did not contain the contributor protocol identity');
}

const targetOperationRoles = Object.keys(targetProtocolDeclaration.operations ?? {}).sort();
const contributorOperationRoles = Object.keys(contribution.operations ?? {}).sort();
if (targetOperationRoles.length !== 1
  || targetOperationRoles[0] !== 'inspect'
  || contributorOperationRoles.length !== 1
  || contributorOperationRoles[0] !== 'inspect') {
  throw new Error('Physical-copy target and contributor did not agree on the inspect operation-role census');
}
if (targetProtocolDeclaration.operations.inspect?.action?.surfaces?.join(',') !== 'plugin,ui') {
  throw new Error('Cross-copy target protocol lost its plural plugin/ui Action surfaces');
}
const contributorAction = contributor.manifest.contributes?.actions?.find((action) => (
  action.id === contribution.operations.inspect
));
if (contributorAction?.surfaces?.join(',') !== 'plugin,ui') {
  throw new Error('Cross-copy contributor Action lost its plural plugin/ui surfaces');
}
const detailPresentation = targetProtocolDeclaration.surfaces?.detail?.presentation;
if (contribution.descriptor?.kind !== 'issue'
  || contribution.descriptor.label !== 'Physical package source'
  || detailPresentation !== 'content'
  || !Object.hasOwn(contribution.surfaces ?? {}, 'detail')) {
  throw new Error('Cross-copy target and contributor changed their manifest wire contract');
}

const targetRenderers = target.manifest.contributes?.ui?.renderers ?? [];
const reactTargetRenderer = targetRenderers.find((renderer) => (
  renderer.id === 'physical-copy-target-react-renderer'
));
const declarativeTargetRenderer = targetRenderers.find((renderer) => (
  renderer.id === 'physical-copy-target-declarative-renderer'
));
if (reactTargetRenderer?.kind !== 'reactNative'
  || reactTargetRenderer.artifact !== 'physical-copy-target-react') {
  throw new Error('Target package omitted its public React/RNW A renderer declaration');
}
if (declarativeTargetRenderer?.kind !== 'declarative') {
  throw new Error('Target package omitted its public declarative A renderer declaration');
}

const exactDetailSurface = Object.freeze({
  point: Object.freeze({
    pointId: 'sources',
    protocol: Object.freeze({ id: 'physical-copy-sources', version: 1 }),
  }),
  contributor: Object.freeze({
    pluginId: 'fixture.physical-copy-contributor',
    contributionId: 'physical-copy-source',
    immutableGenerationId: 'physical-copy-contributor-generation-a',
  }),
  role: 'detail',
  presentation: 'content',
});
const targetedContributions = Object.freeze({
  target: Object.freeze({
    pluginId: 'fixture.physical-copy-target',
    immutableGenerationId: 'physical-copy-target-generation-a',
  }),
  points: Object.freeze([Object.freeze({
    pointId: 'sources',
    protocols: Object.freeze([Object.freeze({
      protocol: Object.freeze({ id: 'physical-copy-sources', version: 1 }),
      contributions: Object.freeze([Object.freeze({
        contributor: exactDetailSurface.contributor,
        protocol: Object.freeze({ id: 'physical-copy-sources', version: 1 }),
        descriptor: Object.freeze({ kind: 'issue', label: 'Physical package source' }),
        operations: Object.freeze([]),
        surfaces: Object.freeze([exactDetailSurface]),
      })]),
    })]),
  })]),
});
if (target.selectPhysicalCopyDetailSurface(targetedContributions) !== exactDetailSurface) {
  throw new Error('Target React/RNW A surface did not select its one exact current B handle');
}
if (target.selectPhysicalCopyDetailSurface(Object.freeze({
  ...targetedContributions,
  points: Object.freeze([]),
})) !== null) {
  throw new Error('Target React/RNW A surface did not fail closed for a missing B handle');
}
const mismatchedGenerationContributions = Object.freeze({
  ...targetedContributions,
  points: Object.freeze([Object.freeze({
    ...targetedContributions.points[0],
    protocols: Object.freeze([Object.freeze({
      ...targetedContributions.points[0].protocols[0],
      contributions: Object.freeze([Object.freeze({
        ...targetedContributions.points[0].protocols[0].contributions[0],
        surfaces: Object.freeze([Object.freeze({
          ...exactDetailSurface,
          contributor: Object.freeze({
            ...exactDetailSurface.contributor,
            immutableGenerationId: 'stale-generation',
          }),
        })]),
      })]),
    })]),
  })]),
});
if (target.selectPhysicalCopyDetailSurface(mismatchedGenerationContributions) !== null) {
  throw new Error('Target React/RNW A surface did not fail closed for a stale B generation');
}
if (target.selectPhysicalCopyDetailSurface(Object.freeze({
  ...targetedContributions,
  points: Object.freeze([...targetedContributions.points, ...targetedContributions.points]),
})) !== null) {
  throw new Error('Target React/RNW A surface did not fail closed for duplicate B handles');
}
const declarativeTargetNode = declarativeTargetRenderer.root;
if (JSON.stringify(declarativeTargetNode) !== JSON.stringify(target.physicalCopyTargetDetailNode)) {
  throw new Error('Target declarative A renderer does not own the exported targeted B node');
}
if (declarativeTargetNode?.kind !== 'targetedSurface'
  || declarativeTargetNode.surface?.point?.pointId !== 'sources'
  || declarativeTargetNode.surface?.point?.protocol?.id !== 'physical-copy-sources'
  || declarativeTargetNode.surface?.point?.protocol?.version !== 1
  || declarativeTargetNode.surface?.contributor?.pluginId !== 'fixture.physical-copy-contributor'
  || declarativeTargetNode.surface?.contributor?.contributionId !== 'physical-copy-source'
  || declarativeTargetNode.surface?.role !== 'detail'
  || declarativeTargetNode.input?.entryId !== 'external-42') {
  throw new Error('Target declarative A renderer did not converge on the exact B declaration');
}

const composerReferences = contributor.manifest.contributes?.composerReferences ?? [];
const composerAttachments = contributor.manifest.contributes?.composerAttachments ?? [];
const composerControls = contributor.manifest.contributes?.composerControls ?? [];
const composerRegions = contributor.manifest.contributes?.composerRegions ?? [];
const reference = composerReferences.find((candidate) => candidate.id === 'sources');
const attachment = composerAttachments.find((candidate) => candidate.id === 'external-readonly');
const control = composerControls.find((candidate) => candidate.id === 'external-readonly-control');
const region = composerRegions.find((candidate) => candidate.id === 'external-readonly-region');
if (!reference || !attachment || !control || !region) {
  throw new Error('Contributor manifest omitted an authored Composer contribution family');
}
if (reference.title?.key !== 'external.sources.title'
  || reference.title?.fallback !== 'External sources'
  || reference.description?.key !== 'external.sources.description'
  || reference.description?.fallback !== 'Search external physical-package sources'
  || reference.icon !== 'search'
  || reference.triggers?.join(',') !== '@,$') {
  throw new Error('Composer reference serialization changed its localized declaration');
}
if (attachment.description?.key !== 'external.readonly.description'
  || attachment.description?.fallback !== 'A public readonly JSON attachment contract'
  || attachment.cardinality !== 'one'
  || attachment.valueSchema?.type !== 'array'
  || attachment.preparedValueSchema?.type !== 'array'
  || attachment.runtime?.prepareForSend !== true
  || attachment.display?.kind !== 'badge'
  || attachment.picker?.renderer !== 'physical-copy-composer-renderer'
  || attachment.preview?.kind !== 'surface'
  || attachment.preview.renderer?.renderer !== 'physical-copy-composer-renderer'
  || attachment.preview.presentation !== 'popover') {
  throw new Error('Composer attachment serialization changed its public declaration');
}
if (control.interaction?.kind !== 'surface'
  || control.interaction.renderer?.renderer !== 'physical-copy-composer-renderer'
  || control.interaction.presentation !== 'popover'
  || control.interaction.layout !== 'content'
  || control.compactRenderer?.renderer !== 'physical-copy-composer-renderer'
  || control.overflow?.label?.key !== 'external.readonly.control.more'
  || control.overflow?.label?.fallback !== 'More external choices') {
  throw new Error('Composer control serialization changed its surface shorthand contract');
}
if (region.placement !== 'afterComposer'
  || region.renderer?.renderer !== 'physical-copy-composer-renderer') {
  throw new Error('Composer region serialization changed its renderer contract');
}

process.stdout.write(JSON.stringify({
  actionId: contribution.operations.inspect,
  descriptor: contribution.descriptor,
  surface: { role: 'detail', presentation: detailPresentation },
  targetedSurface: {
    reactRenderer: reactTargetRenderer.id,
    declarativeRenderer: declarativeTargetRenderer.id,
    selectedExactHandle: true,
    missingHandleFailedClosed: true,
    mismatchedGenerationFailedClosed: true,
    duplicateHandleFailedClosed: true,
    entryId: declarativeTargetNode.input.entryId,
  },
  diagnostic: {
    acceptedUtf8Bytes: utf8ByteLength(diagnosticAtUtf8Boundary),
    targetAcceptedContributorSerializedValue: true,
    contributorAcceptedTargetSerializedValue: true,
    utf8ByteLimit: diagnosticUtf8ByteLimit,
    multiByteOverLimitRejected: true,
    asciiOverLimitRejected: true,
  },
  composer: {
    reference: {
      title: reference.title,
      description: reference.description,
      triggers: reference.triggers,
    },
    attachment: {
      description: attachment.description,
      cardinality: attachment.cardinality,
      valueSchemaType: attachment.valueSchema.type,
      preparedValueSchemaType: attachment.preparedValueSchema?.type,
      runtime: attachment.runtime,
      display: attachment.display?.kind,
      pickerRenderer: attachment.picker?.renderer,
      previewRenderer: attachment.preview?.renderer?.renderer,
      previewPresentation: attachment.preview?.presentation,
    },
    control: {
      renderer: control.interaction.renderer?.renderer,
      presentation: control.interaction.presentation,
      layout: control.interaction.layout,
      compactRenderer: control.compactRenderer?.renderer,
      overflowLabel: control.overflow?.label,
    },
    region: {
      placement: region.placement,
      renderer: region.renderer.renderer,
    },
  },
}));
