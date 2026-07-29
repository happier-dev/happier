import {
  PluginUiHostApiRequirementV1Schema,
  type PluginUiHostApiRequirementV1,
} from '@happier-dev/protocol/plugins/ui';

export type PluginUiDescriptorTarget = Readonly<{
  contributionId: string;
}>;

export type PluginUiExecutableTarget = Readonly<{
  contributionId: string;
  optional?: boolean;
  sourceEntry?: string;
}>;

export type PluginUiSurfaceTargets = Readonly<{
  descriptor?: PluginUiDescriptorTarget;
  hostedWeb?: PluginUiExecutableTarget;
  reactNative?: PluginUiExecutableTarget;
}>;

export type PluginUiSurfaceFallback =
  | Readonly<{ kind: 'hostRenderer'; rendererId: string }>
  | Readonly<{ kind: 'descriptor'; contributionId: string }>
  | Readonly<{ kind: 'hostedWeb'; contributionId: string }>
  | Readonly<{ kind: 'unavailable'; reasonKey?: string }>;

export type PluginUiSurfaceDefinitionInput<TTargets extends PluginUiSurfaceTargets = PluginUiSurfaceTargets> =
  Readonly<{
    id: string;
    hostApi: PluginUiHostApiRequirementV1;
    targets: TTargets;
    fallback: PluginUiSurfaceFallback;
  }>;

export type PluginUiSurfaceDefinition<TTargets extends PluginUiSurfaceTargets = PluginUiSurfaceTargets> =
  Readonly<{
    id: string;
    hostApi: PluginUiHostApiRequirementV1;
    targets: TTargets;
    fallback: PluginUiSurfaceFallback;
  }>;

function readRequiredString(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Expected ${fieldName} to be a non-empty string.`);
  }
  return trimmed;
}

function normalizeTarget<TTarget extends PluginUiDescriptorTarget | PluginUiExecutableTarget>(
  target: TTarget | undefined,
  fieldName: string,
): TTarget | undefined {
  if (!target) return undefined;

  const normalized = {
    ...target,
    contributionId: readRequiredString(target.contributionId, `${fieldName}.contributionId`),
  } as TTarget;

  return Object.freeze(normalized);
}

function normalizeTargets<TTargets extends PluginUiSurfaceTargets>(targets: TTargets): TTargets {
  for (const key of Object.keys(targets)) {
    if (key !== 'descriptor' && key !== 'hostedWeb' && key !== 'reactNative') {
      throw new Error(`Unsupported plugin UI target '${key}'.`);
    }
  }
  const normalized = {
    ...targets,
    descriptor: normalizeTarget(targets.descriptor, 'targets.descriptor'),
    hostedWeb: normalizeTarget(targets.hostedWeb, 'targets.hostedWeb'),
    reactNative: normalizeTarget(targets.reactNative, 'targets.reactNative'),
  };

  if (
    !normalized.descriptor
    && !normalized.hostedWeb
    && !normalized.reactNative
  ) {
    throw new Error('Expected at least one plugin UI target declaration.');
  }

  return Object.freeze(normalized) as TTargets;
}

function normalizeFallback(fallback: PluginUiSurfaceFallback | undefined): PluginUiSurfaceFallback {
  if (!fallback) {
    throw new Error('Plugin UI surfaces must declare a descriptor or hosted fallback.');
  }

  switch (fallback.kind) {
    case 'hostRenderer':
      return Object.freeze({
        kind: fallback.kind,
        rendererId: readRequiredString(fallback.rendererId, 'fallback.rendererId'),
      });
    case 'descriptor':
    case 'hostedWeb':
      return Object.freeze({
        kind: fallback.kind,
        contributionId: readRequiredString(fallback.contributionId, 'fallback.contributionId'),
      });
    case 'unavailable':
      return Object.freeze({
        kind: fallback.kind,
        ...(fallback.reasonKey ? { reasonKey: readRequiredString(fallback.reasonKey, 'fallback.reasonKey') } : {}),
      });
  }
}

function hasExecutableTarget(targets: PluginUiSurfaceTargets): boolean {
  return Boolean(targets.hostedWeb || targets.reactNative);
}

function hasDescriptorOrHostedFallback(
  targets: PluginUiSurfaceTargets,
  fallback: PluginUiSurfaceFallback,
): boolean {
  return Boolean(targets.descriptor || targets.hostedWeb)
    || fallback.kind === 'hostRenderer'
    || fallback.kind === 'descriptor'
    || fallback.kind === 'hostedWeb';
}

export function definePluginUiSurface<const TTargets extends PluginUiSurfaceTargets>(
  input: PluginUiSurfaceDefinitionInput<TTargets>,
): PluginUiSurfaceDefinition<TTargets> {
  const id = readRequiredString(input.id, 'id');
  const hostApi = PluginUiHostApiRequirementV1Schema.parse(input.hostApi);
  const targets = normalizeTargets(input.targets);
  const fallback = normalizeFallback(input.fallback);

  if (hasExecutableTarget(targets) && !hasDescriptorOrHostedFallback(targets, fallback)) {
    throw new Error('Executable plugin UI targets require a descriptor or hosted fallback.');
  }

  return Object.freeze({
    id,
    hostApi: Object.freeze(hostApi),
    targets,
    fallback,
  });
}
