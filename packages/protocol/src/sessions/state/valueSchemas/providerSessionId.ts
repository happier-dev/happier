import { z } from 'zod';

export const SessionStateProviderSessionIdValueSchema = z.string().trim().min(1);
