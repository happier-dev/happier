export function normalizeCodexHome(value: unknown): 'user' | 'connectedService' | null {
  return value === 'user' || value === 'connectedService' ? value : null;
}

export function normalizeCodexConnectedServiceFields(params: Readonly<{
  home: 'user' | 'connectedService' | null;
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  homePath: string | null;
}>): Readonly<{
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  homePath: string | null;
}> {
  if (params.home === 'connectedService') {
    return {
      connectedServiceId: params.connectedServiceId,
      connectedServiceProfileId: params.connectedServiceProfileId,
      homePath: params.homePath,
    };
  }
  return {
    connectedServiceId: null,
    connectedServiceProfileId: null,
    homePath: params.homePath,
  };
}
