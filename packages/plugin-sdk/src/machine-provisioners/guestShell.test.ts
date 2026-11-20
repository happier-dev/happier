import { expect, it } from 'vitest';

import { assertMachineProvisionerGuestCommandSucceeded } from './index.public.js';

it('projects native guest stderr through the public plugin failure boundary', () => {
  const failure = { exitCode: 23, stderr: 'Cannot open /home/example/private/config\nAuthorization: Bearer synthetic-private-token' };
  expect(() => assertMachineProvisionerGuestCommandSucceeded(failure, ({ nativeCause }) =>
    Object.assign(new Error('guest command failed'), { nativeCause }))).toThrow(expect.objectContaining({
      nativeCause: expect.objectContaining({
        localCause: 'native_command_failed',
        command: 'run',
        exitCode: 23,
        stderr: expect.stringMatching(/^Cannot open \[REDACTED_PATH\](?![\s\S]*synthetic-private-token)/u),
      }),
    }));
});
