import {
  admitPluginListFilterFieldV1,
  admitPluginListFilterFieldValueV1,
  compileEntityListFilterV1,
  createPluginListFilterFieldRegistryV1,
  type PluginListFilterFactsV1,
  type PluginListFilterSelectionV1,
  validatePluginListFilterSelectionsV1,
} from '@happier-dev/plugin-ui/components';
import { isRecord } from '@happier-dev/plugin-sdk';

const declaration = { id: 'release-stage', title: 'Release stage', source: { factKey: 'releaseStage' },
  value: { kind: 'set' } } as const;
const admitted = admitPluginListFilterFieldV1({ pluginId: 'fixture.external-authoring', field: declaration,
  factKeys: new Set(['releaseStage']) });
if (admitted.kind !== 'admitted') throw new Error('The authored release-stage declaration is invalid');
export const externalReleaseStageField = admitted.field;

export function externalReleaseStageSelection(stage?: string): PluginListFilterSelectionV1 {
  return stage === undefined ? {} : { extensions: { [externalReleaseStageField.id]: { kind: 'set', include: [stage], exclude: [] } } };
}

/** Plugin-owned input ingress; evaluation never asks the plugin or host to acquire a value. */
export function admitExternalReleaseStage(stage: unknown): PluginListFilterFactsV1 {
  const value = admitPluginListFilterFieldValueV1(declaration, stage);
  return value.kind === 'available' ? { extensions: { [externalReleaseStageField.id]: value.value } } : {};
}

export function compileExternalReleaseStageFilter(selection: PluginListFilterSelectionV1, current = true) {
  return compileEntityListFilterV1(externalReleaseStageRegistry(current), selection);
}

export function externalReleaseStageRegistry(current = true) {
  return createPluginListFilterFieldRegistryV1<PluginListFilterSelectionV1, PluginListFilterFactsV1>(
    current ? [externalReleaseStageField] : []);
}

/** A deliberate saved lens uses the host's existing device-local page location. */
export function readExternalReleaseFilterLocation(subPath: string | undefined): PluginListFilterSelectionV1 | null {
  if (!subPath?.startsWith('release-filter/')) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(subPath.slice('release-filter/'.length)));
    if (!isRecord(value) || !validatePluginListFilterSelectionsV1([externalReleaseStageField], value.extensions)) return null;
    // The public selection validator admits this plugin-owned route ingress.
    return value as PluginListFilterSelectionV1;
  } catch { return null; }
}

export const externalReleaseReviews = Object.freeze([
  Object.freeze({ id: 'current', title: 'Current review', ...admitExternalReleaseStage('reviewing') }),
  Object.freeze({ id: 'terminal', title: 'Terminal review', ...admitExternalReleaseStage('blocked') }),
  Object.freeze({ id: 'release', title: 'Release review', ...admitExternalReleaseStage('ready') }),
]);
