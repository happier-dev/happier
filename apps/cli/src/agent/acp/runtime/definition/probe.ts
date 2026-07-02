import type { AcpRuntimeDefinitionBridgeV1 } from './_types';
import type { AcpExecutableLaunch } from './launch';
import { resolveAcpRuntimeLaunch } from './launch';
import { createAcpTransportHandlerFromDefinition } from './transport';

export type AcpRuntimeDefinitionProbeLaunchV1 = Readonly<{
  definition: ReturnType<AcpRuntimeDefinitionBridgeV1['createDefinition']>;
  launch: AcpExecutableLaunch;
  transport: ReturnType<typeof createAcpTransportHandlerFromDefinition>;
}>;

export async function resolveAcpRuntimeDefinitionProbeLaunch(params: Readonly<{
  bridge: AcpRuntimeDefinitionBridgeV1;
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
}>): Promise<AcpRuntimeDefinitionProbeLaunchV1> {
  const definition = params.bridge.createDefinition({
    cwd: params.cwd,
    ...(params.env ? { env: params.env } : {}),
  });
  const launch = await resolveAcpRuntimeLaunch({
    definition,
    cwd: params.cwd,
    ...(params.env ? { env: params.env } : {}),
    exec: params.bridge.exec,
  });
  return {
    definition,
    launch,
    transport: createAcpTransportHandlerFromDefinition(definition),
  };
}
