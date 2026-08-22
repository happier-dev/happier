import { z } from 'zod';

type HostProtocolSchema<TValue> = Readonly<{
    safeParse(value: unknown):
        | Readonly<{ success: true; data: TValue }>
        | Readonly<{ success: false }>;
}>;

/**
 * CLI-private bridge for host grammars that still compose with Zod.
 * Parsing and normalization remain owned by the public validator-neutral
 * Protocol value; this adapter adds no second schema semantics.
 */
export function asHostProtocolZod<TValue>(schema: HostProtocolSchema<TValue>): z.ZodType<TValue> {
    return z.unknown().transform((value, context): TValue => {
        const parsed = schema.safeParse(value);
        if (parsed.success) return parsed.data;
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Value does not match the canonical Protocol schema.',
        });
        return z.NEVER as TValue;
    });
}
