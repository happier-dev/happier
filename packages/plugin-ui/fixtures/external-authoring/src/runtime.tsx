import { isRecord } from '@happier-dev/plugin-sdk';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';

import { manifest as externalAuthoringManifest } from './index.js';

// An external author never authors these values: the host projects them from the
// user's active Happier theme. This fixture pins a snapshot so the packaged
// build has a deterministic surface context.
const EXTERNAL_AUTHORING_THEME: PluginUiThemeV1 = {
  version: 1,
  colors: {
    canvas: '#101010', surface: '#202020', elevatedSurface: '#303030',
    text: '#f0f0f0', secondaryText: '#c0c0c0', mutedText: '#909090',
    border: '#404040', divider: '#353535', focus: '#5599ff',
    accent: '#2277ee', onAccent: '#ffffff',
    success: '#34c759', warning: '#ff9500', danger: '#ff3b30', info: '#5856d6',
    control: '#252525', controlDisabled: '#454545', overlay: 'rgba(0,0,0,0.5)',
  },
  spacing: { xsmall: 4, small: 8, medium: 12, large: 16, xlarge: 20 },
  radii: { small: 4, control: 8, panel: 12, pill: 999 },
  typography: {
    body: { fontSize: 13, lineHeight: 17, fontWeight: '400' },
    label: { fontSize: 11, lineHeight: 14, fontWeight: '500' },
    title: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
    caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
    code: { fontSize: 12, lineHeight: 16 },
  },
};

/**
 * What this Node boot proves, and what it deliberately does not.
 *
 * PROVES, under NodeNext resolution outside the monorepo: the packed tarballs
 * install, the package's non-React-Native entrypoints load and execute, and the
 * theme contract an author writes against is the SDK's.
 *
 * DOES NOT PROVE rendering, and no longer pretends to. `src/Surface.tsx` — the
 * real author surface — renders React Native components now that the `Text`
 * family has graduated (§3.10.3), and React Native is a HOST-PROVIDED singleton
 * (§3.8): an external author's package never installs a copy, and a bare Node
 * process has no runtime to mount it in. Surface.tsx is covered here by the
 * NodeNext/Vite/Metro typechecks and the Vite production build with
 * `react-native` externalized. Its mount evidence belongs to the packed-candidate
 * browser QA and the Maestro device lane (§7 layer 6), which is exactly where
 * §1.4 says component credit has to come from.
 */
if (EXTERNAL_AUTHORING_THEME.typography.title.fontSize <= 0) {
  throw new Error('External plugin UI theme contract is not usable.');
}

function readComposerContribution(
  contributions: readonly unknown[],
  localId: string,
  family: string,
): Record<string, unknown> {
  const contribution = contributions.find((candidate) => (
    isRecord(candidate) && candidate.id === localId
  ));
  if (!contribution || !isRecord(contribution)) {
    throw new Error(`External author package is missing Composer ${family} '${localId}'.`);
  }
  return contribution;
}

function hasExactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function hasRenderer(record: Record<string, unknown>, key: string, expectedRenderer: string): boolean {
  const binding = record[key];
  return isRecord(binding)
    && binding.renderer === expectedRenderer;
}

function hasSurfacePresentation(
  record: Record<string, unknown>,
  key: 'display' | 'preview',
  expectedPresentation: Record<string, unknown>,
): boolean {
  const presentation = record[key];
  return isRecord(presentation)
    && Object.entries(expectedPresentation).every(([field, expected]) => presentation[field] === expected)
    && hasRenderer(presentation, 'renderer', 'external-authoring-composer-renderer');
}

const parsedExternalAuthoringManifest = parsePluginManifest(externalAuthoringManifest);
if (!parsedExternalAuthoringManifest.ok) {
  throw new Error('External author package did not produce a public Plugin Manifest.');
}

const { contributes } = parsedExternalAuthoringManifest.manifest;
const translationBundles = contributes.ui.translations;
const englishTranslations = translationBundles.find(({ locale }) => locale === 'en');
const frenchTranslations = translationBundles.find(({ locale }) => locale === 'fr');
if (
  englishTranslations?.messages['external.review.save'] !== 'Save external review'
  || frenchTranslations?.messages['external.review.save'] !== 'Enregistrer la revue externe'
) {
  throw new Error('External author package did not preserve its public translation bundles.');
}
const externalComposerReference = readComposerContribution(
  contributes.composerReferences,
  'external-issues',
  'reference',
);
const externalComposerAttachment = readComposerContribution(
  contributes.composerAttachments,
  'external-issue',
  'attachment',
);
const externalComposerControl = readComposerContribution(
  contributes.composerControls,
  'external-issue-control',
  'control',
);
const externalComposerApplyControl = readComposerContribution(
  contributes.composerControls,
  'external-issue-apply-control',
  'control',
);
const externalComposerRegion = readComposerContribution(
  contributes.composerRegions,
  'external-issue-region',
  'region',
);
const externalComposerRuntime = externalComposerAttachment.runtime;
const externalComposerControlInteraction = externalComposerControl.interaction;
const externalComposerApplyInteraction = externalComposerApplyControl.interaction;

if (
  !hasExactStringArray(externalComposerReference.triggers, ['@', '$'])
  || externalComposerAttachment.cardinality !== 'many'
  || !hasRenderer(externalComposerAttachment, 'picker', 'external-authoring-composer-renderer')
  || !isRecord(externalComposerRuntime)
  || externalComposerRuntime.prepareForSend !== true
  || externalComposerRuntime.resolveForDispatch !== true
  || externalComposerRuntime.afterMessageAccepted !== true
  || !hasSurfacePresentation(externalComposerAttachment, 'display', {
    kind: 'surface',
    sizing: 'content',
  })
  || !hasSurfacePresentation(externalComposerAttachment, 'preview', {
    kind: 'surface',
    presentation: 'popover',
  })
  || !isRecord(externalComposerControlInteraction)
  || externalComposerControlInteraction.kind !== 'attachmentPicker'
  || externalComposerControlInteraction.attachment !== 'external-issue'
  || externalComposerControlInteraction.presentation !== 'popover'
  || externalComposerControlInteraction.layout !== 'split'
  || !isRecord(externalComposerApplyInteraction)
  || externalComposerApplyInteraction.kind !== 'choices'
  || externalComposerApplyInteraction.selection !== 'single'
  || !Array.isArray(externalComposerApplyInteraction.options)
  || externalComposerApplyInteraction.options.length !== 1
  || !isRecord(externalComposerApplyInteraction.options[0])
  || !isRecord(externalComposerApplyInteraction.options[0].effect)
  || externalComposerApplyInteraction.options[0].effect.kind !== 'composerApply'
  || !hasRenderer(externalComposerRegion, 'renderer', 'external-authoring-composer-renderer')
) {
  throw new Error(
    'External author package must normalize public Composer references, attachments, controls, declarative apply, and regions.',
  );
}
console.log('external-plugin-ui-runtime:ok');
