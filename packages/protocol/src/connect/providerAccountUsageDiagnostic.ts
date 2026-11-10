import { z } from '../zodRuntimePolicy.js';
import { containsUnsafeDiagnosticText, isUnsafeDiagnosticHeaderName } from './diagnosticPrivacy.js';

export const ProviderAccountUsageDiagnosticV1Schema = z.strictObject({
    kind: z.enum(['unavailable', 'provider_http', 'runtime_signal', 'projection', 'validation', 'storage', 'unknown']),
    code: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    message: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
    status: z.optional(z.number().check(z.int(), z.minimum(100), z.maximum(599))),
    headers: z.optional(z.record(z.string(), z.string())),
    observedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    retryAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
}).check(z.superRefine((diagnostic, ctx) => {
    if (diagnostic.headers) {
        for (const [headerName, headerValue] of Object.entries(diagnostic.headers)) {
            if (isUnsafeDiagnosticHeaderName(headerName)) {
                ctx.addIssue({ code: "custom",
                    message: 'Unsafe provider account usage diagnostic header', path: ['headers', headerName] });
            }
            if (containsUnsafeDiagnosticText(headerValue)) {
                ctx.addIssue({ code: "custom",
                    message: 'Unsafe provider account usage diagnostic header', path: ['headers', headerName] });
            }
        }
    }
    for (const key of ['code', 'message'] as const) {
        if (containsUnsafeDiagnosticText(diagnostic[key])) {
            ctx.addIssue({ code: "custom",
                message: `Unsafe provider account usage diagnostic ${key}`, path: [key] });
        }
    }
}));

export type ProviderAccountUsageDiagnosticV1 = z.infer<typeof ProviderAccountUsageDiagnosticV1Schema>;
