import { TeamErrorV1Schema, TeamGroupLabelEnvelopeWorkV1Schema, TeamGroupLabelEnvelopeRepairsV1Schema } from '@happier-dev/protocol/teams';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createPrivateLabelClientForActionAccountContext } from '@/sync/ops/privateLabels/privateLabelClient';
import { teamGroupLabelBinding } from './teamGroupLabels';

/** One captured Account owns discovery, local key opening and recipient-only publication. */
export async function repairTeamGroupLabelEnvelopes(serverId: string): Promise<void> {
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const response = await account.request('/v2/teams/groups/label-envelopes', { method: 'GET' }, { retry: 'none' });
        // An unavailable optional Teams capability never blocks ordinary Account sync.
        if (!response.ok) {
            if (response.status === 404 || response.status === 403) return;
            const failure = TeamErrorV1Schema.safeParse(await response.json().catch(() => null));
            throw new Error(failure.success ? failure.data.error : `team_label_envelope_read_http_${response.status}`);
        }
        const work = TeamGroupLabelEnvelopeWorkV1Schema.parse(await response.json());
        const client = createPrivateLabelClientForActionAccountContext(account);
        for (const team of work.teams) {
            const labels: ReturnType<typeof TeamGroupLabelEnvelopeRepairsV1Schema.parse>['labels'] = [];
            for (const item of team.labels) {
                const label = await client.rewrap({ binding: teamGroupLabelBinding(item.groupId, item.field),
                    label: item.label, recipients: team.recipients });
                if (label) labels.push({ groupId: item.groupId, field: item.field, label });
            }
            if (!labels.length) continue;
            const published = await account.request('/v2/teams/groups/label-envelopes', {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(TeamGroupLabelEnvelopeRepairsV1Schema.parse({ teamId: team.teamId, labels })),
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
