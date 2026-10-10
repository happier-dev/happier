import {
  WORKSPACE_EXECUTION_CONFIG_ROUTE_V1,
  WorkspaceExecutionConfigListResponseV1Schema,
  WorkspaceExecutionConfigReadRequestV1Schema,
  WorkspaceExecutionConfigMutationRequestV1Schema,
} from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import type { WorkspaceExecutionConfigTransportV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';

/** A captured Home request carries authentication, cancellation and endpoint lifetime. */
export function createWorkspaceExecutionConfigApiV1(options: Readonly<{
  request(path: string, init?: RequestInit): Promise<Response>;
}>) {
  async function request(path: string, body?: unknown): Promise<unknown> {
    const response = await options.request(path, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok && response.status !== 409) throw new Error(`workspace_execution_config_http_${response.status}`);
    return await response.json();
  }
  return {
    list: async () => WorkspaceExecutionConfigListResponseV1Schema.parse(await request(WORKSPACE_EXECUTION_CONFIG_ROUTE_V1)),
    read: async (input) => await request(`${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`, WorkspaceExecutionConfigReadRequestV1Schema.parse(input)),
    mutate: async (input) => await request(`${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/mutate`, WorkspaceExecutionConfigMutationRequestV1Schema.parse(input)),
  } satisfies WorkspaceExecutionConfigTransportV1 & { list(): Promise<ReturnType<typeof WorkspaceExecutionConfigListResponseV1Schema.parse>> };
}
