import { z } from 'zod';

export const SessionStateVendorSessionIdValueSchema = z.string().trim().min(1);
