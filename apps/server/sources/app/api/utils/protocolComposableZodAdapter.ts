import { z } from "zod";

type ServerProtocolSchema<TValue> = Readonly<{
    safeParse(value: unknown):
        | Readonly<{ success: true; data: TValue }>
        | Readonly<{ success: false }>;
}>;

/**
 * Server-private bridge for Fastify grammars that still compose with Zod.
 * Parsing and normalization remain owned by the validator-neutral Protocol
 * value; this adapter adds no second schema semantics.
 */
export function asServerProtocolZod<TValue>(schema: ServerProtocolSchema<TValue>): z.ZodType<TValue> {
    return z.unknown().transform((value, context): TValue => {
        const parsed = schema.safeParse(value);
        if (parsed.success) return parsed.data;
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Value does not match the canonical Protocol schema.",
        });
        return z.NEVER as TValue;
    });
}
