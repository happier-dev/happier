import { stripVTControlCharacters } from 'node:util';

import { createCliAccountKvJsonTransport } from '@/api/client/accountKvJsonTransport';
import type { StoredCredentials } from '@/persistence';
import { recordRequesterMachineNotice, requesterMachineNoticeEnglish, requesterMachineNoticeKey } from '@happier-dev/protocol/machines/managed/requesterMachineNotice';

/** Runs independently of credential delivery. A failed notice leaves the Action free to finish. */
export function reportRequesterMachineUse(input: Readonly<{
    credentials: StoredCredentials;
    serverBaseUrl: string;
    machineId: string;
    machineLabel?: string;
    /** Display name from Home's Machine access record, when available. */
    owner?: string | null;
    surface: 'cli' | 'agent';
}>): void {
    void (async () => {
        const { compareAndSet } = createCliAccountKvJsonTransport({
            credentials: input.credentials,
            serverBaseUrl: input.serverBaseUrl,
            key: requesterMachineNoticeKey(input.machineId),
            resolveAuthorizationHeaders: () => ({ Authorization: `Bearer ${input.credentials.token}` }),
        });
        const claimed = await recordRequesterMachineNotice(compareAndSet, input.surface === 'agent');
        if (!claimed) return;
        const machine = input.machineLabel || input.machineId;
        const title = input.owner
            ? requesterMachineNoticeEnglish.runsOn({ owner: input.owner, machine })
            : requesterMachineNoticeEnglish.runsOnSomeoneElses({ machine });
        const terminalTitle = stripVTControlCharacters(title).replace(/\p{Cc}/gu, ' ');
        process.stderr.write(`${terminalTitle}. ${requesterMachineNoticeEnglish.toldOnce}\n`);
    })().catch(() => { /* The notice is best effort and independent of the Action. */ });
}
