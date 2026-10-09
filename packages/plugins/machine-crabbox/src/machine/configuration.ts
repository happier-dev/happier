import type { ActionContribution, InputPredicate } from '@happier-dev/plugin-sdk/actions';
import { CRABBOX_CONFIGURATION_LABELS } from '../ui/translations.js';

function label(id: keyof typeof CRABBOX_CONFIGURATION_LABELS.en) {
  return { key: `machineCrabbox.configure.${id}`, fallback: CRABBOX_CONFIGURATION_LABELS.en[id] };
}
const local: InputPredicate = { op: 'eq', path: 'backendId', value: 'local-container' };
const cloud: InputPredicate = { op: 'or', any: ['aws', 'gcp', 'hetzner'].map((value): InputPredicate => ({ op: 'eq', path: 'backendId', value })) };
const gcp: InputPredicate = { op: 'eq', path: 'backendId', value: 'gcp' };
const hetzner: InputPredicate = { op: 'eq', path: 'backendId', value: 'hetzner' };

// Native inputs only. The canonical shared Action form owns controls,
// predicates and normalization; no native defaults or form engine live here.
export const CRABBOX_OPTIONS_INPUT_HINTS: NonNullable<ActionContribution['inputHints']> = {
  fields: [
    { path: 'backendId', title: label('backendId'), widget: 'select', required: true, requireExplicitSelection: true,
      options: [{ value: 'aws', label: 'AWS' }, { value: 'gcp', label: 'Google Cloud' }, { value: 'hetzner', label: 'Hetzner' },
        { value: 'local-container', label: label('localContainer') }, { value: 'blacksmith-testbox', label: 'Blacksmith Testbox', disabled: true }] },
    { path: 'transport', title: label('transport'), widget: 'select', required: true, requireExplicitSelection: true,
      options: [{ value: 'direct', label: label('direct') }, { value: 'coordinator', label: label('coordinator') }] },
    { path: 'namespace', title: label('namespace'), widget: 'text', required: true },
    { path: 'target', title: label('target'), widget: 'select', required: true, requireExplicitSelection: true,
      options: [{ value: 'linux', label: 'Linux' }, { value: 'macos', label: 'macOS' }] },
    { path: 'nativeImageId', title: label('nativeImageId'), widget: 'text', required: true },
    { path: 'nativeSizeId', title: label('nativeSizeId'), widget: 'text', required: true, visibleWhen: cloud },
    { path: 'ttlSeconds', title: label('ttlSeconds'), widget: 'integer', required: true },
    { path: 'idleTimeoutSeconds', title: label('idleTimeoutSeconds'), widget: 'integer', required: true },
    { path: 'gcpProject', title: label('gcpProject'), widget: 'text', required: true, visibleWhen: gcp },
    { path: 'gcpZone', title: label('gcpZone'), widget: 'text', required: true, visibleWhen: gcp },
    { path: 'location', title: label('location'), widget: 'text', required: true, visibleWhen: hetzner },
    { path: 'localContainerRuntime', title: label('localContainerRuntime'), widget: 'select', visibleWhen: local,
      options: [{ value: 'docker', label: 'Docker' }, { value: 'podman', label: 'Podman' }] },
    { path: 'localContainerCpus', title: label('localContainerCpus'), widget: 'integer', visibleWhen: local },
    { path: 'localContainerMemory', title: label('localContainerMemory'), widget: 'text', visibleWhen: local },
  ],
};
