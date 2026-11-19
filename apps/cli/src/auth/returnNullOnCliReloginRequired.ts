import { CliReloginRequiredError } from '@/persistence';

/** For consumers that can proceed signed out. Preserve other credential failures. */
export function returnNullOnCliReloginRequired(error: unknown): null {
  if (error instanceof CliReloginRequiredError) return null;
  throw error;
}
