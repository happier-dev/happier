import type { MaybePromise } from '../engine/contracts.js';

export type SessionHandoffSurfaceV1<
  THandoffParams = unknown,
  THandoffResult = unknown,
> = Readonly<{
  handoffSession: (params: THandoffParams) => MaybePromise<THandoffResult>;
}>;
