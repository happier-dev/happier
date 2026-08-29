import { describe, expect, it } from 'vitest';

import {
  ANDROID_TERMUX_FORBIDDEN_MODULES,
  ANDROID_TERMUX_REQUIRED_MODULES,
  ANDROID_TERMUX_SOURCE_STRATEGY,
  createAndroidTermuxRendererDiagnostic,
} from './androidTermux';

describe('Android Termux renderer policy', () => {
  it('records the Apache-scoped modules and excludes the GPL app surface', () => {
    expect(ANDROID_TERMUX_REQUIRED_MODULES).toEqual([
      {
        name: 'terminal-view',
        path: 'terminal-view',
        license: 'Apache-2.0',
      },
      {
        name: 'terminal-emulator',
        path: 'terminal-emulator',
        license: 'Apache-2.0',
      },
    ]);

    expect(ANDROID_TERMUX_FORBIDDEN_MODULES).toEqual([
      {
        name: 'app',
        reason: 'The full Termux app is GPL-3.0-only and is out of scope for the native renderer package.',
      },
      {
        name: 'termux-shared',
        reason: 'TERM-6 only approves terminal-view and terminal-emulator until dependency closure review says otherwise.',
      },
    ]);
  });

  it('records the reproducible ignored-source strategy', () => {
    expect(ANDROID_TERMUX_SOURCE_STRATEGY).toEqual({
      kind: 'ignored-source-extract',
      vendorRoot: 'android/termux/vendor',
      metadataFile: 'android/termux/vendor/TERMUX-SOURCE.json',
      fetchScript: 'scripts/fetchTermuxAndroid.mjs',
      gradleConsumesWhenPresent: true,
    });
  });

  it('keeps Android native unavailable until source, packaging, ABI, and crash gates pass', () => {
    expect(createAndroidTermuxRendererDiagnostic()).toEqual({
      availability: {
        available: false,
        reason: 'artifact-missing',
        detail: 'Termux terminal-view/terminal-emulator source is not present in android/termux/vendor.',
      },
      renderer: 'android-termux',
      fallbackRenderer: 'xterm-webview',
      fallbackRequired: true,
      remoteSessionAdapterRequired: true,
      requiredModules: ANDROID_TERMUX_REQUIRED_MODULES,
      forbiddenModules: ANDROID_TERMUX_FORBIDDEN_MODULES,
      blockers: [
        {
          reason: 'artifact-missing',
          detail: 'Termux terminal-view/terminal-emulator source is not present in android/termux/vendor.',
        },
        {
          reason: 'dependency-closure-unapproved',
          detail: 'The selected Termux dependency closure has not been approved.',
        },
        {
          reason: 'renderer-unavailable',
          detail: 'Repeatable Gradle/AAR packaging proof has not passed.',
        },
        {
          reason: 'abi-unsupported',
          detail: 'Android Termux ABI smoke has not passed for the supported ABI matrix.',
        },
        {
          reason: 'renderer-unavailable',
          detail: 'Native renderer crash-to-WebView fallback proof has not passed.',
        },
      ],
    });
  });

  it('reports fallback-required native availability when only the native accessibility model is unproven', () => {
    const diagnostic = createAndroidTermuxRendererDiagnostic({
      dependencyClosureApproved: true,
      artifactsLinked: true,
      gradleBuildProven: true,
      abiSmokePassed: true,
      crashFallbackProven: true,
      moduleVersion: '0.0.0-test',
    });
    expect(diagnostic.availability).toEqual({
      available: true,
      platform: 'android',
      renderer: 'android-termux',
      moduleVersion: '0.0.0-test',
      accessibility: 'fallback-required',
    });
    expect(diagnostic.fallbackRequired).toBe(true);
  });

  it('reports native accessibility only after the Android accessibility model is proven', () => {
    expect(createAndroidTermuxRendererDiagnostic({
      dependencyClosureApproved: true,
      artifactsLinked: true,
      gradleBuildProven: true,
      abiSmokePassed: true,
      crashFallbackProven: true,
      nativeAccessibilityProven: true,
      moduleVersion: '0.0.0-test',
    }).availability).toEqual({
      available: true,
      platform: 'android',
      renderer: 'android-termux',
      moduleVersion: '0.0.0-test',
      accessibility: 'native',
    });
  });
});
