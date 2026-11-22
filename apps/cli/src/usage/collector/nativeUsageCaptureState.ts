import { z } from 'zod/mini';
import { z as zMini } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { ExternalSessionsSourceSchema } from '@happier-dev/protocol/sessions/external/sourceCatalog';
import { AgentExternalSessionAccountingObservationSchema, AgentExternalSessionAccountingCoverageSchema } from '@happier-dev/protocol/sessions/external/accounting';
import { UsageNativeSessionLinkSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { DeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';
import { readProtectedLocalStateFile, writeProtectedLocalStateFileAtomic } from '@/utils/fs/protectedLocalState';

export const NativeUsageCaptureAuthoritySchema = z.strictObject({
    serverId: z.string().check(z.minLength(1)), accountId: z.string().check(z.minLength(1)), machineId: z.string().check(z.minLength(1)),
});
export type NativeUsageCaptureAuthority = z.infer<typeof NativeUsageCaptureAuthoritySchema>;

const NativeUsagePendingObservationSchema = (<T extends z.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(zMini.safeExtend(AgentExternalSessionAccountingObservationSchema, {
    projectKey: z.optional(z.string().check(z.minLength(1))),
    workspaceId: z.optional(z.string().check(z.minLength(1))),
}));

export const NativeUsageCaptureSourceSchema = z.strictObject({
    sourceId: z.string().check(z.minLength(1)),
    accountingSources: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
    agent: asHostProtocolZod(PluginContributionIdentityV1Schema),
    source: ExternalSessionsSourceSchema,
    sourceKey: z.string().check(z.minLength(1)),
    root: z.nullable(z.string()),
    rootKind: z.optional(z.enum(['default', 'configured', 'materialized', 'override'])),
    supported: z.boolean(),
    consented: z.boolean(),
    cursor: z.optional(z.string()),
    pending: z.array(NativeUsagePendingObservationSchema),
    threadLinks: z.optional(z.record(z.string(), z.nullable(asHostProtocolZod(UsageNativeSessionLinkSchema)))),
    coverage: z.optional(AgentExternalSessionAccountingCoverageSchema),
    asOf: z.optional(z.number().check(z.int(), z.nonnegative())),
    error: z.optional(z.string()),
});
export type NativeUsageCaptureSource = z.infer<typeof NativeUsageCaptureSourceSchema>;
export const NativeUsageCaptureStateSchema = z.strictObject({
    v: z.literal(1), authority: NativeUsageCaptureAuthoritySchema,
    sources: z.array(NativeUsageCaptureSourceSchema),
});
export type NativeUsageCaptureState = z.infer<typeof NativeUsageCaptureStateSchema>;
const StoredNativeUsageCaptureStateSchema = createStoredReadSchema(NativeUsageCaptureStateSchema);
export type NativeUsageCaptureStore = Readonly<{
    load(): Promise<NativeUsageCaptureState>;
    save(state: NativeUsageCaptureState): Promise<void>;
}>;

export function createNativeUsageCaptureStore(input: Readonly<{
    path: string; authority: NativeUsageCaptureAuthority; storage: DeviceLocalSecretStorage;
}>): NativeUsageCaptureStore {
    function validate(state: NativeUsageCaptureState): NativeUsageCaptureState {
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
            return validate(StoredNativeUsageCaptureStateSchema.parse(value));
        },
        async save(state) {
            const ciphertext = input.storage.sealJson({ purpose: 'usage_accounting_capture', value: validate(NativeUsageCaptureStateSchema.parse(state)) });
            await writeProtectedLocalStateFileAtomic(input.path, ciphertext);
        },
    };
}
