import { describe, expect, it } from 'vitest';

import {
  PI_REQUEST_AUTH_MINIMUM_VERSION,
  resolvePiRequestAuthCompatibility,
} from './requestAuthCompatibility.js';

describe('resolvePiRequestAuthCompatibility', () => {
  it.each([
    ['0.81.0', '0.81.0'],
    ['pi 0.81.1', '0.81.1'],
    ['0.82.0', '0.82.0'],
    ['pi 0.82.1', '0.82.1'],
    ['v0.82.1', '0.82.1'],
    ['pi 0.82.2', '0.82.2'],
    ['pi 0.82.1+fork.7', '0.82.1+fork.7'],
    ['pi 0.82.1+Fork-7.SHA', '0.82.1+Fork-7.SHA'],
    ['pi-coding-agent/1.0.0 (darwin-arm64)', '1.0.0'],
  ])('accepts supported Pi output %s', (output, version) => {
    expect(resolvePiRequestAuthCompatibility(output)).toEqual({
      supported: true,
      version,
    });
  });

  it.each([
    ['0.80.10', '0.80.10'],
    ['pi 0.74.2', '0.74.2'],
    ['0.81.0-preview.1', '0.81.0-preview.1'],
    ['0.81.1-rc.1', '0.81.1-rc.1'],
    ['0.82.0-preview.1', '0.82.0-preview.1'],
    ['1.0.0-beta.1', '1.0.0-beta.1'],
  ])('rejects prerelease Pi output or a version below the complete Provider seam %s', (output, version) => {
    expect(resolvePiRequestAuthCompatibility(output)).toEqual({
      supported: false,
      reason: 'version_too_old',
      version,
      minimumVersion: PI_REQUEST_AUTH_MINIMUM_VERSION,
    });
  });

  it.each([
    '',
    'pi unknown',
    'version: 0.81',
    'v0.81.0.1',
    'pi 0.81.0beta',
    'x0.81.0',
    '0.81.0-',
    '00.82.1',
    '0.082.1',
    '0.82.01',
    '0.82.1_rc.1',
    '0.82.1~rc1',
    '0.82.1@rc1',
    '0.82.1/rc1',
    '0.82.1+fork..7',
    '0.82.1+fork.',
    '0.82.1+fork_7',
    'node 22.0.0\npi 0.75.5',
  ])(
    'fails closed when Pi output is not a supported semantic version: %s',
    (output) => {
      expect(resolvePiRequestAuthCompatibility(output)).toEqual({
        supported: false,
        reason: 'version_unreadable',
        minimumVersion: PI_REQUEST_AUTH_MINIMUM_VERSION,
      });
    },
  );
});
