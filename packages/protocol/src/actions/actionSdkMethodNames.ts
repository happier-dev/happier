import type { ActionSpec } from './actionSpecs.js';

type SdkMethodNameSpec = Pick<ActionSpec, 'id' | 'bindings'>;

function normalizeActionIdSegmentForSdkMethod(segment: string): string {
  return segment.replace(/_([a-z0-9])/gu, (_match, character: string) => character.toUpperCase());
}

/**
 * Canonical generated-SDK method path. `bindings.sdkMethod` remains the one
 * owner-local exception seam; normal Action ids require no hand-written name
 * table.
 */
export function resolveActionSdkMethodName(spec: SdkMethodNameSpec): string {
  const override = spec.bindings?.sdkMethod;
  if (override) return override;
  return spec.id.split('.').map(normalizeActionIdSegmentForSdkMethod).join('.');
}
