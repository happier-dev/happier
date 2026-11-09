import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { waitForNetworkResponseForTests } from './runtimeFetch';

/**
 * A fixture's answer at the level a projection reader sees it: what
 * `machineContributionRegistryProjectionDescribe` resolves with.
 */
export type MachineProjectionDescribeAnswer =
    | Readonly<{ supported: true } & Readonly<Record<string, unknown>>>
    | Readonly<{ supported: false; reason: string }>;

type MachineRpcParams = Readonly<{
    machineId: string;
    serverId?: string | null;
    method: string;
    signal?: AbortSignal;
}>;

/**
 * The machine-RPC boundary for projection tests.
 *
 * Suites must not mock `@/sync/ops/machineContributionRegistryProjection`
 * itself: it sits inside the app-wide sync import cycle, so the per-machine
 * projection owner can bind the real module before the mock applies. Mock
 * `machineRpcWithServerScope` with this adapter instead; the real transport,
 * owner and readers then run, and the fixture still answers at reader level.
 */
export function answerMachineProjectionDescribeAtRpcBoundary(
    readAnswer: (
        machineId: string,
        options: Readonly<{ serverId: string | null }>,
    ) => Promise<MachineProjectionDescribeAnswer> | MachineProjectionDescribeAnswer,
) {
    return async (params: MachineRpcParams): Promise<unknown> => {
        if (params.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            throw new Error(`Unexpected machine RPC in projection test: ${params.method}`);
        }
        const answer = await waitForNetworkResponseForTests(
            Promise.resolve(readAnswer(params.machineId, { serverId: params.serverId ?? null })), params.signal,
        );
        if (answer.supported) {
            const { supported: _supported, ...siblings } = answer;
            return { protocolVersion: 1, ...siblings };
        }
        if (answer.reason === 'not-supported') {
            return { errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' };
        }
        throw Object.assign(new Error('machine rpc failed'), {
            code: answer.reason === 'timeout' ? 'MACHINE_RPC_TIMEOUT' : 'MACHINE_RPC_FAILED',
        });
    };
}
