import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

const SESSION_SUBAGENT_KIND_LABEL_KEYS = {
    execution_run: 'session.subagents.kind.execution_run',
    agent_team_member: 'session.subagents.kind.agent_team_member',
    subagent_sidechain: 'session.subagents.kind.subagent_sidechain',
} as const satisfies Record<SessionSubagent['kind'], string>;

export function resolveSessionSubagentKindLabelKey(
    kind: SessionSubagent['kind'],
): (typeof SESSION_SUBAGENT_KIND_LABEL_KEYS)[SessionSubagent['kind']] {
    return SESSION_SUBAGENT_KIND_LABEL_KEYS[kind];
}
