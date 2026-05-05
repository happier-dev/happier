import type { MaybePromise } from '../engine/contracts.js';

export type AttachSurfaceV1<
  TAttachParams = unknown,
  TAttachResult = unknown,
> = Readonly<{
  attachToSession: (params: TAttachParams) => MaybePromise<TAttachResult>;
}>;
