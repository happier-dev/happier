import { TeamErrorV1Schema, TeamLabelEnvelopeWorkV1Schema, TeamLabelEnvelopeRepairsV1Schema, type TeamLabelEnvelopeRepairsV1 } from '@happier-dev/protocol/teams';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createPrivateLabelClientForActionAccountContext } from '@/sync/ops/privateLabels/privateLabelClient';

/**
 * One captured Account owns discovery, local key opening and recipient-only publication for every
 * Team-audience label (Group names/descriptions, credential display names, External API key labels,
 * Team Pool names/descriptions). The server-supplied binding is the label's authenticated cipher
 * identity, so a wrong binding cannot open and nothing is published for it.
 */
export async function repairTeamLabelEnvelopes(serverId: string): Promise<void> {
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const response = await account.request('/v2/teams/label-envelopes', { method: 'GET' }, { retry: 'none' });
        // An unavailable optional Teams capability never blocks ordinary Account sync.
        if (!response.ok) {
            if (response.status === 404 || response.status === 403) return;
            const failure = TeamErrorV1Schema.safeParse(await response.json().catch(() => null));
            throw new Error(failure.success ? failure.data.error : `team_label_envelope_read_http_${response.status}`);
        }
        const work = TeamLabelEnvelopeWorkV1Schema.parse(await response.json());
        const client = createPrivateLabelClientForActionAccountContext(account);
        for (const team of work.teams) {
            const labels: TeamLabelEnvelopeRepairsV1['labels'] = [];
            for (const item of team.labels) {
                const label = await client.rewrap({ binding: item.binding, label: item.label, recipients: item.recipients });
                if (label) labels.push({ binding: item.binding, label });
            }
            if (!labels.length) continue;
            const published = await account.request('/v2/teams/label-envelopes', {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(TeamLabelEnvelopeRepairsV1Schema.parse({ teamId: team.teamId, labels })),
            }, { retry: 'none' });
            if (!published.ok) {
                const failure = TeamErrorV1Schema.safeParse(await published.json().catch(() => null));
                throw new Error(failure.success ? failure.data.error : `team_label_envelope_write_http_${published.status}`);
            }
        }
    } finally {
        account.dispose();
    }
}
