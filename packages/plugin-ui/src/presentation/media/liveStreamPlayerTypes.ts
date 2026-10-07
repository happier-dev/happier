import type * as React from 'react';

import type { HappierLiveStreamOrientation } from './inputGesture.js';

/** A display projection, not a capture connection or decoder handle. */
export type HappierLiveStreamPlayerDisplayState = Readonly<{
  phase: 'idle' | 'opening' | 'playing' | 'degraded' | 'reconnecting' | 'error' | 'stopped';
  selectedCodec: string | null;
  activeRenderer: string | null;
  lastFrameUrl?: string;
  diagnostic?: Readonly<{ reasonCode: string }>;
}>;

export type HappierLiveStreamPlayerDiagnostic = Readonly<{ reasonCode: string }>;
export type HappierLiveStreamPlayerRenderEvent = Readonly<{
  type: 'decoderReconfigured';
  width?: number;
  height?: number;
  orientation?: HappierLiveStreamOrientation;
}>;
export type HappierLiveStreamPlayerRendererEvent =
  | Readonly<{ type: 'frame_decoded' }>
  | Readonly<{ type: 'decoder_error' | 'error'; reasonCode: string }>
  | Readonly<{ type: 'decoder_reconfigured'; width?: number; height?: number; orientation?: HappierLiveStreamOrientation }>;

/** Decoder inputs remain host-owned; presentation only replaces its display callbacks. */
export type HappierLiveStreamAvccInput = Readonly<{
  onDiagnostic?: (diagnostic: HappierLiveStreamPlayerDiagnostic) => void;
  onDecoded?: () => void;
  onReconfigured?: (event: HappierLiveStreamPlayerRenderEvent) => void;
}>;

export type HappierLiveStreamPlayerHost<State extends HappierLiveStreamPlayerDisplayState, Avcc extends HappierLiveStreamAvccInput> = Readonly<{
  reduceDisplayState: (state: State, event: HappierLiveStreamPlayerRendererEvent) => State;
  renderRoot: (children: React.ReactNode, input: Readonly<{ testID: string }>) => React.ReactNode;
  renderSurface: (children: React.ReactNode) => React.ReactNode;
  renderImage: (input: Readonly<{ frameUrl: string; testID: string }>) => React.ReactNode;
  renderAvcc: (input: Avcc & Readonly<{ testID: string }>) => React.ReactNode;
  renderFallback: (input: Readonly<{ kind?: 'loading' | 'unavailable'; reasonCode?: string; testID: string }>) => React.ReactNode;
  renderDiagnostics: (input: Readonly<{ phase: State['phase']; preservingLastFrame: boolean; reasonCode?: string; testID: string }>) => React.ReactNode;
}>;
