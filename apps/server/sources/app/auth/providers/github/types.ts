import { z } from "zod";

export const GitHubProfileSchema = z.object({
    id: z.number(),
    login: z.string(),
    avatar_url: z.string().optional(),
    name: z.string().nullable().optional(),
}).passthrough();

export type GitHubProfile = z.infer<typeof GitHubProfileSchema>;

