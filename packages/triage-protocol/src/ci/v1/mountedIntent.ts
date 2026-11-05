import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { ForgeCiIdV1Schema, ForgeCiJobRefV1Schema, ForgeCiRunRefV1Schema, ForgeCiSelectionV1Schema, ForgeCiStepRefV1Schema } from './identity.js';
import { ForgeCiBooleanV1Schema, ForgeCiRunFiltersV1Schema } from './runs.js';
import { ForgeCiTriggerValuesV1Schema } from './triggers.js';

const closed = { policy: 'closed' } as const;
export const ForgeCiMountedIntentOperationV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('selectView'), view: defineProtocolUnion([defineProtocolLiteral('runs'), defineProtocolLiteral('workflows')]) }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('selectWorkflow'), workflowId: ForgeCiIdV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('selectRun'), run: ForgeCiRunRefV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('selectAttempt'), selection: ForgeCiSelectionV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('selectJob'), job: ForgeCiJobRefV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('selectStep'), step: ForgeCiStepRefV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('setFilters'), filters: ForgeCiRunFiltersV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('setRunScope'), scope: defineProtocolUnion([defineProtocolLiteral('all'), defineProtocolLiteral('active'), defineProtocolLiteral('failed')]) }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('setQuery'), query: defineProtocolString() }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('setJobsView'), view: defineProtocolUnion([defineProtocolLiteral('graph'), defineProtocolLiteral('list')]) }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('setAnnotationsExpanded'), expanded: ForgeCiBooleanV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('setLogFilter'), filter: defineProtocolUnion([defineProtocolLiteral('all'), defineProtocolLiteral('failed')]) }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('setTailLines'), lines: defineProtocolNumber({ integer: true, minimum: 1 }).nullable() }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('setGroupExpanded'), groupId: ForgeCiIdV1Schema, expanded: ForgeCiBooleanV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('revealLine'), line: defineProtocolNumber({ integer: true, minimum: 1 }) }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('setTriggerRef'), ref: ForgeCiIdV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('setTriggerDraft'), values: ForgeCiTriggerValuesV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('setTriggerFormOpen'), open: ForgeCiBooleanV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('loadTriggerEnvironments'), cursor: defineProtocolString({ minLength: 1 }) }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('setTimestampsVisible'), visible: ForgeCiBooleanV1Schema }, closed),
]);
export type ForgeCiMountedIntentOperationV1 = ReturnType<typeof ForgeCiMountedIntentOperationV1Schema.parse>;
export const ForgeCiMountedIntentInputV1Schema = defineProtocolObject({ mountId: ForgeCiIdV1Schema, operation: ForgeCiMountedIntentOperationV1Schema }, closed);
export type ForgeCiMountedIntentInputV1 = ReturnType<typeof ForgeCiMountedIntentInputV1Schema.parse>;
export const ForgeCiMountedIntentResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ status: defineProtocolLiteral('applied') }, closed),
    defineProtocolObject({ status: defineProtocolLiteral('unavailable') }, closed),
    defineProtocolObject({ status: defineProtocolLiteral('rejected') }, closed),
]);
export type ForgeCiMountedIntentResultV1 = ReturnType<typeof ForgeCiMountedIntentResultV1Schema.parse>;
