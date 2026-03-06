import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CODEX_PROVIDER_SETTINGS_DEFAULTS,
  buildCodexProviderSettingsShape,
} from './codex';

describe('codex provider settings shape/default parity', () => {
  it('includes codexMcpResumeInstallSpec in both shape and defaults', () => {
    const shape = buildCodexProviderSettingsShape(z);

    expect(shape).toHaveProperty('codexMcpResumeInstallSpec');
    expect(CODEX_PROVIDER_SETTINGS_DEFAULTS).toHaveProperty('codexMcpResumeInstallSpec', '');
  });
});

