import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { resolveGeminiAcpFlagFromHelpProbe } from '../auth/resolution.js';

const HELP_COMMAND = Object.freeze({ toolId: 'gemini-cli', args: Object.freeze(['--help']) });
const ACP_COMMANDS = Object.freeze([
  Object.freeze({ toolId: 'gemini-cli', args: Object.freeze(['--acp']) }),
  Object.freeze({ toolId: 'gemini-cli', args: Object.freeze(['--experimental-acp']) }),
]);

export const GEMINI_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  jsonRpcCommands: Object.freeze([HELP_COMMAND, ...ACP_COMMANDS]),
  async probeCatalogs(context) {
    const flag = await resolveGeminiAcpFlagFromHelpProbe(async () => {
      const result = await context.runDeclaredSystemToolCommand(HELP_COMMAND);
      if (!result.ok) throw new Error('Gemini help probe is unavailable');
      return `${result.stdout}\n${result.stderr}`;
    }, context.signal);
    return await context.probeDeclaredAcpCatalogs({ toolId: 'gemini-cli', args: [flag] });
  },
} satisfies AgentPreflightSessionControlsContributionV1);
