import type { SessionStateCapabilitiesV1, SessionStateFieldId } from '@happier-dev/protocol';

import type { SessionStateDirection } from './_types.js';

export type SessionStateCapabilityGateResult =
  | Readonly<{ supported: true }>
  | Readonly<{ supported: false; reason: 'field-unsupported' | 'direction-unsupported' }>;

type SessionStateFieldFamily = keyof SessionStateCapabilitiesV1;
type SessionStateProviderDirection = Extract<SessionStateDirection, 'happierToProvider' | 'providerToHappier'>;

const FIELD_CAPABILITY_PATH = {
  'identity.runtimeDescriptor': ['identity', 'runtimeDescriptor'],
  'identity.providerSessionId': ['identity', 'providerSessionId'],
  'intent.model': ['intent', 'model'],
  'intent.permissionMode': ['intent', 'permissionMode'],
  'intent.acpSessionMode': ['intent', 'acpSessionMode'],
  'intent.acpConfigOption': ['intent', 'acpConfigOption'],
  'display.title': ['display', 'title'],
  'runtime.workState': ['runtime', 'workState'],
  'runtime.activity': ['runtime', 'activity'],
  'runtime.externalAgent': ['runtime', 'externalAgent'],
  'runtime.externalSessionOperation': ['runtime', 'externalSessionOperation'],
  'runtime.usageLimitRecovery': ['runtime', 'usageLimitRecovery'],
  'runtime.sessionRunner': ['runtime', 'sessionRunner'],
  'view.readState': ['view', 'readState'],
  'view.attention': ['view', 'attention'],
} as const satisfies Record<SessionStateFieldId, readonly [SessionStateFieldFamily, string]>;

const DEFERRED_PROVIDER_SYNC_FIELDS = new Set<SessionStateFieldId>([
  'view.readState',
  'view.attention',
]);

export function getSessionStateFieldCapability(
  capabilities: SessionStateCapabilitiesV1,
  fieldId: SessionStateFieldId,
) {
  const [family, field] = FIELD_CAPABILITY_PATH[fieldId];
  const familyCapabilities = capabilities[family] as Record<string, unknown> | undefined;
  return familyCapabilities?.[field] as
    | NonNullable<NonNullable<SessionStateCapabilitiesV1['display']>['title']>
    | undefined;
}

export function isSessionStateDirectionSupported(params: Readonly<{
  capabilities: SessionStateCapabilitiesV1;
  fieldId: SessionStateFieldId;
  direction: SessionStateProviderDirection;
}>): SessionStateCapabilityGateResult {
  if (DEFERRED_PROVIDER_SYNC_FIELDS.has(params.fieldId)) {
    return { supported: false, reason: 'field-unsupported' };
  }

  const capability = getSessionStateFieldCapability(params.capabilities, params.fieldId);
  if (!capability?.supported) {
    return { supported: false, reason: 'field-unsupported' };
  }

  if (capability[params.direction]?.supported !== true) {
    return { supported: false, reason: 'direction-unsupported' };
  }

  return { supported: true };
}

export function isSessionStateFieldSupported(params: Readonly<{
  capabilities: SessionStateCapabilitiesV1;
  fieldId: SessionStateFieldId;
}>): SessionStateCapabilityGateResult {
  const capability = getSessionStateFieldCapability(params.capabilities, params.fieldId);
  if (!capability?.supported) {
    return { supported: false, reason: 'field-unsupported' };
  }
  return { supported: true };
}
