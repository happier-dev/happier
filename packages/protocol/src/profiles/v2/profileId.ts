import { maxCodeUnits } from '../../strings/maxCodeUnits.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { projectZodProtocolSchema } from '../../plugins/actions/internalProtocolZodAdapter.js';

/** The Launch Profile V2 owner's existing trim and UTF-16 length contract. */
export const LaunchProfileIdV2Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), maxCodeUnits(256)));

/** Retained predecessor identities are exact nonempty strings; new inline V2 authoring keeps its own stricter contract. */
export const ProfileRecordIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1)));

/** Neutral projection of the same parser, for references embedded in Action inputs. */
export const LaunchProfileIdV2ProtocolSchema = projectZodProtocolSchema(LaunchProfileIdV2Schema);
