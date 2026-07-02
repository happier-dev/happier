import type {
  ExecSystemToolServiceV1,
  SystemToolLaunchGrantV1,
} from '@happier-dev/plugin-sdk';

export type ResolveDeepSecExecutableParams = Readonly<{
  systemTools: ExecSystemToolServiceV1;
  cwd: string;
  preferredExecutablePath?: string | null;
  signal?: AbortSignal;
}>;

export function resolveDeepSecExecutable(
  params: ResolveDeepSecExecutableParams,
): Promise<SystemToolLaunchGrantV1> {
  return params.systemTools.resolve({
    toolId: 'deepsec',
    purpose: 'review security findings',
    cwd: params.cwd,
    preferredPath: params.preferredExecutablePath,
    signal: params.signal,
  });
}
