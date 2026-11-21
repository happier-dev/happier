import {
    MachinePresetActionInputSchemasV1, MachinePresetActionOutputSchemasV1,
} from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import {
    MACHINE_PRESET_OWED_RECIPIENT_CENSUS_PATH_V1, ManagedMachinePresetOwedRecipientCensusesV1Schema,
    type ManagedMachinePresetV1, type ManagedMachinePresetOwedRecipientCensusesV1, type ManagedMachinePresetRecipientCensusResultV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { rewrapManagedMachinePresetRecipientsV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { prepareOwedResourceRecipientKeysV1 } from '@happier-dev/protocol/teams/resourceRecipientKeyPreparationV1';

import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getRandomBytes } from '@/platform/cryptoRandom';

import { createManagedMachinePresetReadCustodyV1, type ManagedMachinePresetE2eeCustodyV1 } from './managedMachinePresetCustody';

function sameRecipientEnvelopes(left: Readonly<ManagedMachinePresetV1['recipients']>, right: Readonly<ManagedMachinePresetV1['recipients']>) {
    return left.length === right.length && left.every((recipient, index) => recipient.accountId === right[index]?.accountId
        && JSON.stringify(recipient.envelope) === JSON.stringify(right[index]?.envelope));
}

type PresetRecipientRepair = Pick<ManagedMachinePresetOwedRecipientCensusesV1['items'][number], 'homeId' | 'id' | 'expectedRevision' | 'recipients'>
    & Readonly<{ census: Extract<ManagedMachinePresetRecipientCensusResultV1, { kind: 'ready' }> }>;

export async function commitMachinePresetRecipientRepair(scope: ServerAccountScope, raw: PresetRecipientRepair,
    key: ManagedMachinePresetE2eeCustodyV1, signal?: AbortSignal): Promise<ManagedMachinePresetV1 | null> {
    const { census } = raw;
    const rawRecipientIds = new Set(raw.recipients.map(recipient => recipient.accountId));
    const censusRecipientIds = new Set(census.recipients.map(recipient => recipient.account.accountId));
    const audienceIsPreparedAndCurrent = rawRecipientIds.size === raw.recipients.length
        && censusRecipientIds.size === census.recipients.length
        && rawRecipientIds.size === censusRecipientIds.size
        && census.recipients.every(recipient => recipient.envelopeStatus === 'prepared'
            && rawRecipientIds.has(recipient.account.accountId));
    if (audienceIsPreparedAndCurrent) return null;
    const recipients = key.withAccountKey(({ accountId, accountKey }) => rewrapManagedMachinePresetRecipientsV1({
        recipients: raw.recipients, accountId, accountKey, recipientCensus: [...census.recipients], randomBytes: getRandomBytes,
    }));
    if (!recipients || sameRecipientEnvelopes(raw.recipients, recipients)) return null;
    const input = MachinePresetActionInputSchemasV1['machines.presets.update'].safeParse({
        homeId: raw.homeId, id: raw.id, expectedRevision: raw.expectedRevision, patch: { recipients },
    });
    if (!input.success) return null;
    try {
        const outcome = classifyHomeActionOutcome(await scopedHomeActionExecutor(scope)('machines.presets.update', input.data, {
            surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId, ...(signal ? { signal } : {}),
        }), 'machines.presets.update');
        if (outcome.kind !== 'completed') return null;
        const result = MachinePresetActionOutputSchemasV1['machines.presets.update'].safeParse(outcome.result);
        return result.success && result.data.kind === 'saved' ? result.data.preset : null;
    } catch {
        // A later keyholder read retries through the same owner.
        return null;
    }
}

/** Use the existing recipient-only preset CAS from the Account recipient-delivery wake. */
export async function prepareOwedMachinePresetKeys(scope: ServerAccountScope, signal?: AbortSignal): Promise<void> {
    const account = await captureLazyActionAccountContext(scope.serverId, signal);
    const custody = createManagedMachinePresetReadCustodyV1({ account, expectedAccountId: scope.accountId, signal });
    try {
        if (!custody) return;
        await prepareOwedResourceRecipientKeysV1<ManagedMachinePresetOwedRecipientCensusesV1['items'][number]>({
            signal,
            readOwedPage: async () => {
                const response = await account.request(MACHINE_PRESET_OWED_RECIPIENT_CENSUS_PATH_V1, { method: 'GET', signal }, { retry: 'none' });
                if (!response.ok) throw new Error('preset_recipient_work_unavailable');
                const { items } = ManagedMachinePresetOwedRecipientCensusesV1Schema.parse(await response.json());
                return { items, nextCursor: null };
            },
            prepare: async item => {
                account.assertCurrent();
                if (item.homeId !== account.serverIdentityId) return;
                const key = await custody.open('e2ee');
                if (key?.mode === 'e2ee') await commitMachinePresetRecipientRepair(scope, item, key, signal);
            },
        });
    } finally {
        try { await custody?.dispose(); } finally { account.dispose(); }
    }
}
