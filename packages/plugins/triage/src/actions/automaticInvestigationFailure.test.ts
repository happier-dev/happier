import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { readTriageAutomaticInvestigationChoiceV1 as readTriageIssueAutomaticInvestigationChoiceV1 } from '@happier-dev/triage-sources/runtime';

it.each(['thrown', 'settled'] as const)('keeps the closed refusal and Request ID in the %s automatic investigation notice', async transport => {
  const notice = await readTriageIssueAutomaticInvestigationChoiceV1({ executeAction: async () => {
    if (transport === 'settled') return { ok: false, errorCode: 'machine_unavailable', message: 'private provider content',
      requestId: 'investigation-request', effectAttempted: false };
    throw new PluginError({ code: 'machine_unavailable', message: 'private provider content',
      details: { requestId: 'investigation-request' } });
  } }, 'investigate', { signal: new AbortController().signal });
  expect(notice).toEqual(expect.stringContaining('machine_unavailable'));
  expect(notice).toEqual(expect.stringContaining('investigation-request'));
  expect(notice).not.toEqual(expect.stringContaining('private provider content'));
});
