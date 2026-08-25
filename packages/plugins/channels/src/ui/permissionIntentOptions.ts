import {
  AgentPermissionIntentV1Schema,
  type AgentPermissionIntentV1,
} from '@happier-dev/plugin-sdk/sessions';

type Translate = (key: string, fallback: string) => string;

const PERMISSION_INTENT_PRESENTATIONS = [
  { value: 'default', key: 'plugins.channels.surface.bindingCreatePermissionDefault', fallback: 'Default' },
  { value: 'read-only', key: 'plugins.channels.surface.bindingCreatePermissionReadOnly', fallback: 'Read only' },
  { value: 'safe-yolo', key: 'plugins.channels.surface.bindingCreatePermissionSafeYolo', fallback: 'Safe yolo' },
  { value: 'yolo', key: 'plugins.channels.surface.bindingCreatePermissionYolo', fallback: 'Yolo' },
  { value: 'plan', key: 'plugins.channels.surface.bindingCreatePermissionPlan', fallback: 'Plan' },
] as const satisfies readonly Readonly<{
  value: AgentPermissionIntentV1;
  key: string;
  fallback: string;
}>[];

export function parseBindingPermissionIntent(value: unknown): AgentPermissionIntentV1 | null {
  const parsed = AgentPermissionIntentV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function bindingPermissionIntentOptions(t: Translate): readonly Readonly<{
  value: AgentPermissionIntentV1;
  label: string;
}>[] {
  return PERMISSION_INTENT_PRESENTATIONS.map(({ value, key, fallback }) => ({
    value,
    label: t(key, fallback),
  }));
}

export function bindingPermissionIntentLabel(
  value: AgentPermissionIntentV1,
  t: Translate,
): string {
  const presentation = PERMISSION_INTENT_PRESENTATIONS.find((candidate) => candidate.value === value);
  if (presentation === undefined) {
    throw new TypeError('Unknown Agent permission intent');
  }
  return t(presentation.key, presentation.fallback);
}
