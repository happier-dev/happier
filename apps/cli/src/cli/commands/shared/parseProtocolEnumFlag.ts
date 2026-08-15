type ProtocolStringEnumSchema<Value extends string> = Readonly<{
  options: readonly Value[];
  safeParse(value: unknown):
    | Readonly<{ success: true; data: Value }>
    | Readonly<{ success: false }>;
}>;

export function formatProtocolEnumUsage<Value extends string>(
  schema: ProtocolStringEnumSchema<Value>,
): string {
  return schema.options.join('|');
}

function createInvalidArgumentsError(message: string): Error & { code: 'invalid_arguments' } {
  const error = new Error(message) as Error & { code: 'invalid_arguments' };
  error.code = 'invalid_arguments';
  return error;
}

export function parseProtocolEnumFlag<Value extends string>(input: Readonly<{
  flag: string;
  rawValue: string;
  schema: ProtocolStringEnumSchema<Value>;
}>): Value {
  const parsed = input.schema.safeParse(input.rawValue);
  if (parsed.success) return parsed.data;

  throw createInvalidArgumentsError(
    `Invalid ${input.flag} "${input.rawValue}". Expected one of: ${input.schema.options.join(', ')}.`,
  );
}
