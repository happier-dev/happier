import { z } from '../../zodRuntimePolicy.js';

/** The authenticated Account identity projected onto a historical message actor. */
export const SessionMessageActorAccountIdV1Schema = z.string().check(z.trim(), z.minLength(1), z.maxLength(191));
