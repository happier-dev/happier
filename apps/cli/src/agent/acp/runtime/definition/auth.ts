import type { AcpRuntimeDefinition } from './_types';

function readStaticAuthMethodId(definition: AcpRuntimeDefinition): string | undefined {
  const methodId = typeof definition.auth?.methodId === 'string'
    ? definition.auth.methodId.trim()
    : '';
  return methodId.length > 0 ? methodId : undefined;
}

export function resolveAcpAuthMethodId(params: Readonly<{
  definition: AcpRuntimeDefinition;
}>): string | undefined {
  return readStaticAuthMethodId(params.definition);
}
