export type McpServersCommandErrorCode = 'invalid_arguments';

export function createMcpServersCommandError(
  code: McpServersCommandErrorCode,
  message: string,
): Error & { code: McpServersCommandErrorCode } {
  const error = new Error(message) as Error & { code: McpServersCommandErrorCode };
  error.code = code;
  return error;
}

export function createInvalidArgumentsError(message: string): Error & { code: 'invalid_arguments' } {
  return createMcpServersCommandError('invalid_arguments', message) as Error & { code: 'invalid_arguments' };
}
