import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from "zod";

/** Immutable Team identity-connection identifier shared by policy and connection contracts. */
export const TeamIdentityConnectionIdSchema = lazyZodSchema(() => z.string().min(1).max(512));
