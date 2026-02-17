import { z } from "zod";

export const ConnectedServiceProfileIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, "Invalid profile id");

