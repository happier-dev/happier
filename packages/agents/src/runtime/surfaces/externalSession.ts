import type { MaybePromise } from '../engine/contracts.js';

export type ExternalSessionSurfaceV1<
  TCreateParams = unknown,
  TCreateResult = unknown,
> = Readonly<{
  createExternalSession: (params: TCreateParams) => MaybePromise<TCreateResult>;
}>;
