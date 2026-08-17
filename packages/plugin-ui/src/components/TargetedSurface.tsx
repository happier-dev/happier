import { useEffect, type ReactElement, type ReactNode } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { ContributionSurfaceHandle } from '@happier-dev/plugin-sdk/contributions';
import type { PluginUiTargetedContributionSurfaceV1 } from '@happier-dev/plugin-sdk/ui';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { usePluginHostApi } from '../hostApi/context.js';

/**
 * The target-local, contributor-owned embedded surface author primitive.
 *
 * This component deliberately has no mount state or host logic of its own. It
 * lends the exact typed handle and launch input to the existing private
 * presentation-host bridge, whose UI consumer rematches the current parent
 * snapshot and delegates to the one physical PluginSurfaceHost owner.
 */
type TargetedSurfaceInput<
  TSurface extends PluginUiTargetedContributionSurfaceV1,
> = TSurface extends ContributionSurfaceHandle<infer TInput, infer _TPointId>
  ? TInput
  : JsonValue;

export type TargetedSurfaceProps<
  TInput extends JsonValue = JsonValue,
  TPointId extends string = string,
  TSurface extends PluginUiTargetedContributionSurfaceV1 = ContributionSurfaceHandle<TInput, TPointId>,
> = Readonly<{
  /** A static typed handle or the exact current surface projected by SurfaceContext. */
  surface: TSurface;
  input: TargetedSurfaceInput<TSurface>;
  /** A caller-local key; the host namespaces it with the admitted identities. */
  instanceKey?: string;
  /** Rendered only when this mounted parent cannot present an embedded child. */
  fallback?: ReactNode;
}>;

export function TargetedSurface<
  TInput extends JsonValue = JsonValue,
  TPointId extends string = string,
  TSurface extends PluginUiTargetedContributionSurfaceV1 = ContributionSurfaceHandle<TInput, TPointId>,
>({ surface, input, instanceKey, fallback }: TargetedSurfaceProps<TInput, TPointId, TSurface>): ReactElement | null {
  const hostApi = usePluginHostApi();
  const presentationHost = useOptionalPluginUiPresentationHost();
  const renderTargetedSurface = presentationHost?.renderTargetedSurface;
  const targetedSurfaceUnavailableReason = presentationHost?.targetedSurfaceUnavailableReason;
  useEffect(() => {
    if (renderTargetedSurface || targetedSurfaceUnavailableReason !== 'unsupported_nested_targeted_surface') return;
    hostApi.diagnostic({
      code: 'unsupported_nested_targeted_surface',
      severity: 'warning',
    });
  }, [hostApi, renderTargetedSurface, targetedSurfaceUnavailableReason]);
  if (!renderTargetedSurface) return <>{fallback}</>;

  return <>{renderTargetedSurface(Object.freeze({
    surface,
    input,
    ...(instanceKey === undefined ? {} : { instanceKey }),
    ...(fallback === undefined ? {} : { fallback }),
  }))}</>;
}
