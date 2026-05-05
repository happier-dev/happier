import type { MaybePromise } from '../engine/contracts.js';

export type TerminalRuntimeSurfaceV1<
  TLaunchParams = unknown,
  TLaunchResult = unknown,
> = Readonly<{
  launchTerminalRuntime: (params: TLaunchParams) => MaybePromise<TLaunchResult>;
}>;
