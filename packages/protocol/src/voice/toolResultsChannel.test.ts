import { describe, expect, it } from 'vitest';

import {
  formatVoiceToolResultsFollowUp,
  parseVoiceToolResultsFollowUp,
  VOICE_TOOL_RESULT_INSTRUCTIONS_PREFIX,
  VOICE_TOOL_RESULTS_JSON_PREFIX,
} from './toolResultsChannel.js';

describe('voice tool-results follow-up channel', () => {
  it('round-trips a tool-results payload through the canonical wire prefix', () => {
    const payload = {
      toolResults: [
        { t: 'sendSessionMessage', args: { message: 'continue' }, result: { ok: true } },
      ],
    };

    const formatted = formatVoiceToolResultsFollowUp(payload);

    expect(formatted).toBe(`${VOICE_TOOL_RESULTS_JSON_PREFIX}\n${JSON.stringify(payload)}`);
    expect(parseVoiceToolResultsFollowUp(formatted)).toEqual(payload);
  });

  it('parses the payload when a channel-owned instruction line follows it', () => {
    const payload = { toolResults: [{ t: 'listSessions', result: { ok: false } }] };
    const formatted = [
      formatVoiceToolResultsFollowUp(payload),
      `${VOICE_TOOL_RESULT_INSTRUCTIONS_PREFIX} Explain the failure plainly.`,
    ].join('\n');

    expect(parseVoiceToolResultsFollowUp(formatted)).toEqual(payload);
  });

  it('fails closed for non-channel text and malformed JSON', () => {
    expect(parseVoiceToolResultsFollowUp('ordinary user speech')).toBeNull();
    expect(parseVoiceToolResultsFollowUp(`${VOICE_TOOL_RESULTS_JSON_PREFIX}\n{not json}`)).toBeNull();
    expect(parseVoiceToolResultsFollowUp(`${VOICE_TOOL_RESULTS_JSON_PREFIX}\n`)).toBeNull();
  });
});
