import {
    SubagentCommandV1Schema,
    resolveSubagentLaunchStructuredSend,
    type SubagentCommandV1,
    type SubagentLaunchV1,
} from '@happier-dev/protocol';

type ResolveSubagentStructuredSendParams =
    | Readonly<{
        envelopeKind: 'subagent_launch.v1';
        payload: SubagentLaunchV1;
    }>
    | Readonly<{
        envelopeKind: 'subagent_command.v1';
        payload: SubagentCommandV1;
    }>;

function describeCommand(payload: SubagentCommandV1): string {
    if (payload.kind === 'agent_team_delete') {
        return `Delete team ${payload.teamId}`;
    }
    return `Shutdown teammate ${payload.memberLabel ?? payload.memberId} · ${payload.teamId}`;
}

export function resolveSubagentStructuredSend(params: ResolveSubagentStructuredSendParams): Readonly<{
    text: string;
    displayText: string;
    metaOverrides: Readonly<{
        happier: Readonly<{
            kind: 'subagent_launch.v1' | 'subagent_command.v1';
            payload: SubagentLaunchV1 | SubagentCommandV1;
        }>;
    }>;
}> {
    if (params.envelopeKind === 'subagent_launch.v1') {
        const resolved = resolveSubagentLaunchStructuredSend(params.payload);
        return {
            text: resolved.text,
            displayText: resolved.displayText,
            metaOverrides: resolved.messageMeta,
        };
    }

    const payload = SubagentCommandV1Schema.parse(params.payload);
    const displayText = describeCommand(payload);

    return {
        text: displayText,
        displayText,
        metaOverrides: {
            happier: {
                kind: params.envelopeKind,
                payload,
            },
        },
    };
}
