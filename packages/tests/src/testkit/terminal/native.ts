import type { TerminalAccessibilityGate } from './accessibility';
import type { TerminalBenchmarkReport } from './report';

export type TerminalNativeValidationResult = Readonly<{
  renderer: 'ios-ghosttykit' | 'android-termux';
  embeddedPtyEnabled: boolean;
  byteStreamEnabled: boolean;
  nativeRendererEnabled: boolean;
  platformRendererEnabled: boolean;
  packageAvailable: boolean;
  runtimeAvailable: boolean;
  fallbackAvailable: boolean;
  accessibility: TerminalAccessibilityGate;
  benchmark?: TerminalBenchmarkReport;
}>;

export function shouldSelectNativeTerminalRenderer(result: TerminalNativeValidationResult): boolean {
  return result.embeddedPtyEnabled
    && result.byteStreamEnabled
    && result.nativeRendererEnabled
    && result.platformRendererEnabled
    && result.packageAvailable
    && result.runtimeAvailable
    && result.fallbackAvailable
    && result.accessibility.renderer === result.renderer
    && result.accessibility.state === 'accepted';
}
