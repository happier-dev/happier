import type { ActionSpec } from './actionSpecs.js';

type SdkMethodNameSpec = Pick<ActionSpec, 'id' | 'bindings'>;

const SDK_METHOD_RESERVED_ROOTS = new Set(['execute', 'search', 'invoke']);
const SDK_METHOD_OBJECT_HAZARD_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const SDK_METHOD_SEGMENT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

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

export function assertPublicActionSdkMethodNames(
  specs: readonly SdkMethodNameSpec[],
  publicActionIds: ReadonlySet<string>,
): void {
  const ownerByMethodName = new Map<string, string>();
  for (const spec of specs) {
    if (!publicActionIds.has(spec.id)) continue;
    const methodName = resolveActionSdkMethodName(spec);
    const segments = methodName.split('.');
    if (
      segments.length === 0
      || SDK_METHOD_RESERVED_ROOTS.has(segments[0] ?? '')
      || segments.some((segment) => (
        !SDK_METHOD_SEGMENT_PATTERN.test(segment)
        || SDK_METHOD_OBJECT_HAZARD_SEGMENTS.has(segment)
      ))
    ) {
      throw new Error(`Public Action ${spec.id} has an invalid SDK method path: ${methodName}`);
    }
    const existing = ownerByMethodName.get(methodName);
    if (existing) {
      throw new Error(`Public Actions ${existing} and ${spec.id} share SDK method path ${methodName}`);
    }
    ownerByMethodName.set(methodName, spec.id);
  }

  const methodNames = [...ownerByMethodName.keys()].sort();
  for (let index = 1; index < methodNames.length; index += 1) {
    const previous = methodNames[index - 1] as string;
    const current = methodNames[index] as string;
    if (current.startsWith(`${previous}.`)) {
      throw new Error(
        `Public Actions ${ownerByMethodName.get(previous)} and ${ownerByMethodName.get(current)} conflict at SDK namespace ${previous}`,
      );
    }
  }
}
