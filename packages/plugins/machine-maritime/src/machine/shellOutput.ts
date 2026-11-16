import { defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { assertMachineProvisionerGuestCommandSucceeded } from '@happier-dev/plugin-sdk/machine-provisioners';
import { MaritimeNativeError } from './nativeFailure.js';

const outputSchema = defineProtocolObject({ exitCode: defineProtocolNumber({ integer: true }),
  stdoutBase64: defineProtocolString(), stderrBase64: defineProtocolString() }, { policy: 'closed' });

/** Decode the SDK shell envelope once for Maritime's text-only execution APIs. */
export function readMaritimeShellOutput(result: Readonly<{ exitCode: number; stdout: string; stderr: string; truncated?: boolean }>) {
  assertMachineProvisionerGuestCommandSucceeded(result, details => new MaritimeNativeError({ code: 'maritime_guest_command_failed', details }));
  let value: unknown;
  try { value = JSON.parse(result.stdout) as unknown; }
  catch { throw new MaritimeNativeError({ code: 'maritime_execution_unconfirmed' }); }
  const parsed = outputSchema.safeParse(value);
  if (!parsed.success) throw new MaritimeNativeError({ code: 'maritime_execution_unconfirmed' });
  return parsed.data;
}
