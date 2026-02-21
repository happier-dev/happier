// @ts-check

/**
 * @typedef {{
 *   summary: string;
 *   usage: string;
 *   options?: string[];
 *   bullets: string[];
 *   examples: string[];
 * }} CommandHelpSpec
 */

import { COMMAND_HELP_ORCHESTRATORS } from './help-specs/orchestrators.mjs';
import { COMMAND_HELP_CHECKS } from './help-specs/checks.mjs';
import { COMMAND_HELP_NPM } from './help-specs/npm.mjs';
import { COMMAND_HELP_DOCKER } from './help-specs/docker.mjs';
import { COMMAND_HELP_PUBLISH } from './help-specs/publish.mjs';
import { COMMAND_HELP_EXPO } from './help-specs/expo.mjs';
import { COMMAND_HELP_TAURI } from './help-specs/tauri.mjs';
import { COMMAND_HELP_GITHUB } from './help-specs/github.mjs';
import { COMMAND_HELP_RELEASE_INTERNALS } from './help-specs/release-internals.mjs';
import { COMMAND_HELP_MISC } from './help-specs/misc.mjs';

/**
 * NOTE:
 * - Keep specs operator-focused and self-contained.
 * - Prefer listing every supported flag in `options`, even for "advanced" subcommands.
 *
 * @type {Record<string, CommandHelpSpec>}
 */
export const COMMAND_HELP = {
  ...COMMAND_HELP_ORCHESTRATORS,
  ...COMMAND_HELP_CHECKS,
  ...COMMAND_HELP_NPM,
  ...COMMAND_HELP_DOCKER,
  ...COMMAND_HELP_PUBLISH,
  ...COMMAND_HELP_EXPO,
  ...COMMAND_HELP_TAURI,
  ...COMMAND_HELP_GITHUB,
  ...COMMAND_HELP_RELEASE_INTERNALS,
  ...COMMAND_HELP_MISC,
};

