// @ts-check
import { defineConfig } from '@playwright/test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import baseConfig from './playwright.ui.config.mjs';
import {
  buildVoicePlaywrightProjects,
  resolveVoicePlaywrightFixturePath,
} from './scripts/playwrightVoiceProjects.shared.mjs';

const fixturePath = resolveVoicePlaywrightFixturePath({
  configuredPath: process.env.HAPPIER_E2E_VOICE_WAV,
  configDir: dirname(fileURLToPath(import.meta.url)),
  cwd: process.cwd(),
});

export default defineConfig(baseConfig, {
  projects: buildVoicePlaywrightProjects({
    fixturePath,
    browserChannel: process.env.HAPPIER_E2E_BROWSER_CHANNEL,
  }),
});
