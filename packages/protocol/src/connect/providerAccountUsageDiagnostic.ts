import { z } from 'zod';
import { containsUnsafeDiagnosticText, isUnsafeDiagnosticHeaderName } from './diagnosticPrivacy.js';

export const ProviderAccountUsageDiagnosticV1Schema = z.object({
    kind: z.enum(['unavailable', 'provider_http', 'runtime_signal', 'projection', 'validation', 'storage', 'unknown']),
    code: z.string().trim().min(1).max(128).optional(),
    message: z.string().trim().min(1).max(512).optional(),
    status: z.number().int().min(100).max(599).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    observedAtMs: z.number().int().nonnegative().optional(),
    retryAtMs: z.number().int().nonnegative().optional(),
}).strict().superRefine((diagnostic, ctx) => {
    if (diagnostic.headers) {
        for (const [headerName, headerValue] of Object.entries(diagnostic.headers)) {
            if (isUnsafeDiagnosticHeaderName(headerName)) {
                ctx.addIssue({ code: z.ZodIssueCode.custom,
                    message: 'Unsafe provider account usage diagnostic header', path: ['headers', headerName] });
            }
            if (containsUnsafeDiagnosticText(headerValue)) {
                ctx.addIssue({ code: z.ZodIssueCode.custom,
                    message: 'Unsafe provider account usage diagnostic header', path: ['headers', headerName] });
            }
        }
    }
    for (const key of ['code', 'message'] as const) {
        if (containsUnsafeDiagnosticText(diagnostic[key])) {
            ctx.addIssue({ code: z.ZodIssueCode.custom,
                message: `Unsafe provider account usage diagnostic ${key}`, path: [key] });
        }
    }
});

export type ProviderAccountUsageDiagnosticV1 = z.infer<typeof ProviderAccountUsageDiagnosticV1Schema>;
