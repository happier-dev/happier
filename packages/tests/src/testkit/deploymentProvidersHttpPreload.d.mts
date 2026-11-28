export declare function routeDeploymentProviderHttp(
  input: Readonly<{ proxyUrl: string; caPath: string; hosts: readonly string[] }>,
): Promise<() => Promise<void>>;
