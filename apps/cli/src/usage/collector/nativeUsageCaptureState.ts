import { z } from 'zod';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { ExternalSessionsSourceSchema } from '@happier-dev/protocol/sessions/external/sourceCatalog';
import { AgentExternalSessionAccountingObservationSchema, AgentExternalSessionAccountingCoverageSchema } from '@happier-dev/protocol/sessions/external/accounting';
import type { DeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';
import { readProtectedLocalStateFile, writeProtectedLocalStateFileAtomic } from '@/utils/fs/protectedLocalState';

export const NativeUsageCaptureAuthoritySchema = z.object({
    serverId: z.string().min(1), accountId: z.string().min(1), machineId: z.string().min(1),
}).strict();
export type NativeUsageCaptureAuthority = z.infer<typeof NativeUsageCaptureAuthoritySchema>;

const NativeUsagePendingObservationSchema = AgentExternalSessionAccountingObservationSchema.extend({
    projectKey: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
}).strict();

export const NativeUsageCaptureSourceSchema = z.object({
    sourceId: z.string().min(1),
    agent: asHostProtocolZod(PluginContributionIdentityV1Schema),
    source: ExternalSessionsSourceSchema,
    sourceKey: z.string().min(1),
    root: z.string().nullable(),
    rootKind: z.enum(['default', 'configured', 'materialized', 'override']).optional(),
    supported: z.boolean(),
    consented: z.boolean(),
    cursor: z.string().optional(),
    pending: z.array(NativeUsagePendingObservationSchema),
    coverage: AgentExternalSessionAccountingCoverageSchema.optional(),
    asOf: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
}).strict();
export type NativeUsageCaptureSource = z.infer<typeof NativeUsageCaptureSourceSchema>;
export const NativeUsageCaptureStateSchema = z.object({
    v: z.literal(1), authority: NativeUsageCaptureAuthoritySchema,
    sources: z.array(NativeUsageCaptureSourceSchema),
}).strict();
export type NativeUsageCaptureState = z.infer<typeof NativeUsageCaptureStateSchema>;
export type NativeUsageCaptureStore = Readonly<{
    load(): Promise<NativeUsageCaptureState>;
    save(state: NativeUsageCaptureState): Promise<void>;
}>;

export function createNativeUsageCaptureStore(input: Readonly<{
    path: string; authority: NativeUsageCaptureAuthority; storage: DeviceLocalSecretStorage;
}>): NativeUsageCaptureStore {
    function validate(value: unknown): NativeUsageCaptureState {
        const state = NativeUsageCaptureStateSchema.parse(value);
        if (state.authority.serverId !== input.authority.serverId
            || state.authority.accountId !== input.authority.accountId
            || state.authority.machineId !== input.authority.machineId) {
            throw new Error('Native accounting custody authority mismatch');
        }
        return state;
    }
    return {
        async load() {
            let ciphertext: string;
            try {
                ciphertext = await readProtectedLocalStateFile(input.path);
            } catch (error) {
                if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
                    return { v: 1, authority: input.authority, sources: [] };
                }
                throw error;
            }
            const value = input.storage.openJson({ purpose: 'usage_accounting_capture', ciphertext });
            if (value === null) throw new Error('Invalid sealed native accounting custody');
            return validate(value);
        },
        async save(state) {
            const ciphertext = input.storage.sealJson({ purpose: 'usage_accounting_capture', value: validate(state) });
            await writeProtectedLocalStateFileAtomic(input.path, ciphertext);
        },
    };
}
