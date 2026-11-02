import { expect, it } from 'vitest';

import { canExecuteSessionRuntimeAction } from './sessionRuntimeActionAdmission';
import type { TrackedSession } from './types';

// Private lifecycle custody fixture: no unrelated bootstrap state is read by admission.
const guest = { bootstrap: { savedSecretOperationContext: { machineAdmission: { role: 'use' } } } } as unknown as
  NonNullable<TrackedSession['requesterSessionRuntimeContext']>;

it.each(['view-source:file:///owner/private.txt', 'chrome://version/', 'devtools://devtools/', 'file:///owner/private.txt', 'about:config', 'data:text/html,private'])
  ('refuses privileged browser navigation for a Use Session: %s', url => {
    expect(canExecuteSessionRuntimeAction({ actionId: 'browser.automation.navigate', input: { payload: { url } } }, () => guest)).toBe(false);
  });

it.each(['https://example.test/', 'http://example.test/', 'about:blank'])('admits ordinary guest pages: %s', url => {
  expect(canExecuteSessionRuntimeAction({ actionId: 'browser.automation.navigate', input: { payload: { url } } }, () => guest)).toBe(true);
});
